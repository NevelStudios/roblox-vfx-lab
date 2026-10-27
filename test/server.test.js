import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VFX_TOOLS } from "../src/lab.js";
import { VIEWER_TOOLS, createLibrary, postRequest, route, startViewer, stopViewer } from "../src/server.js";
import { fakeStudio } from "./fake-studio.js";

const NODE = "// @param glow f32 0..4 = 1\nfn effect(uv: vec2f) -> vec4f { return vec4f(1.0); }\n";
const gpu = { compile: async () => [], render: async ({ width, height }) => new Uint8Array(width * height * 4).fill(200) };
const PNG = Buffer.from([137, 80, 78, 71]);
const SHA = crypto.createHash("sha256").update(PNG).digest("hex");
const PAGE = { host: "127.0.0.1:4518", origin: "http://127.0.0.1:4518", "content-type": "application/json" };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vfx lab ü-"));
  fs.mkdirSync(path.join(root, "shaders", "fx"), { recursive: true });
  fs.mkdirSync(path.join(root, "bakes", "fx"), { recursive: true });
  fs.writeFileSync(path.join(root, "shaders", "fx", "ring.wgsl"), NODE);
  fs.writeFileSync(path.join(root, "bakes", "fx", "ring.png"), PNG);
  const recipe = { node: "fx/ring", grid: 4, frames: 16, mode: "loop", duration: 1, size: 1024, pngSha: "abc", warnings: ["w"], uploads: [{ assetId: 9, pngSha: "abc" }] };
  fs.writeFileSync(path.join(root, "bakes", "fx", "ring.json"), JSON.stringify(recipe));
  return root;
}
// A site, src and examples tree for the static routes.
function files() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vfx-site-"));
  const dirs = { site: path.join(base, "site"), src: path.join(base, "src"), examples: path.join(base, "examples") };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dirs.site, "index.html"), "<title>Roblox VFX Lab</title>");
  fs.writeFileSync(path.join(dirs.site, "app.js"), "export {};");
  for (const file of ["core.js", "pixels.js", "bake.js", "lab.js"]) fs.writeFileSync(path.join(dirs.src, file), `// ${file}`);
  fs.mkdirSync(path.join(dirs.examples, "impact"));
  fs.writeFileSync(path.join(dirs.examples, "index.json"), "[]");
  fs.writeFileSync(path.join(dirs.examples, "impact", "ring.wgsl"), NODE);
  fs.writeFileSync(path.join(base, "package.json"), "{}");
  return dirs;
}
const body = (answer) => JSON.parse(answer.body);
const post = (root, url, payload, { headers = PAGE, studio = fakeStudio() } = {}) =>
  postRequest(createLibrary(root), { gpu, studio }, url, headers, payload === null ? null : JSON.stringify(payload));

test("the library lists nodes with hashes and bakes with what the player needs", () => {
  const library = createLibrary(fixture());
  const listing = body(route(library, "GET", "/api/library"));
  assert.deepEqual(listing.nodes.map((n) => [n.name, n.readOnly]), [["fx/ring", false]]);
  assert.match(listing.nodes[0].hash, /^[0-9a-f]{12}$/);
  assert.deepEqual(listing.bakes, [{ name: "fx/ring", node: "fx/ring", grid: 4, frames: 16, mode: "loop", duration: 1, size: 1024, pngSha: "abc", warnings: 1, assetId: 9 }]);
  assert.equal(body(route(library, "GET", "/api/node?name=fx/ring")).source, NODE);
  assert.equal(body(route(library, "GET", "/api/bake?name=fx/ring")).node, "fx/ring");
});

test("routes refuse writes, bad names and unknown paths, and serve the sheet with an ETag", () => {
  const library = createLibrary(fixture());
  assert.equal(route(library, "POST", "/api/library").status, 405);
  assert.equal(route(library, "GET", "/api/node?name=../x").status, 400);
  assert.equal(route(library, "GET", "/api/node?name=fx/none").status, 404);
  assert.equal(route(library, "GET", "/nope").status, 404);
  const png = route(library, "GET", "/api/bake.png?name=fx/ring");
  assert.deepEqual([png.status, png.type, png.headers.etag], [200, "image/png", '"abc"']);
  assert.equal(route(library, "GET", "/api/bake.png?name=fx/ring", { "if-none-match": '"abc"' }).status, 304);
});

test("static routes serve the page, the three lib modules and examples, and refuse paths outside them", () => {
  const library = createLibrary(fixture());
  const dirs = files();
  const get = (url) => route(library, "GET", url, {}, dirs);
  assert.match(get("/").body.toString(), /<title>Roblox VFX Lab<\/title>/);
  assert.deepEqual([get("/app.js").status, get("/app.js").type], [200, "text/javascript; charset=utf-8"]);
  for (const file of ["core.js", "pixels.js", "bake.js"]) assert.equal(get(`/lib/${file}`).status, 200, file);
  assert.equal(get("/lib/lab.js").status, 404);
  assert.equal(get("/examples/index.json").status, 200);
  assert.equal(get("/examples/impact/ring.wgsl").body.toString(), NODE);
  for (const bad of ["/examples/../package.json", "/examples/..%2Fpackage.json", "/..%2Fpackage.json", "/lib/../package.json"]) assert.equal(get(bad).status, 404, bad);
});

test("a change to a file drops only what it fed and names what to push", () => {
  const root = fixture();
  const library = createLibrary(root);
  const before = route(library, "GET", "/api/library");
  fs.writeFileSync(path.join(root, "shaders", "fx", "ring.wgsl"), `${NODE}// edited\n`);
  assert.equal(body(route(library, "GET", "/api/library")).nodes[0].hash, body(before).nodes[0].hash, "cached until told");
  assert.deepEqual(library.invalidate(path.join("shaders", "fx", "ring.wgsl")), { kind: "node", name: "fx/ring" });
  assert.notEqual(body(route(library, "GET", "/api/library")).nodes[0].hash, body(before).nodes[0].hash);
  assert.deepEqual(library.invalidate("bakes/fx/ring.png"), { kind: "bake", name: "fx/ring" });
  assert.deepEqual(library.invalidate("shaders"), { kind: "library" });
  assert.equal(library.invalidate("notes.txt"), null);
});

test("a bake request from the page bakes the node and keeps its uploads", async () => {
  const root = fixture();
  const answer = await post(root, "/api/bake", { name: "fx/ring", grid: 2, size: 256, mode: "loop", values: { glow: 2 } });
  assert.equal(answer.status, 200, answer.body);
  const { name, recipe, bytes } = body(answer);
  assert.equal(name, "fx/ring");
  assert.deepEqual([recipe.grid, recipe.frames, recipe.mode, recipe.values.glow], [2, 4, "loop", [2]]);
  assert.deepEqual(recipe.uploads, [{ assetId: 9, pngSha: "abc" }]);
  assert.equal(fs.statSync(path.join(root, "bakes", "fx", "ring.png")).size, bytes);
});

test("every POST from another origin, or a malformed one, is refused before any work", async () => {
  const root = fixture();
  const before = fs.readFileSync(path.join(root, "bakes", "fx", "ring.json"), "utf8");
  const studio = fakeStudio();
  for (const url of ["/api/bake", "/api/node", "/api/export"]) {
    const good = { name: "fx/ring", source: NODE, bake: "fx/ring" };
    assert.equal((await post(root, url, good, { headers: { ...PAGE, origin: "https://evil.example" }, studio })).status, 403, url);
    assert.equal((await post(root, url, good, { headers: { ...PAGE, host: "evil.example:4518", origin: "http://evil.example:4518" }, studio })).status, 403, url);
    assert.equal((await post(root, url, good, { headers: { ...PAGE, "content-type": "text/plain" }, studio })).status, 415, url);
    assert.equal((await post(root, url, null, { studio })).status, 413, url);
    assert.equal((await postRequest(createLibrary(root), { gpu, studio }, url, PAGE, "{")).status, 400, url);
    assert.equal((await post(root, url, [], { studio })).status, 400, url);
  }
  assert.equal((await post(root, "/api/nope", {})).status, 404);
  assert.match(body(await post(root, "/api/bake", { name: "fx/ring", grid: 3 })).error, /grid must be one of/);
  assert.equal(fs.readFileSync(path.join(root, "bakes", "fx", "ring.json"), "utf8"), before);
  assert.equal(fs.readFileSync(path.join(root, "shaders", "fx", "ring.wgsl"), "utf8"), NODE);
  assert.equal(studio.calls.length, 0);
});

test("POST /api/node saves with the stale rule and reports problems at node lines", async () => {
  const root = fixture();
  const created = await post(root, "/api/node", { name: "fx/new", source: NODE });
  assert.equal(created.status, 200, created.body);
  assert.deepEqual([body(created).name, body(created).state], ["fx/new", "clean"]);
  assert.equal(fs.readFileSync(path.join(root, "shaders", "fx", "new.wgsl"), "utf8"), NODE);
  const stale = await post(root, "/api/node", { name: "fx/new", source: `${NODE}// 2\n` });
  assert.equal(stale.status, 409);
  assert.match(body(stale).error, new RegExp(`stale: fx/new exists with hash ${body(created).hash}`));
  const broken = await postRequest(createLibrary(root), { gpu: { ...gpu, compile: async () => [{ type: "error", line: 9999, column: 3, message: "nope" }] } }, "/api/node", PAGE, JSON.stringify({ name: "fx/new", source: "x", replaces: body(created).hash }));
  assert.equal(broken.status, 200);
  assert.equal(body(broken).state, "problems");
  assert.equal(fs.readFileSync(path.join(root, "shaders", "fx", "new.wgsl"), "utf8"), "x");
  assert.equal((await post(root, "/api/node", { name: "../x", source: NODE })).status, 400);
});

test("POST /api/export applies to selected emitters, else creates one on the selected part", async () => {
  const root = fixture();
  const recipe = JSON.parse(fs.readFileSync(path.join(root, "bakes", "fx", "ring.json"), "utf8"));
  fs.writeFileSync(path.join(root, "bakes", "fx", "ring.json"), JSON.stringify({ ...recipe, pngSha: SHA, uploads: [{ assetId: 9, pngSha: SHA }] }));
  const selection = (answer) =>
    fakeStudio({
      luau: (op, payload) => {
        if (op === "vfx_selection") return answer;
        if (op === "get_properties") return payload.paths.map((p) => ({ path: p, className: "ParticleEmitter" }));
        if (op === "create_instances") return { created: ["Workspace.Part.ring"] };
        return {};
      },
    });
  const onEmitter = selection({ targets: [{ path: ["Workspace", "Part", "Fire"], className: "ParticleEmitter" }], parent: null });
  const applied = await post(root, "/api/export", { bake: "fx/ring" }, { studio: onEmitter });
  assert.equal(applied.status, 200, applied.body);
  assert.deepEqual([body(applied).assetId, body(applied).reused], [9, true]); // the recipe's recorded upload
  assert.deepEqual(body(applied).applied[0].properties, { Texture: "rbxassetid://9", FlipbookLayout: "Grid4x4", FlipbookMode: "Loop", FlipbookFramerate: [16, 16] });
  assert.equal(onEmitter.uploads.length, 0);

  const onPart = selection({ targets: [], parent: ["Workspace", "Part"] });
  const created = await post(root, "/api/export", { bake: "fx/ring" }, { studio: onPart });
  assert.deepEqual(body(created).created, ["Workspace.Part.ring"]);
  assert.deepEqual(onPart.ops.find(([op]) => op === "create_instances")[1].items[0].parent, ["Workspace", "Part"]);

  const nothing = await post(root, "/api/export", { bake: "fx/ring" }, { studio: selection({ targets: [], parent: null }) });
  assert.equal(nothing.status, 400);
  assert.equal(body(nothing).error, "select a part, an attachment or an emitter in Studio");
});

test("POST /api/export uploads a new sheet once before it applies", async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, "bakes", "fx", "ring.json"), JSON.stringify({ node: "fx/ring", grid: 1, frames: 1, mode: "oneshot", duration: 1, size: 1024, pngSha: SHA, warnings: [], uploads: [] }));
  const studio = fakeStudio({ luau: (op) => (op === "vfx_selection" ? { targets: [], parent: ["Workspace", "Part"] } : { created: ["x"] }) });
  const answer = await post(root, "/api/export", { bake: "fx/ring" }, { studio });
  assert.equal(answer.status, 200, answer.body);
  assert.deepEqual([body(answer).assetId, body(answer).reused, studio.uploads.length], [987, false, 1]);
});

test("POST /api/export with two studios open answers 409 with both, and does not upload", async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, "bakes", "fx", "ring.json"), JSON.stringify({ node: "fx/ring", grid: 1, pngSha: SHA, warnings: [], uploads: [] }));
  const studio = fakeStudio({ studios: [{ id: "a", name: "Place A" }, { id: "b", name: "Place B" }] });
  const answer = await post(root, "/api/export", { bake: "fx/ring" }, { studio });
  assert.equal(answer.status, 409);
  assert.deepEqual(body(answer).studios, [{ id: "a", name: "Place A" }, { id: "b", name: "Place B" }]);
  assert.equal(studio.uploads.length, 0);
  const chosen = await post(root, "/api/export", { bake: "fx/ring", studio_id: "b" }, { studio: fakeStudio({ studios: [], luau: (op) => (op === "vfx_selection" ? { targets: [], parent: ["Workspace", "P"] } : { created: ["x"] }) }) });
  assert.equal(chosen.status, 200, chosen.body);
});

test("the server pushes a library change to an open event stream", async () => {
  const root = fixture();
  const port = 4700 + Math.floor(Math.random() * 300);
  const { url } = await startViewer({ port, library: createLibrary(root), ctx: { gpu, studio: fakeStudio() } });
  try {
    const baked = await fetch(`${url}api/bake`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "fx/ring", grid: 1, size: 256 }) });
    assert.equal(baked.status, 200);
    assert.equal((await baked.json()).recipe.flipbookLayout, "None");
    const response = await fetch(`${url}api/events`);
    const reader = response.body.getReader();
    await reader.read(); // the retry line
    fs.writeFileSync(path.join(root, "shaders", "fx", "spark.wgsl"), NODE);
    let text = "";
    while (!text.includes("event: change")) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /"kind":"node","name":"fx\/spark"/);
    await reader.cancel();
    assert.deepEqual((await (await fetch(`${url}api/library`)).json()).nodes.map((n) => n.name), ["fx/ring", "fx/spark"]);
  } finally {
    stopViewer();
  }
});

test("POST /api/delete removes a node or a bake with its recipe, and nothing else", async () => {
  const root = fixture();
  const gone = await post(root, "/api/delete", { kind: "bake", name: "fx/ring" });
  assert.equal(gone.status, 200);
  assert.deepEqual(body(gone).deleted, ["bakes/fx/ring.png", "bakes/fx/ring.json"]);
  assert.ok(fs.existsSync(path.join(root, "shaders", "fx", "ring.wgsl")));
  assert.equal((await post(root, "/api/delete", { kind: "node", name: "fx/ring" })).status, 200);
  assert.ok(!fs.existsSync(path.join(root, "shaders", "fx", "ring.wgsl")));
  assert.equal((await post(root, "/api/delete", { kind: "node", name: "fx/ring" })).status, 400);
  assert.equal((await post(root, "/api/delete", { kind: "node", name: "../ring" })).status, 400);
  assert.equal((await post(root, "/api/delete", { kind: "file", name: "fx/ring" })).status, 400);
  assert.equal((await post(root, "/api/delete", { kind: "bake", name: "fx/ring" }, { headers: { ...PAGE, origin: "https://evil.example" } })).status, 403);
});

test("the MCP has 12 tools with vfx_delete and vfx_viewer", () => {
  assert.deepEqual([...VFX_TOOLS, ...VIEWER_TOOLS].map((t) => t.name), [
    "vfx_guide", "vfx_shader_list", "vfx_shader_read", "vfx_shader_write", "vfx_shader_edit", "vfx_render", "vfx_bake", "vfx_upload", "vfx_apply", "vfx_preview", "vfx_delete", "vfx_viewer",
  ]);
});
