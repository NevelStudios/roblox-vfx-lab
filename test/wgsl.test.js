import { test } from "node:test";
import assert from "node:assert/strict";
import { completions, highlightWgsl } from "../src/wgsl.js";

const SOURCE = `// Ring <test>
// @param glow f32 0..4 = 1.5 core
fn effect(uv: vec2f) -> vec4f {
  let p = vfx_center(uv);
  let d = vfx_ring(p, 0.5, 0.1);
  return vec4f(vec3f(1.0), vfx_fill(d, vfx.px) * params.glow);
}
`;
const at = (text, marker = "|") => ({ source: text.replace(marker, ""), caret: text.indexOf(marker) });

test("highlightWgsl marks every token kind and escapes HTML", () => {
  const html = highlightWgsl(SOURCE);
  assert.match(html, /<span class="c">\/\/ Ring &lt;test&gt;<\/span>/);
  assert.match(html, /<span class="a">@param glow f32<\/span>/);
  assert.match(html, /<span class="k">fn<\/span> effect/);
  assert.match(html, /<span class="t">vec2f<\/span>/);
  assert.match(html, /<span class="h">vfx_ring<\/span>/);
  assert.match(html, /<span class="n">0\.5<\/span>/);
  assert.match(html, /vfx\.<span class="p">px<\/span>/);
  assert.match(html, /params\.<span class="p">glow<\/span>/);
  // The text is the source, character for character, once the tags are gone.
  assert.equal(html.replace(/<[^>]+>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"), SOURCE);
});

test("completions offer helpers with their signatures, WGSL builtins and locals", () => {
  const { source, caret } = at("fn effect(uv: vec2f) -> vec4f {\n  let dist = 1.0;\n  let a = vfx_ri|\n");
  const answer = completions(source, caret);
  assert.equal(answer.from, caret - "vfx_ri".length);
  assert.deepEqual(answer.items.map((i) => i.label), ["vfx_ring"]);
  assert.equal(answer.items[0].detail, "(p: vec2f, r: f32, width: f32) -> f32");
  assert.ok(completions(...Object.values(at("  let b = smo|"))).items.some((i) => i.label === "smoothstep"));
  assert.ok(completions(...Object.values(at("  let dist = 1.0;\n  let b = di|"))).items.some((i) => i.label === "dist" && i.kind === "local"));
});

test("completions after params. and vfx. offer the node's parameters and the frame uniforms", () => {
  const params = at("// @param glow f32 0..4 = 1\n// @param tint color = #fff\nfn effect(uv: vec2f) -> vec4f { return vec4f(params.|");
  assert.deepEqual(completions(params.source, params.caret).items.map((i) => i.label), ["glow", "tint"]);
  const frame = at("fn effect(uv: vec2f) -> vec4f { let t = vfx.ph|");
  assert.deepEqual(completions(frame.source, frame.caret).items.map((i) => i.label), ["phase"]);
});

test("completions stay quiet in comments and on an empty word unless asked", () => {
  assert.equal(completions(...Object.values(at("// vfx_ri|"))), null);
  assert.equal(completions(...Object.values(at("  let a = |"))), null);
  assert.ok(completions(...Object.values(at("  let a = |")), { force: true }).items.length > 40);
});
