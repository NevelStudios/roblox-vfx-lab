// The browser-safe bake: checks a node, renders its cells on a GPU and measures the sheet. The MCP (Dawn in a child
// process) and the hosted page (the browser's WebGPU) pass their own GPU with the same two calls, so a sheet baked in
// either place comes from the same steps. Files, hashes and storage stay with the caller. No Node APIs here.
//
// GPU interface:
//   compile(code) -> [{ type, line, column, message }] (empty when the module and the pipeline are valid)
//   render({ code, width, height, cells: [{ rect: [x, y, w, h], uniforms: Float32Array }] })
//     -> Uint8Array of straight RGBA (RGB 0 where alpha is 0), row-major, top row first
import { ToolError, buildModule, cellUniforms, clipPhases, gridLayout, mapMessages, parseParams, resolveValues } from "./core.js";
import { bakeWarnings, cellStats, crop, dilate } from "./pixels.js";

export const BAKE_GRIDS = [1, 2, 4, 8];
export const BAKE_SIZES = [256, 512, 1024];
export const BAKE_TILES = [1, 2, 3, 4];

export function choice(value, allowed, label, fallback) {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) throw new ToolError(`${label} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
  return value;
}

export function numberIn(value, min, max, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new ToolError(`${label} must be a number in ${min}..${max}, got ${JSON.stringify(value)}`);
  return value;
}

// vfx_bake's arguments, checked, with their defaults.
export function bakeOptions(args) {
  const options = {
    grid: choice(args.grid, BAKE_GRIDS, "grid", 4),
    size: choice(args.size, BAKE_SIZES, "size", 1024),
    mode: choice(args.mode, ["oneshot", "loop"], "mode", "oneshot"),
    duration: numberIn(args.duration, 0.01, 60, "duration", 1),
    margin: numberIn(args.margin, 0, 0.25, "margin", 0.02),
    ss: Math.round(numberIn(args.ss, 1, 4, "ss", 4)),
    tiles: choice(args.tiles, BAKE_TILES, "tiles", 1),
  };
  if (options.tiles > 1 && options.grid !== 1) throw new ToolError("tiles splits a still: pass grid 1 (a flipbook sheet plays only whole)");
  return options;
}

// { state: clean | problems, params, problems }. The node compiles on the GPU only when its annotations are valid.
export async function checkNode(source, gpu) {
  const { params, problems } = parseParams(source);
  if (!/\bfn\s+effect\s*\(/.test(source)) problems.push({ type: "error", line: 0, column: 0, message: "the node must define fn effect(uv: vec2f) -> vec4f" });
  if (problems.length > 0) return { state: "problems", params, problems };
  const { code, lineOffset } = buildModule(source, params);
  const messages = mapMessages(await gpu.compile(code), lineOffset, source.split(/\r?\n/).length);
  return { state: messages.some((m) => m.type === "error") ? "problems" : "clean", params, problems: messages };
}

// A node that compiles, or a ToolError naming its problems: nothing renders from a broken source.
export async function requireClean(name, source, gpu) {
  const check = await checkNode(source, gpu);
  if (check.state !== "clean") throw new ToolError(`${name} has problems: ${check.problems.map((p) => `${p.line}:${p.column} ${p.message}`).join("; ")}`);
  return { source, params: check.params };
}

export async function renderCells(gpu, node, layout, specs, ss) {
  const { code } = buildModule(node.source, node.params);
  const cells = layout.rects.map((rect, i) => ({ rect, uniforms: cellUniforms({ rect, pad: layout.pad, ss, params: node.params, ...specs[i] }) }));
  return dilate(await gpu.render({ code, width: layout.width, height: layout.height, cells }), layout.width, layout.rects);
}

// One bake of a clean node ({ name, hash, source, params }): the whole sheet (tiles x size px for tiles), its stats,
// its warnings and the recipe fields that do not depend on the file (base).
export async function bakeSheet(node, args, gpu) {
  const options = bakeOptions(args);
  const values = resolveValues(node.params, args.values);
  const { grid, size, mode, duration, margin, ss, tiles } = options;
  const frames = grid * grid;
  const layout = gridLayout({ count: frames, grid, cell: (size * tiles) / grid, margin });
  const specs = clipPhases(frames, mode).map((phase, i) => ({ phase, frame: i, frames, duration, values }));
  const rgba = await renderCells(gpu, node, layout, specs, ss);
  const stats = cellStats(rgba, layout.width, layout.rects, layout.pad);
  const base = {
    node: node.name,
    nodeHash: node.hash,
    values,
    grid,
    size,
    frames,
    mode,
    duration,
    margin,
    ss,
    flipbookLayout: grid > 1 ? `Grid${grid}x${grid}` : "None",
  };
  return { options, values, layout, rgba, stats, warnings: bakeWarnings(stats, { mode, margin, duration }), base };
}

// The images to write: the sheet itself, or tiles x tiles crops of `size` px (row 1 at the top). Roblox caps an image at
// 1024 px, so a sharper still is laid out as tiles in one gui.
export function bakeTiles({ options, layout, rgba }) {
  const { tiles, size } = options;
  if (tiles === 1) return [{ row: 1, col: 1, rgba, width: layout.width, height: layout.height }];
  const out = [];
  for (let row = 1; row <= tiles; row += 1) {
    for (let col = 1; col <= tiles; col += 1) out.push({ row, col, rgba: crop(rgba, layout.width, (col - 1) * size, (row - 1) * size, size, size), width: size, height: size });
  }
  return out;
}
