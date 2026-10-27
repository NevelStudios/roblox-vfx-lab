// The editor's language support, browser-safe: WGSL syntax highlighting and completions. The vfx_ helpers come from
// the prelude every node is built with (core.js HELPERS), so the list never drifts from what a node can call.
import { HELPERS } from "./core.js";

const KEYWORDS = "fn let var const return if else for while loop break continue continuing switch case default struct discard true false override alias".split(" ");
const TYPES = "f32 i32 u32 f16 bool vec2f vec3f vec4f vec2i vec3i vec4i vec2u vec3u vec4u vec2 vec3 vec4 mat2x2f mat3x3f mat4x4f array".split(" ");
const BUILTINS = {
  abs: "(x)", acos: "(x)", asin: "(x)", atan: "(x)", atan2: "(y, x)", ceil: "(x)", clamp: "(x, low, high)", cos: "(x)",
  cosh: "(x)", cross: "(a, b)", degrees: "(x)", distance: "(a, b)", dot: "(a, b)", exp: "(x)", exp2: "(x)", floor: "(x)",
  fma: "(a, b, c)", fract: "(x)", inverseSqrt: "(x)", length: "(v)", log: "(x)", log2: "(x)", max: "(a, b)", min: "(a, b)",
  mix: "(a, b, t)", normalize: "(v)", pow: "(x, y)", radians: "(x)", reflect: "(i, n)", round: "(x)", saturate: "(x)",
  select: "(f, t, cond)", sign: "(x)", sin: "(x)", sinh: "(x)", smoothstep: "(low, high, x)", sqrt: "(x)", step: "(edge, x)",
  tan: "(x)", tanh: "(x)", trunc: "(x)",
};
// The frame uniforms a node reads (the guide's list; the struct's layout fields stay out).
const FRAME = { phase: "0..1 across the clip", time: "seconds into the clip", duration: "clip length in seconds", frame: "this frame's index", frames: "frame count", px: "one output pixel in uv units" };

const HELPER_LIST = [
  ...[...HELPERS.matchAll(/const (VFX_\w+): f32 = ([\d.]+)/g)].map(([, label, value]) => ({ label, detail: `= ${value}`, kind: "helper" })),
  ...[...HELPERS.matchAll(/fn (vfx_\w+)\(([^)]*)\)\s*->\s*(\w+)/g)].map(([, label, args, out]) => ({ label, detail: `(${args}) -> ${out}`, kind: "helper" })),
];
const HELPER_NAMES = new Set(HELPER_LIST.map((h) => h.label));
const STATIC = [
  ...HELPER_LIST,
  ...Object.entries(BUILTINS).map(([label, detail]) => ({ label, detail, kind: "builtin" })),
  ...TYPES.map((label) => ({ label, detail: "type", kind: "type" })),
  ...KEYWORDS.map((label) => ({ label, detail: "keyword", kind: "keyword" })),
];

const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const span = (cls, text) => `<span class="${cls}">${escape(text)}</span>`;

// A line comment, with the @param annotation in it set apart.
function comment(text) {
  const match = /^(.*?)(@param\s+\w+\s+\w+)(.*)$/.exec(text);
  return match ? span("c", match[1]) + span("a", match[2]) + span("c", match[3]) : span("c", text);
}

const TOKEN = /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|(\d+\.\d*(?:e[+-]?\d+)?[fh]?|\.\d+(?:e[+-]?\d+)?[fh]?|\d+(?:e[+-]?\d+)?[fhiu]?)|([A-Za-z_]\w*)|([\s\S])/g;

// Source -> HTML: every character of the source once, in order, inside spans by kind.
export function highlightWgsl(source) {
  let out = "";
  let previous = ""; // the identifier before a ".", for params.x and vfx.x
  let dot = false;
  for (const [, line, block, number, word, other] of source.matchAll(TOKEN)) {
    if (line) out += comment(line);
    else if (block) out += span("c", block);
    else if (number) out += span("n", number);
    else if (word) {
      if (dot && (previous === "params" || previous === "vfx")) out += span("p", word);
      else if (KEYWORDS.includes(word)) out += span("k", word);
      else if (TYPES.includes(word)) out += span("t", word);
      else if (HELPER_NAMES.has(word)) out += span("h", word);
      else if (word in BUILTINS) out += span("f", word);
      else out += escape(word);
      previous = word;
      dot = false;
      continue;
    } else out += escape(other);
    dot = other === "." && dot === false && previous !== "";
    if (other !== ".") previous = "";
  }
  return out;
}

// What fits the word before the caret: { from, items: [{ label, detail, kind }] }, or null when nothing should show.
// After "params." it lists the node's @param names; after "vfx." the frame uniforms. force opens it on an empty word.
export function completions(source, caret, { force = false } = {}) {
  const before = source.slice(0, caret);
  const line = before.slice(before.lastIndexOf("\n") + 1);
  if (line.includes("//")) return null;
  const word = /[A-Za-z_]\w*$/.exec(before)?.[0] ?? "";
  if (!word && !force && !before.endsWith(".")) return null;
  const from = caret - word.length;
  const owner = /(\w+)\.\w*$/.exec(before)?.[1];
  let pool;
  if (owner === "params") pool = [...source.matchAll(/@param\s+(\w+)\s+(\w+)/g)].map(([, label, type]) => ({ label, detail: type, kind: "param" }));
  else if (owner === "vfx") pool = Object.entries(FRAME).map(([label, detail]) => ({ label, detail, kind: "uniform" }));
  else if (owner) return null;
  else {
    const locals = [...new Set([...source.matchAll(/\b(?:let|var|const)\s+([A-Za-z_]\w*)/g)].map((m) => m[1]))]
      .filter((name) => name !== word && !HELPER_NAMES.has(name))
      .map((label) => ({ label, detail: "local", kind: "local" }));
    pool = [...locals, ...STATIC];
  }
  const lower = word.toLowerCase();
  const items = pool.filter((item) => item.label.toLowerCase().startsWith(lower) && item.label !== word);
  return items.length ? { from, items } : null;
}
