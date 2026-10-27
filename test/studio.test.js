import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ToolError } from "../src/core.js";
import { VFX_TOOLS, callTool } from "../src/lab.js";
import { createStudio, listStudios, opCode, pickStudio, studioLaunch } from "../src/studio.js";
import { NODE, fakeGpu, textOf, withLibrary } from "./fake-gpu.js";
import { fakeStudio, opOf, payloadOf } from "./fake-studio.js";

const tool = (name) => VFX_TOOLS.find((t) => t.name === name);
const run = (name, args, ctx) => callTool(tool(name), args, ctx);

test("studioLaunch prefers ROBLOX_STUDIO_MCP, then the platform command, else names the variable", () => {
  assert.deepEqual(studioLaunch({ env: { ROBLOX_STUDIO_MCP: '"C:\\My Tools\\mcp.exe" --stdio' } }), { command: "C:\\My Tools\\mcp.exe", args: ["--stdio"] });
  assert.deepEqual(studioLaunch({ platform: "darwin", env: {}, exists: () => true }), { command: "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP", args: [] });
  const windows = studioLaunch({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, exists: () => true });
  assert.deepEqual(windows, { command: "cmd.exe", args: ["/c", "C:\\L\\Roblox\\mcp.bat"] });
  assert.throws(() => studioLaunch({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, exists: () => false }), /no Roblox Studio MCP found at C:\\L\\Roblox\\mcp\.bat.*ROBLOX_STUDIO_MCP/);
  assert.throws(() => studioLaunch({ platform: "linux", env: {}, exists: () => false }), (error) => error instanceof ToolError && /ROBLOX_STUDIO_MCP/.test(error.message));
});

test("a child that exits fails the pending call and the next call starts a new one", async () => {
  let connects = 0;
  const studio = createStudio({
    launch: () => ({ command: "x", args: [] }),
    async connect() {
      connects += 1;
      const first = connects === 1;
      const client = {
        onclose: undefined,
        async callTool() {
          if (first) {
            client.onclose?.(1);
            return new Promise(() => {}); // never answers: the close must fail it
          }
          return { content: [{ type: "text", text: "[]" }] };
        },
        async close() {},
      };
      return client;
    },
  });
  await assert.rejects(studio.call("list_roblox_studios", {}), (error) => error instanceof ToolError && /exited/.test(error.message) && /ROBLOX_STUDIO_MCP/.test(error.message));
  assert.deepEqual(await studio.call("list_roblox_studios", {}), { content: [{ type: "text", text: "[]" }] });
  assert.equal(connects, 2);
});

test("a launch failure is a ToolError, and the next call tries again", async () => {
  let tries = 0;
  const studio = createStudio({
    launch: () => {
      tries += 1;
      throw new ToolError("no Roblox Studio MCP found; set ROBLOX_STUDIO_MCP");
    },
  });
  await assert.rejects(studio.call("list_roblox_studios", {}), /ROBLOX_STUDIO_MCP/);
  await assert.rejects(studio.call("list_roblox_studios", {}), /ROBLOX_STUDIO_MCP/);
  assert.equal(tries, 2);
});

test("pickStudio uses the only studio, and lists them when several are open", async () => {
  assert.equal(await pickStudio({}, fakeStudio({ studios: [{ id: "a", name: "Place A" }] })), "a");
  assert.equal(await pickStudio({ studio_id: "given" }, fakeStudio()), "given");
  await assert.rejects(pickStudio({}, fakeStudio({ studios: [{ id: "a", name: "Place A" }, { id: "b", name: "Place B" }] })), (error) => {
    assert.match(error.message, /studio_id is required\. Open studios: Place A \(a\), Place B \(b\)/);
    assert.deepEqual(error.studios, [{ id: "a", name: "Place A" }, { id: "b", name: "Place B" }]);
    return true;
  });
  await assert.rejects(pickStudio({}, fakeStudio({ studios: [] })), /open a place in Roblox Studio/);
  assert.deepEqual(await listStudios(fakeStudio({ studios: [{ id: "a", name: "P" }] })), [{ id: "a", name: "P" }]);
});

test("opCode sends the ops file and the arguments as a long string, never as code", () => {
  const code = opCode("vfx_selection", { tricky: "]] .. os.exit() --[[" });
  assert.match(code, /function ops\.vfx_selection/);
  assert.equal(opOf(code), "vfx_selection");
  assert.deepEqual(payloadOf(code), { tricky: "]] .. os.exit() --[[" });
  assert.ok(!fs.readFileSync(new URL("../src/studio-ops.luau", import.meta.url), "utf8").includes("hub:"));
});

test("upload serves the PNG to upload_image once; apply sets flipbooks and checks every class first", async () => {
  withLibrary();
  const gpu = fakeGpu();
  await run("vfx_shader_write", { name: "fx/ring", source: NODE }, { gpu });
  await run("vfx_bake", { name: "fx/ring", grid: 2, size: 256, mode: "loop", duration: 0.1 }, { gpu });
  const studio = fakeStudio({
    luau: (op, payload) => (op === "get_properties" ? payload.paths.map((p, i) => ({ path: p, className: i === 0 ? "ParticleEmitter" : "Beam" })) : { op }),
  });
  const ctx = { gpu, studio };
  const first = JSON.parse(textOf(await run("vfx_upload", { bake: "fx/ring" }, ctx)));
  assert.deepEqual([first.assetId, first.reused, first.texture], [987, false, "rbxassetid://987"]);
  const again = JSON.parse(textOf(await run("vfx_upload", { bake: "fx/ring" }, ctx)));
  assert.deepEqual([again.assetId, again.reused], [987, true]);
  assert.equal(studio.uploads.length, 1);

  const applied = JSON.parse(textOf(await run("vfx_apply", { bake: "fx/ring", targets: ["Workspace.A.E"] }, ctx)));
  assert.deepEqual(applied.applied, [
    { className: "ParticleEmitter", paths: ["Workspace.A.E"], properties: { Texture: "rbxassetid://987", FlipbookLayout: "Grid2x2", FlipbookMode: "Loop", FlipbookFramerate: [30, 30] } },
  ]);
  const opsBefore = studio.ops.length;
  assert.match(textOf(await run("vfx_apply", { bake: "fx/ring", targets: ["Workspace.A.E", "Workspace.A.B"] }, ctx)), /a Beam cannot play a flipbook sheet/);
  assert.equal(studio.ops.length, opsBefore + 1); // only the class read: nothing was written
  const created = JSON.parse(textOf(await run("vfx_apply", { texture: "55", create: { parent: "Workspace.A" }, properties: { Rate: 0 } }, ctx)));
  assert.deepEqual(created.properties, { Texture: "rbxassetid://55", FlipbookLayout: "None", Rate: 0 });

  await run("vfx_bake", { name: "fx/ring", grid: 2, size: 256, values: { glow: 3 } }, { gpu });
  assert.match(textOf(await run("vfx_apply", { bake: "fx/ring", targets: ["Workspace.A.E"] }, ctx)), /not uploaded in its current version/);
});

test("preview freezes each moment, captures it and restores the TimeScales", async () => {
  const studio = fakeStudio({ luau: () => ({ emitters: 2, timeScales: [1, 0.5], focus: [0, 5, 0], camera: [3, 7, 9] }) });
  const result = await run("vfx_preview", { targets: ["Workspace.Fx"], at: [0.1, 0.4] }, { studio });
  assert.deepEqual(result.content.map((c) => c.type), ["text", "image", "text", "image"]);
  assert.deepEqual(studio.ops.map(([op, p]) => [op, p.at, p.timeScales]), [
    ["vfx_freeze", 0.1, undefined],
    ["vfx_freeze", 0.4, [1, 0.5]],
    ["vfx_restore", undefined, [1, 0.5]],
  ]);
  assert.match(textOf(await run("vfx_preview", { targets: ["Workspace.Fx"], camera_position: [0, 0, 0] }, { studio })), /both camera_position and look_at_position/);
});

test("render and bake never start Studio", async () => {
  withLibrary();
  const gpu = fakeGpu();
  const studio = createStudio({
    launch: () => {
      throw new Error("Studio must not start");
    },
  });
  const ctx = { gpu, studio };
  await run("vfx_shader_write", { name: "fx/ring", source: NODE }, ctx);
  assert.ok(!(await run("vfx_render", { name: "fx/ring", frames: 4, size: 256 }, ctx)).isError);
  assert.ok(!(await run("vfx_bake", { name: "fx/ring", grid: 2, size: 256 }, ctx)).isError);
});

test("a Studio MCP that does not start fails with the command and the help, and the next call tries again", async () => {
  let tries = 0;
  const studio = createStudio({
    launch: () => ({ command: "missing-studio-mcp", args: [] }),
    connect: async () => {
      tries += 1;
      throw new Error("MCP error -32000: Connection closed");
    },
  });
  await assert.rejects(studio.call("list_roblox_studios", {}), (error) => {
    assert.ok(error instanceof ToolError);
    assert.match(error.message, /missing-studio-mcp/);
    assert.match(error.message, /Connection closed/);
    assert.match(error.message, /ROBLOX_STUDIO_MCP/);
    return true;
  });
  await assert.rejects(studio.call("list_roblox_studios", {}), ToolError);
  assert.equal(tries, 2);
});
