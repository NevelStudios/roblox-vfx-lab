import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  assetUri,
  buildModule,
  cellUniforms,
  checkName,
  clipPhases,
  coerceValue,
  gridLayout,
  mapMessages,
  parseParams,
  propertiesLuau,
  resolveValues,
  textureProperties,
} from "../src/core.js";

const NODE = `// @param glow f32 0..4 = 1.5 core brightness
// @param tint color = #ff8000
fn effect(uv: vec2f) -> vec4f {
  return vec4f(params.tint, length(uv - 0.5) * params.glow);
}
`;

test("parseParams reads types, ranges, defaults and descriptions", () => {
  const { params, problems } = parseParams(`// @param glow f32 0..4 = 1.5 core brightness
// @param tilt vec2f = 0.2, -0.1
// @param tint color = #ff8000
// @param size f32 0.5..2
//@param spin f32`);
  assert.deepEqual(problems, []);
  assert.deepEqual(params.map(({ name, type, min, max, default: d, description }) => [name, type, min, max, d, description]), [
    ["glow", "f32", 0, 4, [1.5], "core brightness"],
    ["tilt", "vec2f", undefined, undefined, [0.2, -0.1], ""],
    ["tint", "color", undefined, undefined, [1, 0.502, 0], ""],
    ["size", "f32", 0.5, 2, [0.5], ""],
    ["spin", "f32", undefined, undefined, [0], ""],
  ]);
});

test("parseParams reports bad annotations with their lines", () => {
  const { problems } = parseParams(`// @param glow f32 4..1
// @param glow2 f32 0..1 = 3
// @param v vec2f 0..1
// @param a f32
// @param a f32
// @param x mat4
// @param t vec3f = 1, 2`);
  assert.deepEqual(problems.map((p) => p.line), [1, 2, 3, 5, 6, 7]);
  assert.match(problems[0].message, /min must be below/);
  assert.match(problems[1].message, /outside 0..1/);
  assert.match(problems[2].message, /only f32 takes a range/);
  assert.match(problems[3].message, /declared twice/);
  assert.match(problems[5].message, /needs 3 numbers/);
  const many = Array.from({ length: 16 }, (_, i) => `// @param p${i} f32`).join("\n");
  assert.match(parseParams(many).problems[0].message, /at most 15/);
});

test("resolveValues overrides defaults and rejects unknown names and bad sizes", () => {
  const { params } = parseParams(NODE);
  assert.deepEqual(resolveValues(params, { glow: 3 }), { glow: [3], tint: [1, 0.502, 0] });
  assert.deepEqual(resolveValues(params, { tint: [0, 1, 0] }).tint, [0, 1, 0]);
  assert.throws(() => resolveValues(params, { glw: 1 }), /unknown parameter glw; the node has: glow, tint/);
  assert.throws(() => resolveValues(params, { tint: 2 }), /tint \(color\) needs 3 numbers/);
  assert.throws(() => coerceValue({ name: "g", type: "f32" }, "#ffffff"), /needs 1 number/);
});

test("buildModule puts the node after its prelude and maps compiler lines back", () => {
  const { params } = parseParams(NODE);
  const { code, lineOffset } = buildModule(NODE.replaceAll("\n", "\r\n"), params);
  const lines = code.split("\n");
  assert.equal(lines[lineOffset], "// @param glow f32 0..4 = 1.5 core brightness");
  assert.equal(lines[lineOffset + 2], "fn effect(uv: vec2f) -> vec4f {");
  assert.ok(!code.includes("\r"));
  assert.match(code, /_vfx: vec4f,\n {2}@align\(16\) @size\(16\) glow: f32,\n {2}@align\(16\) @size\(16\) tint: vec3f,\n}/);
  assert.match(code, /@fragment fn vfx_fs/);
  assert.deepEqual(
    mapMessages([{ type: "error", line: lineOffset + 4, column: 3, message: "bad" }, { type: "error", line: 2, column: 1, message: "x" }], lineOffset, 5),
    [{ type: "error", line: 4, column: 3, message: "bad" }, { type: "error", line: 0, column: 0, message: "(engine code) x" }],
  );
});

test("gridLayout reads left to right, top to bottom, with the margin in whole pixels", () => {
  const layout = gridLayout({ count: 5, grid: 3, cell: 100, margin: 0.02 });
  assert.equal(layout.pad, 2);
  assert.deepEqual([layout.width, layout.height], [300, 200]);
  assert.deepEqual(layout.rects.map((r) => r.slice(0, 2)), [[0, 0], [100, 0], [200, 0], [0, 100], [100, 100]]);
  assert.equal(gridLayout({ count: 1, grid: 1, cell: 64, margin: 0 }).pad, 0);
  assert.equal(gridLayout({ count: 1, grid: 1, cell: 64, margin: 0.001 }).pad, 1);
  assert.throws(() => gridLayout({ count: 1, grid: 1, cell: 12, margin: 0.25 }), /render larger/);
});

test("clipPhases ends OneShots on phase 1 and keeps it out of loops", () => {
  assert.deepEqual(clipPhases(4, "oneshot"), [0, 1 / 3, 2 / 3, 1]);
  assert.deepEqual(clipPhases(4, "loop"), [0, 0.25, 0.5, 0.75]);
  assert.deepEqual(clipPhases(1, "oneshot"), [0]);
});

test("cellUniforms matches the VfxFrame and VfxParams layout", () => {
  const { params } = parseParams(NODE);
  const u = cellUniforms({ rect: [256, 0, 256, 256], pad: 5, ss: 4, phase: 0.5, duration: 2, frame: 1, frames: 16, params, values: resolveValues(params, { glow: 3 }) });
  assert.equal(u.length, 128);
  assert.deepEqual(Array.from(u.slice(0, 12)), [256, 0, 256, 5, 1, 0.5, 1, 16, 4, Math.fround(1 / 246), 2, 0]);
  assert.equal(u[68], 3); // params.glow at byte 256 + 16
  assert.deepEqual(Array.from(u.slice(72, 75)).map((v) => Math.round(v * 1000) / 1000), [1, 0.502, 0]);
});

test("textureProperties sets flipbooks on emitters only", () => {
  const sheet = { grid: 4, mode: "loop", frames: 16, duration: 0.5 };
  assert.deepEqual(textureProperties("ParticleEmitter", sheet, "rbxassetid://1"), {
    Texture: "rbxassetid://1",
    FlipbookLayout: "Grid4x4",
    FlipbookMode: "Loop",
    FlipbookFramerate: [30, 30],
  });
  assert.deepEqual(textureProperties("ParticleEmitter", { ...sheet, mode: "oneshot" }, "u"), { Texture: "u", FlipbookLayout: "Grid4x4", FlipbookMode: "OneShot" });
  assert.deepEqual(textureProperties("ParticleEmitter", null, "u"), { Texture: "u", FlipbookLayout: "None" });
  assert.deepEqual(textureProperties("MeshPart", { grid: 1 }, "u"), { TextureID: "u" });
  assert.deepEqual(textureProperties("Beam", null, "u"), { Texture: "u" });
  assert.throws(() => textureProperties("Beam", sheet, "u"), /only a ParticleEmitter/);
  assert.throws(() => textureProperties("Part", null, "u"), /cannot put a texture on a Part/);
  assert.equal(assetUri(123), "rbxassetid://123");
  assert.equal(assetUri("rbxassetid://9"), "rbxassetid://9");
  assert.equal(assetUri("rbxasset://textures/particles/sparkles_main.dds"), "rbxasset://textures/particles/sparkles_main.dds");
  assert.throws(() => assetUri("http://x"), /asset id/);
});

test("names cannot leave the library", () => {
  assert.equal(checkName("ring/shock", "shader"), "ring/shock");
  for (const bad of ["../x", "a/../../b", "C:/x", "a b", ""]) assert.throws(() => checkName(bad, "shader"), /must look like/);
});

test("core imports nothing from node", () => {
  assert.doesNotMatch(fs.readFileSync(new URL("../src/core.js", import.meta.url), "utf8"), /from "node:/);
});

test("propertiesLuau writes the Roblox properties as Luau for one instance", () => {
  const props = { Texture: "rbxassetid://7", FlipbookLayout: "Grid4x4", FlipbookMode: "Loop", FlipbookFramerate: [16, 16] };
  assert.equal(
    propertiesLuau(props),
    [
      'emitter.Texture = "rbxassetid://7"',
      "emitter.FlipbookLayout = Enum.ParticleFlipbookLayout.Grid4x4",
      "emitter.FlipbookMode = Enum.ParticleFlipbookMode.Loop",
      "emitter.FlipbookFramerate = NumberRange.new(16, 16)",
    ].join("\n"),
  );
  assert.equal(propertiesLuau({ Texture: "rbxassetid://7" }, "beam"), 'beam.Texture = "rbxassetid://7"');
});
