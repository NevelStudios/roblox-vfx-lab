// The lab page: live WebGPU preview of a node, its controls, the bake player and the library lists. Every read and
// write of the library goes through `backend` (backend-local.js on the MCP's own server, backend-hosted.js in the
// browser), so the same page runs at 127.0.0.1 and on GitHub Pages.
import { buildModule, cellUniforms, clipPhases, gridLayout, mapMessages, parseParams, resolveValues, round } from "./lib/core.js";
import { createHostedBackend } from "./backend-hosted.js";
import { createLocalBackend } from "./backend-local.js";
import { mountEditor } from "./editor.js";
import { exportPanel } from "./export.js";
import { loadExamples, renderGallery } from "./gallery.js";
import { openKv } from "./idb.js";
import { createWebGpu } from "./web-gpu.js";

// What New node writes: a ring that grows and fades, small enough to read in one look.
const STARTER = `// My effect: say what it shows and how to use it in Roblox (OneShot or Loop, LightEmission).
// @param tint color = #ffb347 ring colour
// @param radius f32 0.2..0.9 = 0.7 how far the ring grows
// @param width f32 0.01..0.2 = 0.06 ring width

fn effect(uv: vec2f) -> vec4f {
  let p = vfx_center(uv);
  let t = vfx.phase;
  let d = abs(length(p) - params.radius * vfx_ease_out(t)) - params.width * (1.0 - 0.6 * t);
  let alpha = vfx_fill(d, vfx.px * 1.5) * (1.0 - vfx_ease_in(t));
  return vec4f(params.tint, alpha);
}
`;

// ---------- small helpers ----------
const $ = (id) => document.getElementById(id);
const h = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== false) node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`vfx:${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`vfx:${key}`, JSON.stringify(value));
    } catch {
      // storage is a convenience: a private window simply forgets
    }
  },
};
const splitName = (name) => {
  const cut = name.lastIndexOf("/");
  return cut < 0 ? ["", name] : [name.slice(0, cut + 1), name.slice(cut + 1)];
};
const toHex = (rgb) => `#${rgb.map((v) => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, "0")).join("")}`;
const fromHex = (hex) => [1, 3, 5].map((i) => round(parseInt(hex.slice(i, i + 2), 16) / 255, 4));
const pad2 = (n) => String(n).padStart(2, "0");
const ICON_PLAY = '<svg viewBox="0 0 12 12"><path d="M2 1l9 5-9 5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 12 12"><path d="M2 1h3v10H2zM7 1h3v10H7z"/></svg>';
const ICONS = {
  folder: '<svg viewBox="0 0 14 14"><path d="M1.5 3.5h4l1.5 1.5h5.5v6.5h-11z"/></svg>',
  node: '<svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5"/><path d="M2.3 8.2c2.5 1.4 6.9 1.4 9.4 0"/></svg>',
  bake: '<svg viewBox="0 0 14 14"><rect x="2" y="2" width="10" height="10" rx="1"/><path d="M7 2v10M2 7h10"/></svg>',
};
const icon = (name) => {
  const span = h("span", { class: "ico" });
  span.innerHTML = ICONS[name];
  return span;
};
// A slider's track fills up to its value: CSS reads --p. Dragging fills it here; code that sets a value calls fill.
const fill = (input) => input.style.setProperty("--p", `${((input.value - input.min) / (input.max - input.min || 1)) * 100}%`);
document.addEventListener("input", (event) => event.target.type === "range" && fill(event.target), true);

// ---------- state ----------
// res 0 is Fit: the canvas holds as many pixels as it covers on screen. Views saved before Fit existed (no version)
// drop their res and ss, so the sharper defaults show once.
const savedView = store.get("view", {});
if (savedView.version !== 2) {
  delete savedView.res;
  delete savedView.ss;
}
const view = Object.assign(
  // fps is set while the developer last typed the FPS (the duration then follows the grid); null while they typed a duration.
  { version: 2, view: "live", grid: 4, res: 0, ss: 3, margin: 0.02, backdrop: "dark", mode: "loop", duration: 1, fps: null, speed: 1, autoBake: false },
  savedView,
  { version: 2 },
);
// In node view, bake and image hold the node's own bake (bakes/<node>), shown beside the live canvas.
const state = { kind: null, name: null, hash: null, params: [], overrides: {}, values: {}, pipes: null, problems: [], playing: true, phase: 0, hold: 0, dirty: true, bake: null, image: null, playerTime: 0 };
const baking = { timer: null, busy: false, again: false, ms: null, error: null, idle: Promise.resolve() };
let library = { nodes: [], bakes: [], library: "" };

// ---------- WebGPU ----------
const MAX_CELLS = 64;
const SLOT_BYTES = 512;
const staging = new Float32Array((MAX_CELLS * SLOT_BYTES) / 4);
const ALPHA_ENTRY = `
@fragment fn vfx_view_alpha(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let c = vfx_sample(position);
  return vec4f(c.aaa, 1.0);
}
`;
const gpu = { device: null, context: null, format: null, layout: null, buffer: null, group: null, cache: new Map(), costKey: "", msAt: {} };
const NO_WEBGPU = "This browser has no WebGPU, so nodes do not play live and bakes do not run.\nThe lab runs in Chrome, Edge, Safari 26 and Firefox 141 on Windows.\nThe gallery and finished bakes still play.";
const canvas = $("canvas");

async function initGpu() {
  if (!navigator.gpu) return NO_WEBGPU;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return `WebGPU found no GPU adapter.\n${NO_WEBGPU.split("\n").slice(1).join("\n")}`;
  const device = await adapter.requestDevice();
  device.lost.then((info) => {
    gpu.device = null;
    showNote(`The GPU device was lost (${info.message || info.reason}).
A shader may have run too long. Reload the page.`);
  });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [0, 1].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } })),
  });
  gpu.buffer = device.createBuffer({ size: MAX_CELLS * SLOT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  gpu.group = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: gpu.buffer, size: 48 } },
      { binding: 1, resource: { buffer: gpu.buffer, size: 256 } },
    ],
  });
  gpu.layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  gpu.format = navigator.gpu.getPreferredCanvasFormat();
  gpu.context = canvas.getContext("webgpu");
  gpu.context.configure({ device, format: gpu.format, alphaMode: "premultiplied" });
  gpu.device = device;
  return null;
}

// The node's module as a bake builds it, plus an alpha-view entry. Pipelines build off the main thread and are cached
// by source, so flipping between nodes or saving an unchanged file costs nothing.
async function compileNode(source) {
  const { params, problems } = parseParams(source);
  if (!/\bfn\s+effect\s*\(/.test(source)) problems.push({ type: "error", line: 0, column: 0, message: "the node must define fn effect(uv: vec2f) -> vec4f" });
  if (problems.length > 0 || !gpu.device) return { params, problems, pipes: null };
  const { code, lineOffset } = buildModule(source, params);
  const full = code + ALPHA_ENTRY;
  if (gpu.cache.has(full)) return { params, problems: [], pipes: gpu.cache.get(full) };
  const device = gpu.device;
  device.pushErrorScope("validation");
  const module = device.createShaderModule({ code: full });
  const info = await module.getCompilationInfo();
  const messages = mapMessages(
    info.messages.map((m) => ({ type: m.type, line: m.lineNum, column: m.linePos, message: m.message })),
    lineOffset,
    source.split(/\r?\n/).length,
  );
  let pipes = null;
  if (!messages.some((m) => m.type === "error")) {
    const make = (entryPoint) =>
      device.createRenderPipelineAsync({
        layout: gpu.layout,
        vertex: { module, entryPoint: "vfx_vs" },
        fragment: { module, entryPoint, targets: [{ format: gpu.format }] },
        primitive: { topology: "triangle-list" },
      });
    try {
      const [color, alpha] = await Promise.all([make("vfx_fs"), make("vfx_view_alpha")]);
      pipes = { color, alpha };
    } catch (error) {
      messages.push({ type: "error", line: 0, column: 0, message: error.message });
    }
  }
  const scoped = await device.popErrorScope();
  // A WGSL error comes back twice (compilation info and the error scope): keep the scope's only when it is new.
  if (scoped && !messages.some((m) => m.type === "error")) messages.push({ type: "error", line: 0, column: 0, message: scoped.message });
  if (pipes && !scoped) {
    if (gpu.cache.size > 24) gpu.cache.clear();
    gpu.cache.set(full, pipes);
  }
  return { params, problems: messages, pipes: scoped ? null : pipes };
}

// Playing, a node that misses the frame budget at the chosen samples drops to fewer until the view changes; paused or
// scrubbed, it always draws at the chosen samples. Each level is judged on a few frames (the first carry warm-up).
const FRAME_BUDGET_MS = 30;
function samplesFor(moving, res) {
  const key = `${state.hash}|${res}|${view.view}|${view.grid}|${view.backdrop === "alpha"}|${view.ss}`;
  if (gpu.costKey !== key) {
    gpu.costKey = key;
    gpu.msAt = {};
  }
  if (!moving) return view.ss;
  for (let s = view.ss; s > 1; s -= 1) {
    const cost = gpu.msAt[s];
    if (!cost || cost.n < 4 || cost.ms <= FRAME_BUDGET_MS) return s;
  }
  return 1;
}

const frameCount = () => view.grid * view.grid;
const frameOf = (phase) => Math.min(frameCount() - 1, Math.floor(phase * frameCount() + (view.mode === "loop" ? 0 : 1e-6)));

function drawNode() {
  if (!gpu.device || !state.pipes) return;
  const res = canvas.width;
  let layout;
  let phases;
  try {
    if (view.view === "sheet") {
      layout = gridLayout({ count: frameCount(), grid: view.grid, cell: Math.floor(res / view.grid), margin: view.margin });
      phases = clipPhases(frameCount(), view.mode);
    } else {
      layout = gridLayout({ count: 1, grid: 1, cell: res, margin: view.margin });
      phases = [state.phase];
    }
  } catch (error) {
    state.layoutNote = true;
    showNote(error.message);
    return;
  }
  if (state.layoutNote) {
    state.layoutNote = false;
    hideNote();
  }
  const frames = frameCount();
  const ss = samplesFor(state.playing && view.view === "live", res);
  state.ss = ss;
  layout.rects.forEach((rect, i) => {
    const frame = view.view === "sheet" ? i : frameOf(state.phase);
    staging.set(cellUniforms({ rect, pad: layout.pad, ss, phase: phases[i], duration: view.duration, frame, frames, params: state.params, values: state.values }), i * 128);
  });
  const device = gpu.device;
  device.queue.writeBuffer(gpu.buffer, 0, staging.buffer, 0, layout.rects.length * SLOT_BYTES);
  const encoder = device.createCommandEncoder();
  const alpha = view.backdrop === "alpha";
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: gpu.context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: alpha ? [0, 0, 0, 1] : [0, 0, 0, 0] }],
  });
  pass.setPipeline(alpha ? state.pipes.alpha : state.pipes.color);
  layout.rects.forEach(([x, y, w, hgt], i) => {
    pass.setViewport(x, y, w, hgt, 0, 1);
    pass.setScissorRect(x, y, w, hgt);
    pass.setBindGroup(0, gpu.group, [i * SLOT_BYTES, i * SLOT_BYTES + 256]);
    pass.draw(3);
  });
  pass.end();
  device.queue.submit([encoder.finish()]);
  const started = performance.now();
  const key = gpu.costKey;
  device.queue.onSubmittedWorkDone().then(() => {
    if (gpu.costKey !== key) return;
    const ms = performance.now() - started;
    const cost = gpu.msAt[ss];
    gpu.msAt[ss] = cost ? { ms: cost.ms * 0.7 + ms * 0.3, n: cost.n + 1 } : { ms, n: 1 };
  });
}

// ---------- bake player (2D canvas: what Roblox shows, one cell at a time) ----------
const player = $("player");
const playerCtx = player.getContext("2d");
// The player canvas holds as many pixels as it covers on screen, so a baked cell is scaled once, as Roblox scales a
// texture (a fixed 512 px canvas scaled it twice and blurred it more than the game does).
new ResizeObserver(([entry]) => {
  const size = Math.round(entry.contentRect.width * devicePixelRatio);
  if (size > 0 && player.width !== size) {
    player.width = player.height = size;
    requestRender();
  }
}).observe(player);

const bakeFps = (bake) => Math.min(30, Math.max(1, Math.round(bake.frames / bake.duration)));

// The cell Roblox shows t seconds into a bake: Loop at frames / duration fps, OneShot over the lifetime plus a short hold.
function bakeFrame(bake, t) {
  if (bake.grid <= 1) return 0;
  if (bake.mode === "loop") return Math.floor(t * bakeFps(bake)) % bake.frames;
  return Math.min(bake.frames - 1, Math.floor(((t % (bake.duration + 0.35)) / bake.duration) * bake.frames));
}

function drawBakeFrame(frame) {
  const { bake, image } = state;
  if (!bake || !image || !image.complete || image.naturalWidth === 0) return false;
  const cell = image.naturalWidth / bake.grid;
  // Resizing the canvas resets its context, so the filter is set on every draw.
  playerCtx.imageSmoothingQuality = "high";
  playerCtx.clearRect(0, 0, player.width, player.height);
  playerCtx.drawImage(image, (frame % bake.grid) * cell, Math.floor(frame / bake.grid) * cell, cell, cell, 0, 0, player.width, player.height);
  return true;
}

function drawPlayer(dt) {
  const bake = state.bake;
  if (state.playing) state.playerTime += dt * view.speed;
  const frame = bake ? bakeFrame(bake, state.playerTime) : 0;
  if (!drawBakeFrame(frame)) return;
  setTimecode([["Frame", `${pad2(frame + 1)}/${pad2(bake.frames)}`], ["Mode", bake.mode], ["Rate", bake.mode === "loop" ? `${bakeFps(bake)} fps` : `${bake.duration}s life`]]);
}

// ---------- frame loop: runs only while something moves ----------
let queued = false;
let last = 0;
function requestRender() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(tick);
}
function tick(now) {
  queued = false;
  const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
  last = now;
  let moving = false;
  if (state.kind === "node") {
    const live = view.view === "live";
    // The baked stage shows the cell Roblox shows at the live phase, so the two compare the same moment: smooth live,
    // stepped as the sheet steps. (By phase, not by time: a loop over 30 fps plays slower in game, which the FPS note says.)
    const baked = view.autoBake && state.bake;
    if (state.playing && (live || baked)) {
      moving = true;
      const step = (dt * view.speed) / view.duration;
      if (view.mode === "loop") state.phase = (state.phase + step) % 1;
      else if (state.phase < 1) state.phase = Math.min(1, state.phase + step);
      else if ((state.hold += dt) > 0.35) {
        state.hold = 0;
        state.phase = 0;
      }
      if (live) state.dirty = true;
    }
    if (state.dirty) {
      state.dirty = false;
      drawNode();
      syncTimecode();
    }
    if (baked) drawBakeFrame(state.bake.grid > 1 ? Math.min(state.bake.frames - 1, Math.floor(state.phase * state.bake.frames + 1e-6)) : 0);
  } else if (state.kind === "bake") {
    moving = state.playing;
    drawPlayer(dt);
  }
  if (moving) requestRender();
  else last = 0;
}
const markDirty = () => {
  state.dirty = true;
  requestRender();
};

// ---------- timecode and transport ----------
let lastTimecode = "";
function setTimecode(pairs) {
  const textValue = pairs.map(([k, v]) => `${k}:${v}`).join("|");
  if (textValue === lastTimecode) return;
  lastTimecode = textValue;
  $("timecode").replaceChildren(...pairs.map(([k, v]) => h("span", {}, k, h("b", {}, v))));
}
function syncTimecode() {
  // In the viewport's corner, not the transport: the scrub keeps its width while samples drop and come back.
  const hud = view.view === "live" && state.pipes && state.ss < view.ss ?`${state.ss}x${state.ss} samples while playing` : "";
  if ($("hud").textContent !== hud) $("hud").textContent = hud;
  if (view.view === "sheet") {
    setTimecode([["Sheet", `${view.grid}x${view.grid}`], ["Frames", String(frameCount())], ["Mode", view.mode]]);
    return;
  }
  setTimecode([
    ["Frame", `${pad2(frameOf(state.phase) + 1)}/${pad2(frameCount())}`],
    ["Time", `${(state.phase * view.duration).toFixed(2)}s`],
    ["Phase", state.phase.toFixed(3)],
  ]);
  const scrub = $("scrub");
  if (document.activeElement !== scrub) {
    scrub.value = state.phase;
    fill(scrub);
  }
}
function setPlaying(playing) {
  state.playing = playing;
  state.dirty = true; // a pause redraws at full samples
  $("play").innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  requestRender();
}
$("play").addEventListener("click", () => setPlaying(!state.playing));
$("scrub").addEventListener("input", (event) => {
  setPlaying(false);
  state.phase = Number(event.target.value);
  if (state.kind === "bake" && state.bake) state.playerTime = state.phase * state.bake.duration;
  markDirty();
});

// ---------- stage appearance ----------
// Bake view: the sheet and its player. Node view: the live canvas, and the baked frame beside it while auto bake is on.
function layoutStages() {
  const two = state.kind === "bake" || (state.kind === "node" && view.autoBake);
  $("stage2").hidden = !two;
  $("stages").classList.toggle("two", two);
  $("cap").textContent = state.kind === "bake" ? "Sheet" : two ? "Live" : "";
  const cellPx = state.bake ? ` · ${state.bake.size / state.bake.grid} px` : "";
  $("cap2").textContent = state.kind === "bake" ? `Player${cellPx}` : baking.busy ? "Baked · baking…" : state.bake ? `Baked${cellPx}` : "Baked · none yet";
}

// Fit follows the stage's size on screen in device pixels (capped: every pixel runs the node ss x ss times).
const MAX_FIT = 2048;
const canvasRes = () => view.res || Math.min(MAX_FIT, Math.max(64, Math.round($("stage").clientWidth * devicePixelRatio)));
new ResizeObserver(() => {
  if (!view.res && canvas.width !== canvasRes()) {
    applyStage();
    markDirty();
  }
}).observe($("stage"));

function applyStage() {
  layoutStages();
  const res = canvasRes();
  if (canvas.width !== res) canvas.width = canvas.height = res;
  canvas.classList.toggle("px", view.res > 0 && view.res < 512);
  for (const stage of [$("stage"), $("stage2")]) stage.className = `stage bd-${view.backdrop}`;
  const lines = $("gridlines");
  const sheet = state.kind === "node" && view.view === "sheet";
  const bakeSheet = state.kind === "bake" && state.bake?.grid > 1;
  const grid = sheet ? view.grid : bakeSheet ? state.bake.grid : 0;
  lines.classList.toggle("on", grid > 1);
  if (grid > 1) {
    const step = `${100 / grid}%`;
    lines.style.background = `linear-gradient(to right, rgba(61,142,247,.4) 1px, transparent 1px) 0 0 / ${step} 100%, linear-gradient(to bottom, rgba(61,142,247,.4) 1px, transparent 1px) 0 0 / 100% ${step}`;
  }
  if (state.problems.some((p) => p.type === "error") && state.pipes) $("stage").classList.add("stale");
}
const showNote = (message) => {
  $("note").textContent = message;
  $("note").classList.add("on");
};
const hideNote = () => $("note").classList.remove("on");

// ---------- right panel ----------
const seg = (options, current, onPick) =>
  h("div", { class: "seg" }, options.map(([value, label]) => h("button", { class: value === current ? "on" : "", onclick: () => onPick(value) }, label)));
const row = (label, control, title) => h("div", { class: "row" }, h("label", { title: title ?? label }, label), control);
const range = (attrs) => {
  const input = h("input", { type: "range", ...attrs });
  fill(input);
  return input;
};
// An inspector section whose header folds it. Folded sections stay folded across nodes and reloads.
const folded = store.get("folded", {});
const panel = (key, title, aside, ...body) =>
  h(
    "section",
    { class: `sec${folded[key] ? " shut" : ""}` },
    h(
      "button",
      {
        class: "sec-head",
        onclick: (event) => {
          folded[key] = !folded[key];
          store.set("folded", folded);
          event.currentTarget.parentElement.classList.toggle("shut", folded[key]);
        },
      },
      h("span", {}, title),
      aside,
    ),
    h("div", { class: "sec-body" }, ...body),
  );
// Continuous controls (sliders, typed numbers) must not rebuild the panel under the pointer: tweak only re-renders.
const BAKE_KEYS = ["grid", "mode", "duration", "margin"];
const tweak = (patch) => {
  Object.assign(view, patch);
  store.set("view", view);
  applyStage();
  markDirty();
  if (BAKE_KEYS.some((key) => key in patch)) bakeChanged();
};
const setView = (patch) => {
  tweak(patch);
  renderProps();
};

function numberInput(value, onValue, attrs = {}) {
  return h("input", {
    type: "number",
    value,
    step: attrs.step ?? "0.01",
    oninput: (event) => {
      const n = Number(event.target.value);
      if (event.target.value !== "" && Number.isFinite(n)) onValue(n);
    },
  });
}

function paramControl(param) {
  const current = state.values[param.name];
  const commit = (value) => {
    state.overrides = { ...state.overrides, [param.name]: value };
    state.values = resolveValues(state.params, state.overrides);
    store.set(`values:${state.name}`, state.overrides);
    markDirty();
    bakeChanged();
  };
  if (param.type === "color") return h("input", { type: "color", value: toHex(current), oninput: (event) => commit(fromHex(event.target.value)) });
  if (param.type === "f32" && param.min !== undefined) {
    const readout = numberInput(current[0], (n) => {
      slider.value = n;
      fill(slider);
      commit([n]);
    });
    const slider = range({
      min: param.min,
      max: param.max,
      step: (param.max - param.min) / 1000,
      value: current[0],
      oninput: (event) => {
        const n = round(Number(event.target.value), 4);
        readout.value = n;
        commit([n]);
      },
    });
    return h("div", { class: "pair" }, slider, readout);
  }
  if (param.type === "f32") return numberInput(current[0], (n) => commit([n]));
  return h(
    "div",
    { class: "vec" },
    current.map((component, index) =>
      numberInput(component, (n) => {
        const next = [...state.values[param.name]];
        next[index] = n;
        commit(next);
      }),
    ),
  );
}

function changedValues() {
  const out = {};
  for (const param of state.params) {
    const value = state.values[param.name];
    if (value.some((v, i) => v !== param.default[i])) out[param.name] = value.length === 1 ? value[0] : value;
  }
  return out;
}

function flash(button, label) {
  const before = button.textContent;
  button.textContent = label;
  button.classList.add("done");
  setTimeout(() => {
    button.textContent = before;
    button.classList.remove("done");
  }, 1100);
}

function renderProps() {
  const props = $("props");
  if (state.kind === "bake") {
    props.replaceChildren(...bakePanel());
    return;
  }
  if (state.kind !== "node") {
    props.replaceChildren();
    return;
  }
  const errors = state.problems.filter((p) => p.type === "error");
  props.replaceChildren(
    panel(
      "view",
      "View",
      null,
      row("Show", seg([["live", "Live"], ["sheet", "Sheet"]], view.view, (v) => setView({ view: v }))),
      row("Grid", seg([[1, "Still"], [2, "2x2"], [4, "4x4"], [8, "8x8"]], view.grid, (v) => setView({ grid: v, ...(view.fps ? { duration: round((v * v) / view.fps, 4) } : {}) }))),
      row("Backdrop", seg([["dark", "Dark"], ["light", "Light"], ["checker", "Check"], ["alpha", "Alpha"]], view.backdrop, (v) => setView({ backdrop: v }))),
      row("Pixels", seg([[0, "Fit"], [256, "256"], [512, "512"], [1024, "1k"]], view.res, (v) => setView({ res: v })), "Canvas resolution. Fit: as sharp as the screen. A 4x4 sheet at 1024 has 256 px frames."),
      row("Samples", seg([[1, "1"], [2, "2"], [3, "3"], [4, "4"]], view.ss, (v) => setView({ ss: v })), "Samples per pixel axis (rotated grid). Bakes use 4. Playing, a node over 30 ms a frame drops samples; paused, it draws at this."),
      row("Margin", h("div", { class: "pair" }, range({ min: 0, max: 0.25, step: 0.005, value: view.margin, oninput: (e) => { tweak({ margin: Number(e.target.value) }); e.target.nextSibling.textContent = view.margin.toFixed(3); } }), h("span", {}, view.margin.toFixed(3)))),
    ),
    panel(
      "clip",
      "Clip",
      null,
      row("Mode", seg([["loop", "Loop"], ["oneshot", "OneShot"]], view.mode, (v) => setView({ mode: v }))),
      clipTiming(),
      row("Speed", seg([[0.25, "¼"], [0.5, "½"], [1, "1x"], [2, "2x"]], view.speed, (v) => setView({ speed: v }))),
    ),
    panel(
      "params",
      "Parameters",
      h("span", {}, String(state.params.length)),
      state.params.length === 0 ? h("p", { class: "empty" }, "No @param annotations.") : null,
      state.params.flatMap((param) => [row(param.name, paramControl(param), param.description || param.name), param.description ? h("div", { class: "desc" }, param.description) : null]),
      h(
        "div",
        { class: "actions" },
        h("button", { class: "btn", onclick: () => resetValues() }, "Reset"),
        h("button", { class: "btn", title: "Copy vfx_bake's arguments for what the view shows", onclick: (event) => copyBake(event.currentTarget) }, "Copy bake call"),
      ),
    ),
    panel(
      "bake",
      "Bake",
      h("span", { id: "bakestate" }),
      row("Auto bake", seg([[true, "On"], [false, "Off"]], view.autoBake, (on) => setAutoBake(on)), `After every change, bake to bakes/${state.name}.png (1024 px, 4 samples) and play it beside the live view.`),
      h("dl", { class: "facts", id: "bakefacts" }),
      h("ul", { class: "msgs", id: "bakemsgs" }),
      h(
        "div",
        { class: "actions" },
        h("button", { class: "btn primary", onclick: () => runBake() }, "Bake now"),
        h("button", { class: "btn", title: "Bake what the view shows (1024 px) and save the sheet as a PNG", onclick: (event) => saveNodeSheet(event.currentTarget) }, "Save PNG"),
      ),
    ),
    panel("export", "Export", null, h("div", { id: "nodeexport" })),
    panel(
      "compiler",
      "Compiler",
      h("span", { class: errors.length ? "bad-line" : "ok-line" }, errors.length ? `${errors.length} error${errors.length > 1 ? "s" : ""}` : "OK"),
      state.problems.length
        ? h("ul", { class: "msgs" }, state.problems.map((p) => h("li", { class: p.type }, h("span", {}, p.line ? `${p.line}:${p.column} ` : ""), p.message)))
        : h("p", { class: "empty" }, "No messages."),
    ),
  );
  renderBakeStatus();
}

// Duration and FPS are one setting seen two ways: frames = fps x duration. Each field rewrites the other as you type.
function clipTiming() {
  const fps = () => frameCount() / view.duration;
  const note = h("div", { class: "desc" });
  const syncNote = () => {
    const over = view.mode === "loop" && fps() > 30.01;
    note.className = `desc${over ? " bad-line" : ""}`;
    note.textContent = over
      ? `Roblox plays 30 fps at most: in game this loop takes ${round(frameCount() / 30, 2)}s.`
      : `${frameCount()} frames of ${1024 / view.grid} px, ${round(fps(), 2)} fps in Roblox${view.mode === "oneshot" ? " over the particle's lifetime" : ""}.`;
  };
  const durationField = numberInput(view.duration, (n) => {
    if (n <= 0) return;
    tweak({ duration: n, fps: null });
    fpsField.value = round(fps(), 2);
    syncNote();
  }, { step: "0.05" });
  const fpsField = numberInput(round(fps(), 2), (n) => {
    if (n <= 0) return;
    tweak({ fps: n, duration: round(frameCount() / n, 4) });
    durationField.value = view.duration;
    syncNote();
  }, { step: "1" });
  syncNote();
  return [
    row("Duration", durationField, "Clip length in seconds (the particle's lifetime for a OneShot)"),
    row("FPS", fpsField, "Flipbook frames per second (FlipbookFramerate). Typing it sets the duration to frames / fps."),
    note,
  ];
}

function resetValues() {
  state.overrides = {};
  state.values = resolveValues(state.params, {});
  store.set(`values:${state.name}`, {});
  renderProps();
  markDirty();
  bakeChanged();
}

// vfx_bake's arguments for what the view shows. The page's auto bake posts them; "Copy bake call" copies them.
const bakeCall = () => ({ name: state.name, values: changedValues(), grid: view.grid, mode: view.mode, duration: view.duration, margin: view.margin });

function copyBake(button) {
  navigator.clipboard.writeText(JSON.stringify(bakeCall())).then(() => flash(button, "Copied"));
}

// ---------- auto bake: POST /api/bake, debounced, one in flight, the latest view wins ----------
const bakeMatches = (bake) =>
  bake.node === state.name && bake.nodeHash === state.hash && bake.grid === view.grid && bake.mode === view.mode && bake.duration === view.duration && bake.margin === view.margin && JSON.stringify(bake.values) === JSON.stringify(state.values);

function bakeChanged() {
  if (state.kind !== "node") return;
  if (view.autoBake) {
    clearTimeout(baking.timer);
    baking.timer = setTimeout(runBake, 250);
  }
  renderBakeStatus();
}

function setAutoBake(on) {
  setView({ autoBake: on });
  if (on) runBake();
}

// Resolves once no bake is left to run, so a caller can wait for the bake of what the view shows now.
function runBake() {
  clearTimeout(baking.timer);
  if (state.kind !== "node") return baking.idle;
  if (baking.busy) {
    baking.again = true;
    return baking.idle;
  }
  baking.busy = true;
  baking.idle = (async () => {
    do {
      baking.again = false;
      await bakeOnce();
    } while (baking.again && state.kind === "node");
    baking.busy = false;
    renderBakeStatus();
  })();
  return baking.idle;
}

async function bakeOnce() {
  const name = state.name;
  renderBakeStatus();
  let result;
  try {
    const answer = await backend.bake(bakeCall());
    result = { ms: answer.ms, error: null, recipe: answer.recipe };
  } catch (error) {
    result = { ms: null, error: error.message };
  }
  // The developer may have opened another node meanwhile: that node's panel keeps its own numbers.
  if (state.kind === "node" && state.name === name) {
    Object.assign(baking, { ms: result.ms, error: result.error });
    if (result.recipe) await showNodeBake(name, result.recipe);
  }
}

// Downloads a bake's sheet as the browser's own file save (bakes/space/quasar -> space-quasar.png).
async function downloadSheet(name, recipe) {
  const link = h("a", { href: await backend.sheetUrl(name, recipe), download: `${name.replaceAll("/", "-")}.png` });
  document.body.append(link);
  link.click();
  link.remove();
}

// Node view: the sheet of what the view shows now, baked first when the node's bake is out of date.
async function saveNodeSheet(button) {
  const name = state.name;
  const current = () => state.kind === "node" && state.name === name && state.bake && bakeMatches(state.bake);
  if (baking.busy) await baking.idle;
  if (!current()) await runBake();
  if (!current()) return flash(button, "Bake failed");
  await downloadSheet(name, state.bake);
  flash(button, "Saved");
}

// The node's bake from the library: shown when it exists; with auto bake on, a node with none is baked at once.
async function loadNodeBake(bakeIfMissing) {
  const name = state.name;
  const recipe = await backend.recipe(name);
  if (state.kind !== "node" || state.name !== name) return;
  if (!recipe) {
    Object.assign(state, { bake: null, image: null });
    renderBakeStatus();
    if (bakeIfMissing && view.autoBake) runBake();
    return;
  }
  // Same sheet (an upload added an asset id, or this page's own bake came back as an event): keep the image.
  if (state.image && state.bake?.pngSha === recipe.pngSha) {
    state.bake = recipe;
    renderBakeStatus();
    return;
  }
  await showNodeBake(name, recipe);
}

async function showNodeBake(name, recipe) {
  const image = new Image();
  image.src = await backend.sheetUrl(name, recipe);
  await image.decode().catch(() => {});
  if (state.kind !== "node" || state.name !== name) return;
  Object.assign(state, { bake: recipe, image });
  renderBakeStatus();
  requestRender();
}

function renderBakeStatus() {
  layoutStages();
  const status = $("bakestate");
  if (!status || state.kind !== "node") return;
  const bake = state.bake;
  const [label, cls] = baking.busy ? ["Baking…", "warn-line"] : baking.error ? ["Failed", "bad-line"] : !bake ? ["None", ""] : bakeMatches(bake) ? ["Current", "ok-line"] : ["Out of date", "warn-line"];
  status.textContent = label;
  status.className = cls;
  const facts = bake
    ? [
        ["File", h("a", { onclick: () => openBake(state.name) }, `bakes/${state.name}.png`)],
        ["Sheet", `${bake.size} px · ${bake.flipbookLayout} · ${bake.mode}`],
        ["Baked", `${new Date(bake.bakedAt).toLocaleTimeString()}${baking.ms !== null ? ` · ${baking.ms} ms` : ""}`],
      ]
    : [];
  $("bakefacts").replaceChildren(...facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
  const msgs = [...(baking.error ? [h("li", {}, baking.error)] : []), ...(bake?.warnings ?? []).map((w) => h("li", { class: "warning" }, w))];
  $("bakemsgs").replaceChildren(...msgs);
  renderNodeExport();
}

const uploadOf = (bake) => bake.uploads?.find((u) => u.pngSha === bake.pngSha);
const exportSection = (name, bake) =>
  panel("export", "Export", h("span", { class: uploadOf(bake) ? "ok-line" : "" }, uploadOf(bake) ? "Uploaded" : "Not uploaded"), exportPanel({ backend, bake: { ...bake, name } }));

// Node view: the Export panel follows the node's bake on disk. It is rebuilt only when that bake changes, so an
// export's answer stays on screen while the bake status refreshes.
function renderNodeExport() {
  const box = $("nodeexport");
  const bake = state.bake;
  const key = bake ? `${bake.pngSha}|${bake.uploads?.length ?? 0}` : "none";
  if (!box || box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(bake ? exportPanel({ backend, bake: { ...bake, name: state.name } }) : h("p", { class: "empty" }, "Bake it first: Bake now, or turn Auto bake on."));
}

function bakePanel() {
  const bake = state.bake;
  if (!bake) return [];
  const facts = [
    ["Node", h("a", { onclick: () => openNode(bake.node) }, bake.node)],
    ["Sheet", `${bake.size} px · ${bake.flipbookLayout}`],
    ["Frames", String(bake.frames)],
    ["Mode", `${bake.mode} · ${bake.duration}s · ${bake.grid > 1 ? `${round(Math.min(30, bake.frames / bake.duration), 2)} fps` : "still"}`],
    ["Margin", String(bake.margin)],
    ["Samples", String(bake.ss)],
    ["Baked", new Date(bake.bakedAt).toLocaleString()],
  ];
  const values = Object.entries(bake.values ?? {});
  const warnings = bake.warnings ?? [];
  return [
    panel(
      "player",
      "Player",
      null,
      row("Backdrop", seg([["dark", "Dark"], ["light", "Light"], ["checker", "Check"]], view.backdrop === "alpha" ? "dark" : view.backdrop, (v) => setView({ backdrop: v }))),
      row("Speed", seg([[0.25, "¼"], [0.5, "½"], [1, "1x"], [2, "2x"]], view.speed, (v) => setView({ speed: v }))),
    ),
    panel("recipe", "Recipe", null, h("dl", { class: "facts" }, facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]))),
    panel(
      "values",
      "Values",
      h("span", {}, String(values.length)),
      values.length
        ? h("dl", { class: "facts" }, values.flatMap(([k, v]) => [h("dt", {}, k), h("dd", { class: "mono" }, v.map((n) => round(n, 3)).join(", "))]))
        : h("p", { class: "empty" }, "The node's defaults."),
    ),
    exportSection(state.name, bake),
    panel(
      "warnings",
      "Warnings",
      h("span", { class: warnings.length ? "warn-line" : "ok-line" }, warnings.length ? String(warnings.length) : "None"),
      warnings.length ? h("ul", { class: "msgs" }, warnings.map((w) => h("li", { class: "warning" }, w))) : h("p", { class: "empty" }, "No warnings."),
    ),
  ];
}

// ---------- header and lists ----------
// items: [text, class] pairs after the name (mono for a hash, ok or bad for a status).
function setHeader(name, items) {
  const [dir, base] = splitName(name);
  $("title").replaceChildren(h("span", { class: "dir" }, dir), base);
  $("meta").replaceChildren(...items.map(([label, cls]) => h("span", { class: cls ?? "" }, label)));
}

// One list, each entry under its folder: space/black-hole shows as black-hole under a space row.
function tree(kind, entries, tagOf) {
  let folder = "";
  return entries.flatMap((entry) => {
    const [dir, base] = splitName(entry.name);
    const head = dir && dir !== folder ? h("div", { class: "folder" }, icon("folder"), dir.slice(0, -1)) : null;
    folder = dir;
    const open = state.kind === kind && state.name === entry.name;
    const item = h(
      "button",
      { class: `item${dir ? " nested" : ""}${open ? " on" : ""}`, title: entry.name, onclick: () => (kind === "node" ? openNode(entry.name) : openBake(entry.name)) },
      icon(kind),
      h("span", { class: "name" }, base),
      tagOf(entry),
      entry.readOnly
        ? null
        : h("span", { class: "del", role: "button", title: `Delete this ${kind}`, onclick: (event) => (event.stopPropagation(), removeEntry(kind, entry.name)) }, "×"),
    );
    return head ? [head, item] : [item];
  });
}

function renderLists() {
  const query = $("filter").value.trim().toLowerCase();
  const match = (name) => !query || name.toLowerCase().includes(query);
  const nodes = library.nodes.filter((n) => match(n.name));
  const bakes = library.bakes.filter((b) => match(b.name));
  const bakeTag = (b) => h("span", { class: "tag" }, b.assetId ? h("i", { class: "dot", title: "Uploaded to Roblox" }) : null, b.grid > 1 ? `${b.grid}x${b.grid}` : "still");
  $("nodes").replaceChildren(...(nodes.length ? tree("node", nodes, () => null) : [h("p", { class: "empty" }, library.nodes.length ? "No match." : "Press New node, or ask the AI to write one (vfx_shader_write).")]));
  $("bakes").replaceChildren(...(bakes.length ? tree("bake", bakes, bakeTag) : [h("p", { class: "empty" }, library.bakes.length ? "No match." : "Open a node and press Bake now, or ask the AI (vfx_bake).")]));
  $("galleryitem").classList.toggle("on", state.kind === "gallery");
  $("nodecount").textContent = library.nodes.length;
  $("bakecount").textContent = library.bakes.length;
  // The left-to-right mark keeps the path's leading slash in place while the box cuts from the left.
  $("libpath").textContent = `‎${backend.location}`;
  $("libpath").title = backend.location;
}

// Delete, after the developer confirms. When the open node or bake goes, the page opens the first one left.
async function removeEntry(kind, name) {
  const what = kind === "node" ? `the node ${name} (shaders/${name}.wgsl)` : `the bake ${name} (its PNG and recipe)`;
  if (!confirm(`Delete ${what}?\n\nThis cannot be undone. An asset already uploaded to Roblox stays there.`)) return;
  try {
    await backend.remove({ kind, name });
  } catch (error) {
    showNote(`Delete: ${error.message}`);
    return;
  }
  await loadLibrary();
  if (state.kind !== kind || state.name !== name) return;
  if (library.nodes[0]) await openNode(library.nodes[0].name);
  else if (library.bakes[0]) await openBake(library.bakes[0].name);
  else if (examples.length) openGallery();
}

async function loadLibrary() {
  library = await backend.listing();
  renderLists();
}

// ---------- editor ----------
// editorBase is the hash of the source the editor text was loaded from: a save sends it as replaces, so a save over
// a change made elsewhere meanwhile is refused as stale instead of losing that change.
let editor = null;
let editorBase = null;

function mountNodeEditor(node, problems) {
  editorBase = node.hash;
  editor = mountEditor($("code"), { source: node.source, problems, readOnly: node.readOnly, onSave: saveSource, onNew: newNode, onDuplicate: duplicateNode });
}

// A read-only example becomes the artist's own node, with the values set on it so far.
async function duplicateNode() {
  const from = state.name;
  const name = prompt("Name of your copy (folder/name):", `mine/${splitName(from)[1]}`)?.trim();
  if (!name) return;
  const node = await backend.node(from);
  try {
    await backend.saveNode({ name, source: node.source });
  } catch (error) {
    editor.setProblems([{ type: "error", line: 0, column: 0, message: error.message }]);
    return;
  }
  store.set(`values:${name}`, state.overrides);
  await loadLibrary();
  await openNode(name);
}

async function saveSource(source) {
  const name = state.name;
  try {
    const verdict = await backend.saveNode({ name, source, replaces: editorBase });
    editorBase = verdict.hash;
    editor.setProblems(verdict.problems);
    await openNode(name);
    return true;
  } catch (error) {
    editor.setProblems([{ type: "error", line: 0, column: 0, message: error.message }]);
    return false;
  }
}

async function newNode(name) {
  try {
    await backend.saveNode({ name, source: STARTER });
  } catch (error) {
    editor?.setProblems([{ type: "error", line: 0, column: 0, message: error.message }]);
    showNote(`New node: ${error.message}`);
    return;
  }
  await loadLibrary();
  setCode(true);
  await openNode(name);
}

// The Code pane sits beside the stage; it stays open across nodes and reloads.
function setCode(on) {
  view.code = on;
  store.set("view", view);
  document.querySelector("main").classList.toggle("coding", on && state.kind === "node");
  $("codebtn").classList.toggle("on", on);
}
$("codebtn").addEventListener("click", () => setCode(!view.code));
$("newbtn").addEventListener("click", () => {
  const name = prompt("Name of the new node (folder/name, letters, digits, - and _):", "my/effect");
  if (name) newNode(name.trim());
});

// ---------- open a node or a bake ----------
async function openNode(name) {
  const node = await backend.node(name);
  if (!node) return;
  const same = state.kind === "node" && state.name === name && state.hash === node.hash && state.pipes;
  if (same) return;
  closeGallery();
  restoreCanvas();
  const switching = state.kind !== "node" || state.name !== name;
  const edited = !switching && state.hash !== node.hash;
  const compiled = await compileNode(node.source);
  // A broken save keeps showing the last good pipeline, with the parameters that pipeline was built for.
  const keepOld = !compiled.pipes && !switching && state.pipes;
  Object.assign(state, { kind: "node", name, hash: node.hash, problems: compiled.problems, bake: switching ? null : state.bake, image: switching ? null : state.image });
  if (switching) {
    clearTimeout(baking.timer);
    Object.assign(baking, { again: false, ms: null, error: null });
  }
  if (!keepOld) {
    state.pipes = compiled.pipes;
    // Keep what the developer set, for every parameter that still exists with a value that still fits.
    const saved = switching ? store.get(`values:${name}`, {}) : state.overrides;
    const kept = Object.fromEntries(Object.entries(saved).filter(([key]) => compiled.params.some((p) => p.name === key)));
    state.params = compiled.params;
    try {
      state.values = resolveValues(state.params, kept);
      state.overrides = kept;
    } catch {
      state.overrides = {};
      state.values = resolveValues(state.params, {});
    }
  }
  store.set("open", { kind: "node", name });
  $("transport").hidden = false;
  if (switching || !editor) mountNodeEditor(node, compiled.problems);
  else {
    if (editor.setSource(node.source)) editorBase = node.hash;
    // Without WebGPU the page knows only @param problems; the save's verdict (from the lab's GPU) stays then.
    if (gpu.device) editor.setProblems(compiled.problems);
  }
  setCode(view.code);
  const errors = state.problems.filter((p) => p.type === "error").length;
  setHeader(name, [[node.hash, "mono"], [`${state.params.length} params`], [errors ? `${errors} error${errors > 1 ? "s" : ""}` : "No errors", errors ? "bad" : "ok"]]);
  if (!gpu.device) showNote(gpuProblem);
  else if (!state.pipes) showNote("The node does not compile yet.\nThe messages are in the Compiler panel.");
  else hideNote();
  applyStage();
  renderLists();
  renderProps();
  markDirty();
  if (switching) await loadNodeBake(true);
  // A save that does not compile bakes nothing: the last good bake stays beside the last good pipeline.
  else if (edited && errors === 0) bakeChanged();
}

async function openBake(name) {
  const bake = await backend.recipe(name);
  if (!bake) return;
  closeGallery();
  const image = new Image();
  image.src = await backend.sheetUrl(name, bake);
  Object.assign(state, { kind: "bake", name, hash: bake.pngSha, bake, image, pipes: null, problems: [], playerTime: 0 });
  editor = null;
  setCode(view.code);
  store.set("open", { kind: "bake", name });
  hideNote();
  $("hud").textContent = "";
  $("transport").hidden = false;
  const upload = bake.uploads?.find((u) => u.pngSha === bake.pngSha);
  setHeader(name, [[bake.grid > 1 ? `${bake.grid}x${bake.grid} flipbook` : "Still"], [`${bake.size} px`], [upload ? "Uploaded" : "Not uploaded", upload ? "ok" : ""]]);
  // The sheet shows on the main stage as a picture: swap the canvas for the image while a bake is open.
  showSheetImage(image);
  applyStage();
  renderLists();
  renderProps();
  image.decode().then(requestRender, requestRender);
}

// ---------- gallery ----------
let examples = [];

function openGallery() {
  restoreCanvas();
  clearTimeout(baking.timer);
  Object.assign(state, { kind: "gallery", name: null, hash: null, bake: null, image: null, pipes: null, problems: [] });
  editor = null;
  setCode(view.code);
  store.set("open", { kind: "gallery" });
  hideNote();
  $("gallery").hidden = false;
  $("transport").hidden = true;
  setHeader("Gallery", [[`${examples.length} examples`], ["Open one to tweak it and bake your own"]]);
  renderGallery($("gallery"), examples, { onOpen: openExample, baseUrl: "./" });
  renderLists();
  renderProps();
}

// Opens an example's node with the settings and values its sheet was baked with.
async function openExample(name) {
  const entry = examples.find((e) => e.name === name);
  Object.assign(view, { grid: entry.grid, mode: entry.mode, duration: entry.duration, margin: entry.margin, fps: null });
  store.set("view", view);
  store.set(`values:${entry.node}`, entry.values);
  await openNode(entry.node);
}

const closeGallery = () => ($("gallery").hidden = true);
$("galleryitem").addEventListener("click", openGallery);

let sheetImage = null;
function showSheetImage(image) {
  sheetImage?.remove();
  sheetImage = image;
  if (!image) {
    canvas.hidden = false;
    return;
  }
  canvas.hidden = true;
  $("stage").insertBefore(image, canvas);
}
const restoreCanvas = () => showSheetImage(null);

// ---------- live updates (server-sent events from fs.watch) ----------
function listen() {
  const live = $("live");
  if (backend.mode === "hosted") {
    live.classList.toggle("on", backend.persistent);
    live.textContent = backend.persistent ? "In this browser" : "Not saving";
    live.title = backend.location;
  }
  const onStatus = (connected) => {
    live.classList.toggle("on", connected);
    live.textContent = connected ? "Connected" : "Reconnecting";
  };
  backend.subscribe(async (changes) => {
    await loadLibrary();
    const touches = (kind) => changes.some((c) => c.kind === "library" || (c.kind === kind && c.name === state.name));
    if (state.kind === "node") {
      if (touches("node") && library.nodes.some((n) => n.name === state.name)) await openNode(state.name);
      // A bake of this node from elsewhere (vfx_bake, another page): show it. This page's own shows when its POST answers.
      if (touches("bake") && !baking.busy) await loadNodeBake(false);
    } else if (state.kind === "bake" && touches("bake")) {
      if (library.bakes.some((b) => b.name === state.name)) await openBake(state.name);
    }
  }, onStatus);
}

// ---------- keyboard ----------
document.addEventListener("keydown", (event) => {
  if (event.target.matches("input, select, textarea")) {
    if (event.key === "Escape") event.target.blur();
    return;
  }
  if (event.key === " ") {
    event.preventDefault();
    setPlaying(!state.playing);
  } else if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && state.kind === "node") {
    event.preventDefault();
    setPlaying(false);
    const step = 1 / (view.mode === "loop" ? frameCount() : Math.max(1, frameCount() - 1));
    state.phase = Math.min(1, Math.max(0, state.phase + (event.key === "ArrowRight" ? step : -step)));
    markDirty();
  } else if (event.key === "s" && state.kind === "node") setView({ view: view.view === "sheet" ? "live" : "sheet" });
  else if (event.key === "/") {
    event.preventDefault();
    $("filter").focus();
  }
});
$("filter").addEventListener("input", renderLists);

// ---------- start ----------
// The MCP's own server when it answers; else the lab runs in this browser (GitHub Pages), on its WebGPU and IndexedDB.
const gpuProblem = await initGpu();
const backend = (await createLocalBackend()) ?? (await createHostedBackend({ kv: await openKv(), gpu: gpu.device ? createWebGpu(gpu.device) : null }));
examples = backend.examples ?? (await loadExamples());
if (gpuProblem) showNote(gpuProblem);
setPlaying(true);
applyStage();
setCode(view.code);
await loadLibrary();
listen();
const open = store.get("open", backend.mode === "hosted" ? { kind: "gallery" } : null);
const found = open && open.kind !== "gallery" && (open.kind === "node" ? library.nodes : library.bakes).some((e) => e.name === open.name);
if (found) await (open.kind === "node" ? openNode(open.name) : openBake(open.name));
else if (open?.kind === "gallery" && examples.length) openGallery();
else if (library.nodes[0]) await openNode(library.nodes[0].name);
else if (library.bakes[0]) await openBake(library.bakes[0].name);
else setHeader("Empty library", [["Press New node, or ask the AI to write one"]]);
