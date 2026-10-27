// The browser-safe core of the lab: node names, annotations, the WGSL module around a node, cell layout, uniforms and
// the Roblox properties of a texture. The MCP (Node) and the page (browser) both import it, so a page bake renders
// exactly what an MCP bake renders. No Node APIs here.
// An expected failure: its message names the cause and the next step. Everything else is a bug.
export class ToolError extends Error {}

const MAX_PARAMS = 15;
const FLOATS_PER_SLOT = 128; // 512 bytes per cell: VfxFrame at float 0, VfxParams at float 64 (byte 256)
export const PARAM_TYPES = {
  f32: { wgsl: "f32", size: 1 },
  vec2f: { wgsl: "vec2f", size: 2 },
  vec3f: { wgsl: "vec3f", size: 3 },
  vec4f: { wgsl: "vec4f", size: 4 },
  color: { wgsl: "vec3f", size: 3 },
};
const NUMBER = "-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?";
export const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

// ---------- node source ----------

// A parameter value as numbers: 1.5, [0.2, -0.1], "0.2, -0.1" or "#ffd27a" (three components only).
export function coerceValue(param, value) {
  const size = PARAM_TYPES[param.type].size;
  let list;
  if (typeof value === "number") list = [value];
  else if (Array.isArray(value)) list = value;
  else if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) && size === 3) {
    list = [1, 3, 5].map((start) => round(parseInt(value.slice(start, start + 2), 16) / 255, 4));
  } else if (typeof value === "string") list = value.split(",").map((part) => (part.trim() === "" ? NaN : Number(part)));
  if (!list || list.length !== size || !list.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new ToolError(`${param.name} (${param.type}) needs ${size} number${size > 1 ? "s" : ""}, got ${JSON.stringify(value)}`);
  }
  return list;
}

function defaultFor(param, raw) {
  if (raw !== undefined) return coerceValue(param, raw);
  if (param.type === "color") return [1, 1, 1];
  if (param.type === "f32") return [param.min ?? 0];
  return Array(PARAM_TYPES[param.type].size).fill(0);
}

// `// @param name type [min..max] [= default] [description]` lines -> { params, problems }.
export function parseParams(source) {
  const params = [];
  const problems = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const annotation = /^\s*\/\/\s*@param\b(.*)$/.exec(line);
    if (!annotation) return;
    const problem = (message) => problems.push({ type: "error", line: index + 1, column: 1, message });
    const head = /^\s+([A-Za-z][A-Za-z0-9_]*)\s+(f32|vec2f|vec3f|vec4f|color)\b\s*(.*)$/.exec(annotation[1]);
    if (!head) return problem("@param needs: name type [min..max] [= default] [description]; types f32, vec2f, vec3f, vec4f, color");
    const [, name, type] = head;
    let rest = head[3].trim();
    if (params.some((p) => p.name === name)) return problem(`@param ${name} is declared twice`);
    const param = { name, type };
    const range = new RegExp(`^(${NUMBER})\\s*\\.\\.\\s*(${NUMBER})`, "i").exec(rest);
    if (range) {
      if (type !== "f32") return problem(`@param ${name}: only f32 takes a range`);
      param.min = Number(range[1]);
      param.max = Number(range[2]);
      if (!(param.min < param.max)) return problem(`@param ${name}: the range min must be below its max`);
      rest = rest.slice(range[0].length).trim();
    }
    const def = new RegExp(`^=\\s*(#[0-9a-f]{6}|${NUMBER}(?:\\s*,\\s*${NUMBER})*)`, "i").exec(rest);
    if (def) rest = rest.slice(def[0].length).trim();
    try {
      param.default = defaultFor(param, def?.[1]);
    } catch (error) {
      return problem(`@param ${error.message}`);
    }
    if (param.min !== undefined && (param.default[0] < param.min || param.default[0] > param.max)) {
      return problem(`@param ${name}: default ${param.default[0]} is outside ${param.min}..${param.max}`);
    }
    param.description = rest;
    param.line = index + 1;
    params.push(param);
  });
  if (params.length > MAX_PARAMS) problems.push({ type: "error", line: params[MAX_PARAMS].line, column: 1, message: `at most ${MAX_PARAMS} parameters` });
  return { params, problems };
}

// The node's defaults with one call's overrides on top: { name: [numbers] }.
export function resolveValues(params, overrides = {}) {
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) throw new ToolError("values must be an object of parameter -> value");
  const unknown = Object.keys(overrides).filter((key) => !params.some((p) => p.name === key));
  if (unknown.length > 0) {
    throw new ToolError(`unknown parameter ${unknown.join(", ")}; the node has: ${params.map((p) => p.name).join(", ") || "none"}`);
  }
  return Object.fromEntries(params.map((p) => [p.name, p.name in overrides ? coerceValue(p, overrides[p.name]) : p.default]));
}

const FRAME_STRUCT = `struct VfxFrame {
  origin: vec2f,
  cell: f32,
  padding: f32,
  time: f32,
  phase: f32,
  frame: f32,
  frames: f32,
  ss: f32,
  px: f32,
  duration: f32,
  _pad: f32,
}
@group(0) @binding(0) var<uniform> vfx: VfxFrame;`;

export const HELPERS = `const VFX_PI: f32 = 3.14159265;
const VFX_TAU: f32 = 6.28318531;
fn vfx_center(uv: vec2f) -> vec2f { return uv * 2.0 - 1.0; }
fn vfx_polar(p: vec2f) -> vec2f { return vec2f(length(p), atan2(p.y, p.x)); }
fn vfx_rot(p: vec2f, a: f32) -> vec2f { let c = cos(a); let s = sin(a); return vec2f(c * p.x - s * p.y, s * p.x + c * p.y); }
fn vfx_remap(x: f32, a: f32, b: f32) -> f32 { return clamp((x - a) / (b - a), 0.0, 1.0); }
fn vfx_ease_out(t: f32) -> f32 { let u = 1.0 - clamp(t, 0.0, 1.0); return 1.0 - u * u * u; }
fn vfx_ease_in(t: f32) -> f32 { let u = clamp(t, 0.0, 1.0); return u * u * u; }
fn vfx_ease_in_out(t: f32) -> f32 { let u = clamp(t, 0.0, 1.0); return u * u * (3.0 - 2.0 * u); }
fn vfx_posterize(x: f32, steps: f32) -> f32 { return floor(x * steps + 0.5) / steps; }
fn vfx_circle(p: vec2f, r: f32) -> f32 { return length(p) - r; }
fn vfx_ring(p: vec2f, r: f32, width: f32) -> f32 { return abs(length(p) - r) - width * 0.5; }
fn vfx_segment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
fn vfx_box(p: vec2f, half: vec2f) -> f32 { let q = abs(p) - half; return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0); }
fn vfx_fill(d: f32, w: f32) -> f32 { return 1.0 - smoothstep(-w, w, d); }
fn vfx_glow(d: f32, k: f32) -> f32 { return exp(-max(d, 0.0) * k); }
fn vfx_hash31(p: vec3f) -> f32 { var q = fract(p * 0.1031); q += dot(q, q.zyx + 31.32); return fract((q.x + q.y) * q.z); }
fn vfx_hash21(p: vec2f) -> f32 { return vfx_hash31(vec3f(p, 17.13)); }
fn vfx_hash33(p: vec3f) -> vec3f {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yxx) * q.zyx);
}
fn vfx_grad(c: vec3f, f: vec3f) -> f32 { return dot(vfx_hash33(c) * 2.0 - 1.0, f); }
fn vfx_noise3(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let x00 = mix(vfx_grad(i, f), vfx_grad(i + vec3f(1.0, 0.0, 0.0), f - vec3f(1.0, 0.0, 0.0)), u.x);
  let x10 = mix(vfx_grad(i + vec3f(0.0, 1.0, 0.0), f - vec3f(0.0, 1.0, 0.0)), vfx_grad(i + vec3f(1.0, 1.0, 0.0), f - vec3f(1.0, 1.0, 0.0)), u.x);
  let x01 = mix(vfx_grad(i + vec3f(0.0, 0.0, 1.0), f - vec3f(0.0, 0.0, 1.0)), vfx_grad(i + vec3f(1.0, 0.0, 1.0), f - vec3f(1.0, 0.0, 1.0)), u.x);
  let x11 = mix(vfx_grad(i + vec3f(0.0, 1.0, 1.0), f - vec3f(0.0, 1.0, 1.0)), vfx_grad(i + vec3f(1.0, 1.0, 1.0), f - vec3f(1.0, 1.0, 1.0)), u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}
fn vfx_noise(p: vec2f) -> f32 { return vfx_noise3(vec3f(p, 0.37)); }
fn vfx_fbm3(p: vec3f, octaves: i32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < octaves; i++) {
    sum += amp * vfx_noise3(q);
    q = q * 2.03 + vec3f(17.1, 3.7, 9.2);
    amp *= 0.5;
  }
  return sum * 1.6;
}
fn vfx_fbm(p: vec2f, octaves: i32) -> f32 { return vfx_fbm3(vec3f(p, 0.37), octaves); }
fn vfx_loop_fbm(p: vec2f, phase: f32, speed: f32, octaves: i32) -> f32 {
  let t = fract(phase);
  let a = vfx_fbm3(vec3f(p, t * speed), octaves);
  let b = vfx_fbm3(vec3f(p, (t - 1.0) * speed), octaves);
  return mix(a, b, t) / sqrt(t * t + (1.0 - t) * (1.0 - t));
}
fn vfx_cells(p: vec2f) -> vec2f {
  let i = floor(p);
  let f = fract(p);
  var d1 = 8.0;
  var d2 = 8.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let o = vec2f(f32(x), f32(y));
      let d = length(o + vfx_hash33(vec3f(i + o, 1.7)).xy - f);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return vec2f(d1, d2);
}`;

// Supersamples effect() over each output pixel, premultiplied, inside the cell's margin. vfx_sample is a plain
// function so other entry points (the viewer's alpha view) can call it. The sample grid is rotated (RGSS), so an n x n
// grid lands on n x n distinct rows and columns and near-straight edges get n x n coverage steps, not n.
// Both outputs dither to 8 bits: plus or minus half a step of per-pixel noise, so soft glows and long alpha falloffs
// have no bands. Exact 0 and 1 stay exact.
const WRAPPER = `@vertex fn vfx_vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[index], 0.0, 1.0);
}
fn vfx_dither(c: vec4f, position: vec4f) -> vec4f {
  let cell = vec3f(floor(position.xy), 41.7);
  let noise = vec4f(vfx_hash33(cell), vfx_hash31(cell + 13.1)) - 0.5;
  return clamp(c + noise / 255.0, vec4f(0.0), vec4f(1.0));
}
@fragment fn vfx_fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let c = vfx_dither(vfx_sample(position), position);
  return vec4f(min(c.rgb, vec3f(c.a)), c.a);
}
@fragment fn vfx_fs_straight(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let c = vfx_sample(position);
  return vfx_dither(vec4f(select(vec3f(0.0), c.rgb / c.a, c.a > 0.0), c.a), position);
}
fn vfx_sample(position: vec4f) -> vec4f {
  _ = params._vfx;
  let n = max(i32(vfx.ss), 1);
  let inner = max(vfx.cell - 2.0 * vfx.padding, 1.0);
  // atan(1 / n): the angle that puts an n x n grid on n x n distinct rows and columns.
  let tilt = atan(1.0 / f32(n));
  var sum = vec4f(0.0);
  for (var j = 0; j < n; j++) {
    for (var i = 0; i < n; i++) {
      let offset = vfx_rot((vec2f(f32(i), f32(j)) + 0.5) / f32(n) - 0.5, tilt);
      let q = (position.xy + offset - vfx.origin - vfx.padding) / inner;
      let inside = select(0.0, 1.0, all(q >= vec2f(0.0)) && all(q <= vec2f(1.0)));
      let c = clamp(effect(vec2f(q.x, 1.0 - q.y)), vec4f(0.0), vec4f(1.0));
      let a = c.a * inside;
      sum += vec4f(c.rgb * a, a);
    }
  }
  return sum / f32(n * n);
}`;

// The full WGSL module and how many lines precede the node's own line 1.
export function buildModule(source, params) {
  const fields = params.map((p) => `  @align(16) @size(16) ${p.name}: ${PARAM_TYPES[p.type].wgsl},\n`).join("");
  const head = `${FRAME_STRUCT}\nstruct VfxParams {\n  _vfx: vec4f,\n${fields}}\n@group(0) @binding(1) var<uniform> params: VfxParams;\n${HELPERS}\n`;
  return { code: `${head}${source.replace(/\r\n?/g, "\n")}\n${WRAPPER}\n`, lineOffset: head.split("\n").length - 1 };
}

// Compiler messages in the node's own line numbers; anything outside the node is the engine's code.
export function mapMessages(messages, lineOffset, sourceLines) {
  return messages.map(({ type, line, column, message }) => {
    const own = line - lineOffset;
    return own >= 1 && own <= sourceLines ? { type, line: own, column, message } : { type, line: 0, column: 0, message: `(engine code) ${message}` };
  });
}

// ---------- layout and uniforms ----------

// Cells in reading order (left to right, top to bottom), the order Roblox plays a flipbook in.
export function gridLayout({ count, grid, cell, margin }) {
  const pad = margin > 0 ? Math.max(1, Math.round(margin * cell)) : 0;
  if (cell - 2 * pad < 8) throw new ToolError(`cells of ${cell} px leave ${cell - 2 * pad} px inside the margin; render larger or use a smaller margin`);
  const rects = Array.from({ length: count }, (_, i) => [(i % grid) * cell, Math.floor(i / grid) * cell, cell, cell]);
  return { width: grid * cell, height: Math.ceil(count / grid) * cell, cell, pad, rects };
}

// OneShot: first and last frames land on phase 0 and 1. Loop: phase 1 is the next loop's frame 0.
export function clipPhases(frames, mode) {
  return Array.from({ length: frames }, (_, i) => (mode === "loop" ? i / frames : frames > 1 ? i / (frames - 1) : 0));
}

export function cellUniforms({ rect, pad, ss, phase, duration, frame, frames, params, values }) {
  const floats = new Float32Array(FLOATS_PER_SLOT);
  floats.set([rect[0], rect[1], rect[2], pad, phase * duration, phase, frame, frames, ss, 1 / (rect[2] - 2 * pad), duration, 0]);
  params.forEach((p, i) => floats.set(values[p.name], 64 + 4 * (i + 1)));
  return floats;
}

// ---------- names ----------

const NAME_PATTERN = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/i;

export function checkName(name, label) {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new ToolError(`${label} name ${JSON.stringify(name)} must look like folder/name (letters, digits, _ and -)`);
  }
  return name;
}

// ---------- Roblox ----------

// The properties that put a baked texture (and its flipbook settings) on one instance.
export function textureProperties(className, recipe, uri) {
  const grid = recipe?.grid ?? 1;
  if (className === "ParticleEmitter") {
    const props = { Texture: uri, FlipbookLayout: grid > 1 ? `Grid${grid}x${grid}` : "None" };
    if (grid > 1) props.FlipbookMode = recipe.mode === "loop" ? "Loop" : "OneShot";
    if (grid > 1 && recipe.mode === "loop") {
      const fps = Math.min(30, Math.max(1, Math.round(recipe.frames / recipe.duration)));
      props.FlipbookFramerate = [fps, fps];
    }
    return props;
  }
  if (grid > 1) throw new ToolError(`a ${className} cannot play a flipbook sheet; only a ParticleEmitter can`);
  const key = { Beam: "Texture", Trail: "Texture", Decal: "Texture", Texture: "Texture", MeshPart: "TextureID", ImageLabel: "Image", ImageButton: "Image" }[className];
  if (!key) throw new ToolError(`cannot put a texture on a ${className}`);
  return { [key]: uri };
}

// An asset id, rbxassetid://<id>, or a built-in rbxasset:// content path (Studio's own textures).
export function assetUri(value) {
  const raw = String(value ?? "");
  if (/^rbxasset:\/\/[\w/.-]+$/.test(raw)) return raw;
  const match = /^(?:rbxassetid:\/\/)?(\d+)$/.exec(raw);
  if (!match) throw new ToolError(`texture must be an asset id, rbxassetid://<id> or rbxasset://<path>, got ${JSON.stringify(value)}`);
  return `rbxassetid://${match[1]}`;
}

// The properties textureProperties answers, as Luau lines that set them on one instance (the page's Copy button).
const LUAU_ENUMS = { FlipbookLayout: "ParticleFlipbookLayout", FlipbookMode: "ParticleFlipbookMode" };
export function propertiesLuau(props, variable = "emitter") {
  const value = (key, v) => {
    if (LUAU_ENUMS[key]) return `Enum.${LUAU_ENUMS[key]}.${v}`;
    if (Array.isArray(v)) return `NumberRange.new(${v.join(", ")})`;
    return JSON.stringify(v);
  };
  return Object.entries(props)
    .map(([key, v]) => `${variable}.${key} = ${value(key, v)}`)
    .join("\n");
}
