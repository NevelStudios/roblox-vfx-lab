// Live check of the lab through its own MCP stream (so the GPU worker's output must not reach stdout):
//   node scripts/smoke-mcp.js [--studio] [--upload] [--npx] [--library=<dir>]
// GPU part: writes the guide's two examples into a temporary library, checks a compile error's line, renders and
// bakes, and saves the images in the library. --studio also creates Workspace.VfxSmoke with an anchored part, puts an
// emitter with a built-in texture on it (vfx_apply), previews three frozen moments (vfx_preview) and deletes the
// folder; it needs one open Studio with its MCP server on. --upload also uploads the ring sheet (public, moderated,
// permanent: one asset per new PNG) and applies it as a flipbook. --npx runs the server as artists install it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createStudio, pickStudio, runOp } from "../src/studio.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const flag = (name) => process.argv.includes(`--${name}`);
const library = process.argv.find((arg) => arg.startsWith("--library="))?.slice(10) ?? fs.mkdtempSync(path.join(os.tmpdir(), "vfx-smoke-"));
const server = flag("npx")
  ? { command: process.platform === "win32" ? "npx.cmd" : "npx", args: ["-y", "github:NevelStudios/roblox-vfx-lab"] }
  : { command: process.execPath, args: [path.join(ROOT, "src", "index.js")] };
const client = new Client({ name: "smoke-mcp", version: "0" });
await client.connect(new StdioClientTransport({ ...server, env: { ...getDefaultEnvironment(), VFX_LAB_LIBRARY: library }, stderr: "inherit" }));
assert.equal((await client.listTools()).tools.length, 12);

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  assert.ok(!result.isError, `${name}: ${text}`);
  return { ...result, text };
};
const json = (result) => JSON.parse(result.content.find((c) => c.type === "text").text);
const save = (result, file) => {
  result.content.filter((c) => c.type === "image").forEach((image, i) => fs.writeFileSync(path.join(library, `${file}-${i}.png`), Buffer.from(image.data, "base64")));
};
// A re-run on the same --library replaces its nodes, so each write names the hash it replaces.
const writeNode = async (name, source) => {
  const file = path.join(library, "shaders", `${name}.wgsl`);
  const replaces = fs.existsSync(file) ? json(await call("vfx_shader_read", { name })).hash : undefined;
  return json(await call("vfx_shader_write", { name, source, replaces }));
};

const guide = fs.readFileSync(path.join(ROOT, "src", "guide.md"), "utf8").replace(/\r\n/g, "\n");
const examples = guide.match(/```wgsl\n[\s\S]*?```/g).map((block) => block.slice(8, -3));
const ring = examples.find((e) => e.includes("breakup"));
const smoke = examples.find((e) => e.includes("vfx_loop_fbm(p * 2.5"));

const broken = await writeNode("test/broken", "fn effect(uv: vec2f) -> vec4f {\n  return 1u;\n}\n");
assert.equal(broken.state, "problems");
assert.equal(broken.problems[0].line, 2, JSON.stringify(broken.problems));
for (const [name, source] of [["test/ring", ring], ["test/smoke", smoke]]) assert.equal((await writeNode(name, source)).state, "clean");

let started = performance.now();
save(await call("vfx_render", { name: "test/ring", frames: 16, backdrop: "alpha" }), "ring-render");
console.log(`render 16 cells: ${(performance.now() - started).toFixed(0)} ms`);
save(await call("vfx_render", { name: "test/ring", sweep: { param: "breakup", count: 9 } }), "ring-sweep");
started = performance.now();
const baked = json(await call("vfx_bake", { name: "test/ring", grid: 4 }));
console.log(`bake 4x4 at 1024: ${(performance.now() - started).toFixed(0)} ms`, baked.warnings);
const loop = await call("vfx_bake", { name: "test/smoke", grid: 4, mode: "loop", duration: 2 });
assert.deepEqual(json(loop).warnings, []);
save(loop, "smoke-bake");

if (flag("studio")) {
  const studio = createStudio();
  const sid = await pickStudio({}, studio);
  const FOLDER = "Workspace.VfxSmoke";
  const destroy = () => studio.call("execute_luau", { studio_id: sid, datamodel_type: "Edit", code: 'local f = workspace:FindFirstChild("VfxSmoke") if f then f:Destroy() end return "ok"' });
  await destroy();
  await runOp(studio, sid, "create_instances", {
    items: [{ className: "Folder", parent: "Workspace", name: "VfxSmoke", children: [{ className: "Part", name: "Anchor", properties: { Anchored: true, Transparency: 1, Position: [40, 6, 0], Size: [1, 1, 1] } }] }],
  });
  try {
    const created = json(
      await call("vfx_apply", {
        studio_id: sid,
        texture: "rbxasset://textures/particles/sparkles_main.dds",
        create: { parent: `${FOLDER}.Anchor`, name: "Sparks" },
        properties: { Enabled: false, Rate: 0, Lifetime: [1, 1], Speed: [6, 6], SpreadAngle: [180, 180], Size: 1.5, LightEmission: 1 },
      }),
    );
    assert.deepEqual(created.created, [`${FOLDER}.Anchor.Sparks`]);
    const preview = await call("vfx_preview", { studio_id: sid, targets: [FOLDER], at: [0.1, 0.4, 0.8], emit: 30 });
    assert.equal(preview.content.filter((c) => c.type === "image").length, 3);
    save(preview, "studio-preview");
    const [after] = await runOp(studio, sid, "get_properties", { paths: [`${FOLDER}.Anchor.Sparks`], properties: ["TimeScale"] });
    assert.equal(after.values.TimeScale, 1);
    if (flag("upload")) {
      console.log("uploaded", json(await call("vfx_upload", { studio_id: sid, bake: "test/ring" })));
      json(await call("vfx_apply", { studio_id: sid, bake: "test/ring", targets: [`${FOLDER}.Anchor.Sparks`], properties: { LightEmission: 0, Size: 8, Speed: [0, 0] } }));
      save(await call("vfx_preview", { studio_id: sid, targets: [FOLDER], at: [0.05, 0.3, 0.6, 0.9], emit: 1 }), "studio-flipbook");
    }
  } finally {
    await destroy();
    await studio.close();
  }
}

console.log(`images in ${library}`);
await client.close();
process.exit(0);
