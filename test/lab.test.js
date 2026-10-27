import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { bakeSheet, requireClean } from "../src/bake.js";
import { buildModule, parseParams } from "../src/core.js";
import { VFX_TOOLS, bakeNode, callTool, shaderFile, sourceHash, vfxLibrary } from "../src/lab.js";
import { NODE, fakeGpu, textOf, withLibrary } from "./fake-gpu.js";

const tool = (name) => VFX_TOOLS.find((t) => t.name === name);
const run = (name, args, ctx) => callTool(tool(name), args, ctx);

test("write, edit and read keep hashes honest and report problems in node lines", async () => {
  withLibrary();
  const ctx = { gpu: fakeGpu() };
  const written = JSON.parse(textOf(await run("vfx_shader_write", { name: "fx/ring", source: NODE }, ctx)));
  assert.equal(written.state, "clean");
  assert.deepEqual(written.params.map((p) => p.name), ["glow", "tint"]);
  const stale = await run("vfx_shader_write", { name: "fx/ring", source: NODE }, ctx);
  assert.ok(stale.isError);
  assert.match(textOf(stale), new RegExp(`stale: fx/ring exists with hash ${written.hash}`));
  const edited = JSON.parse(textOf(await run("vfx_shader_edit", { name: "fx/ring", edits: [{ old: "= 1.5", new: "= 2" }] }, ctx)));
  assert.notEqual(edited.hash, written.hash);
  assert.deepEqual(edited.params[0].default, [2]);
  assert.match(textOf(await run("vfx_shader_edit", { name: "fx/ring", edits: [{ old: "params", new: "p" }] }, ctx)), /edit 0: old occurs 2 times \(set all: true/);
  const read = JSON.parse(textOf(await run("vfx_shader_read", { name: "fx/ring" }, ctx)));
  assert.equal(read.hash, edited.hash);
  assert.ok(read.source.includes("= 2 core"));
  const noEffect = JSON.parse(textOf(await run("vfx_shader_write", { name: "fx/empty", source: "// @param a f32\n" }, ctx)));
  assert.equal(noEffect.state, "problems");
  assert.match(noEffect.problems[0].message, /must define fn effect/);
  const lineOffset = buildModule(NODE, parseParams(NODE).params).lineOffset;
  const bad = JSON.parse(textOf(await run("vfx_shader_write", { name: "fx/bad", source: NODE }, { gpu: fakeGpu([{ type: "error", line: lineOffset + 4, column: 10, message: "nope" }]) })));
  assert.deepEqual(bad.problems, [{ type: "error", line: 4, column: 10, message: "nope" }]);
  const list = JSON.parse(textOf(await run("vfx_shader_list", {}, ctx)));
  assert.deepEqual(list.nodes.map((n) => [n.name, n.state]), [["fx/bad", "clean"], ["fx/empty", "problems"], ["fx/ring", "clean"]]);
});

test("render shows a clip, a sweep or chosen phases and refuses broken nodes", async () => {
  withLibrary();
  const ctx = { gpu: fakeGpu() };
  await run("vfx_shader_write", { name: "fx/ring", source: NODE }, ctx);
  const clip = await run("vfx_render", { name: "fx/ring", frames: 4, size: 256 }, ctx);
  assert.equal(clip.content[0].type, "image");
  const report = JSON.parse(clip.content[1].text);
  assert.deepEqual([report.grid, report.cell], [2, 128]);
  assert.deepEqual(report.cells.map((c) => c.phase), [0, 0.3333, 0.6667, 1]);
  assert.ok(report.cells[3].coverage > report.cells[0].coverage);
  const sweep = JSON.parse((await run("vfx_render", { name: "fx/ring", sweep: { param: "glow", count: 3 }, size: 192 }, ctx)).content[1].text);
  assert.deepEqual(sweep.cells.map((c) => c.glow), [0, 2, 4]);
  assert.deepEqual(sweep.warnings, []);
  assert.match(textOf(await run("vfx_render", { name: "fx/ring", sweep: { param: "tint" } }, ctx)), /f32 parameter; the node has: glow/);
  assert.match(textOf(await run("vfx_render", { name: "fx/ring", phases: [0.5], sweep: { param: "glow" } }, ctx)), /not both/);
  fs.writeFileSync(shaderFile("fx/broken"), "// @param a f32 3..1\nfn effect(uv: vec2f) -> vec4f { return vec4f(1.0); }\n");
  assert.match(textOf(await run("vfx_render", { name: "fx/broken" }, ctx)), /fx\/broken has problems: 1:1/);
});

test("bake writes the sheet and the recipe in a library path with a space and a non-ASCII letter", async () => {
  const library = withLibrary();
  const ctx = { gpu: fakeGpu() };
  await run("vfx_shader_write", { name: "fx/ring", source: NODE }, ctx);
  const summary = JSON.parse((await run("vfx_bake", { name: "fx/ring", grid: 2, size: 256, mode: "loop", duration: 0.1 }, ctx)).content[1].text);
  assert.equal(summary.png, path.join(library, "bakes", "fx", "ring.png"));
  assert.equal(summary.flipbookLayout, "Grid2x2");
  const png = fs.readFileSync(summary.png);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [256, 256]);
  const recipe = JSON.parse(fs.readFileSync(summary.recipe, "utf8"));
  assert.deepEqual([recipe.node, recipe.frames, recipe.mode, recipe.values.glow, recipe.uploads], ["fx/ring", 4, "loop", [1.5], []]);
  assert.equal(recipe.nodeHash, sourceHash(NODE));
});

test("bake tiles a still into tiles x tiles PNGs, checked whole", async () => {
  const library = withLibrary();
  const ctx = { gpu: fakeGpu() };
  await run("vfx_shader_write", { name: "fx/ring", source: NODE }, ctx);
  const summary = JSON.parse((await run("vfx_bake", { name: "fx/ring", grid: 1, size: 256, tiles: 2 }, ctx)).content[1].text);
  assert.deepEqual(summary.tiles.map((t) => [t.bake, t.row, t.col]), [["fx/ring-1-1", 1, 1], ["fx/ring-1-2", 1, 2], ["fx/ring-2-1", 2, 1], ["fx/ring-2-2", 2, 2]]);
  assert.deepEqual([summary.size, summary.tile, summary.warnings.filter((w) => /edge/.test(w))], [512, 256, []]);
  const alpha = (bake, x, y) => {
    const png = fs.readFileSync(path.join(library, "bakes", `${bake}.png`));
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [256, 256]);
    const rows = zlib.inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
    return rows[y * (1 + 256 * 4) + 1 + x * 4 + 3];
  };
  assert.deepEqual([alpha("fx/ring-1-1", 255, 255), alpha("fx/ring-1-1", 0, 0)], [204, 0]);
  assert.deepEqual([alpha("fx/ring-2-2", 0, 0), alpha("fx/ring-2-2", 255, 255)], [204, 0]);
  assert.deepEqual([alpha("fx/ring-1-2", 0, 255), alpha("fx/ring-2-1", 255, 0)], [204, 204]);
  const recipe = JSON.parse(fs.readFileSync(path.join(library, "bakes", "fx", "ring-2-1.json"), "utf8"));
  assert.deepEqual([recipe.tile, recipe.size, recipe.grid], [{ row: 2, col: 1, of: 2 }, 256, 1]);
  assert.match(textOf(await run("vfx_bake", { name: "fx/ring", grid: 2, tiles: 2 }, ctx)), /tiles splits a still/);
});

test("bakeSheet in bake.js gives the same pixels and warnings as bakeNode writes", async () => {
  withLibrary();
  const gpu = fakeGpu();
  const node = { name: "fx/ring", hash: sourceHash(NODE), ...(await requireClean("fx/ring", NODE, gpu)) };
  const sheet = await bakeSheet(node, { grid: 2, size: 256 }, gpu);
  await run("vfx_shader_write", { name: "fx/ring", source: NODE }, { gpu });
  const written = await bakeNode({ name: "fx/ring", grid: 2, size: 256 }, gpu, vfxLibrary());
  assert.deepEqual(written.rgba, sheet.rgba);
  assert.deepEqual(written.recipe.warnings, sheet.warnings);
  assert.deepEqual(Object.keys(sheet.base), ["node", "nodeHash", "values", "grid", "size", "frames", "mode", "duration", "margin", "ss", "flipbookLayout"]);
});

test("guide sections are reachable and name this lab's library", async () => {
  const index = textOf(await run("vfx_guide", {}, {}));
  assert.match(index, /^Sections: overview, node, helpers, examples, quality, roblox/);
  assert.match(index, /VFX_LAB_LIBRARY/);
  assert.doesNotMatch(index, /studio-mcp-hub|STUDIO_HUB/);
  assert.match(textOf(await run("vfx_guide", { section: "node" }, {})), /fn effect\(uv: vec2f\) -> vec4f/);
  assert.match(textOf(await run("vfx_guide", { section: "nope" }, {})), /no section nope/);
});

test("bake.js imports nothing from node", () => {
  assert.doesNotMatch(fs.readFileSync(new URL("../src/bake.js", import.meta.url), "utf8"), /from "node:/);
});

test("vfx_delete removes a node or a bake for good and says which files went", async () => {
  const library = withLibrary();
  const ctx = { gpu: fakeGpu() };
  await run("vfx_shader_write", { name: "fx/ring", source: NODE }, ctx);
  await run("vfx_bake", { name: "fx/ring", grid: 1, size: 256 }, ctx);
  const bake = JSON.parse(textOf(await run("vfx_delete", { kind: "bake", name: "fx/ring" }, ctx)));
  assert.deepEqual(bake.deleted, ["bakes/fx/ring.png", "bakes/fx/ring.json"]);
  assert.ok(fs.existsSync(shaderFile("fx/ring", library)));
  const node = JSON.parse(textOf(await run("vfx_delete", { kind: "node", name: "fx/ring" }, ctx)));
  assert.deepEqual(node.deleted, ["shaders/fx/ring.wgsl"]);
  const again = await run("vfx_delete", { kind: "node", name: "fx/ring" }, ctx);
  assert.equal(again.isError, true);
  assert.match(textOf(again), /no node fx\/ring/);
});
