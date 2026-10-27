// The lab's Node side: the library on disk (shaders/<name>.wgsl, bakes/<name>.png and .json) and the MCP tools.
// Every decision (annotations, layout, pixels, stats, warnings, properties) is in the browser-safe modules; the handlers
// read and write files, call the GPU (ctx.gpu) and reach Studio through Roblox's own Studio MCP (ctx.studio).
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { bakeOptions, bakeSheet, bakeTiles, checkNode, choice, numberIn, renderCells, requireClean } from "./bake.js";
import { ToolError, assetUri, checkName, clipPhases, gridLayout, resolveValues, round, textureProperties } from "./core.js";
import { bakeWarnings, cellStats, composite, downscale, drawGrid, pngFile, pngRows } from "./pixels.js";
import { pickStudio, resultText, runOp } from "./studio.js";

const GUIDE = fs.readFileSync(new URL("./guide.md", import.meta.url), "utf8");
const PREVIEW_MAX = 512;

export const vfxLibrary = () => process.env.VFX_LAB_LIBRARY || path.join(os.homedir(), "roblox-vfx-lab");
export const shaderFile = (name, library = vfxLibrary()) => path.join(library, "shaders", `${checkName(name, "shader")}.wgsl`);
export const bakeFile = (name, ext, library = vfxLibrary()) => path.join(library, "bakes", `${checkName(name, "bake")}.${ext}`);
export const sourceHash = (source) => crypto.createHash("sha256").update(source).digest("hex").slice(0, 12);
export const pngSha = (png) => crypto.createHash("sha256").update(png).digest("hex");

// 8-bit RGBA PNG, deflate level 1: 12 ms for a 1024 sheet against 83 ms at level 9, for a file about 1.5x larger.
export const encodePngNode = (rgba, width, height) => pngFile(width, height, zlib.deflateSync(pngRows(rgba, width, height), { level: 1 }));

export const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
export const imageContent = (rgba, width, height) => ({ type: "image", data: Buffer.from(encodePngNode(rgba, width, height)).toString("base64"), mimeType: "image/png" });

export function requireString(args, key) {
  const value = args?.[key];
  if (typeof value !== "string" || value === "") throw new ToolError(`${key} is required (non-empty string)`);
  return value;
}

// Library names (folder/name) of every file with this extension under dir, sorted.
export function listNames(dir, ext, prefix = "") {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isDirectory()) return listNames(path.join(dir, entry.name), ext, `${prefix}${entry.name}/`);
      return entry.name.endsWith(ext) ? [`${prefix}${entry.name.slice(0, -ext.length)}`] : [];
    })
    .sort();
}

export function readSource(name, library = vfxLibrary()) {
  const file = shaderFile(name, library);
  if (!fs.existsSync(file)) throw new ToolError(`no shader ${name} in ${path.join(library, "shaders")} (vfx_shader_list shows them)`);
  return fs.readFileSync(file, "utf8");
}

export function readRecipe(name, library = vfxLibrary()) {
  const file = bakeFile(name, "json", library);
  if (!fs.existsSync(file)) throw new ToolError(`no bake ${name}; run vfx_bake first`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const verdict = (name, source, check) => ({ name, hash: sourceHash(source), state: check.state, problems: check.problems, params: check.params.map(({ line: _line, ...p }) => p) });

// Writes a node and answers its verdict. Shared by vfx_shader_write, vfx_shader_edit and the page's save.
export async function writeNode(name, source, gpu, library = vfxLibrary()) {
  const file = shaderFile(name, library);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return verdict(name, source, await checkNode(source, gpu));
}

// The stale-hash rule: an existing node is replaced only by a caller that names its current hash.
export function checkReplaces(name, replaces, library = vfxLibrary()) {
  const file = shaderFile(name, library);
  if (!fs.existsSync(file)) return;
  const current = sourceHash(fs.readFileSync(file, "utf8"));
  if (replaces !== current) throw new ToolError(`stale: ${name} exists with hash ${current}; read it, then pass replaces: "${current}" to replace it`);
}

async function loadNode(name, gpu, library) {
  const source = readSource(name, library);
  return { name, hash: sourceHash(source), ...(await requireClean(name, source, gpu)) };
}

// Renders a node into bakes/<out>.png and its recipe (vfx_bake's arguments). Shared by vfx_bake, the page's bake and
// the examples script. tiles n > 1 writes n x n PNGs, bakes/<out>-<row>-<col>; the answer's recipe, png and files
// are the first one's, and `tiles` lists them all.
export async function bakeNode(args, gpu, library = vfxLibrary()) {
  const name = requireString(args, "name");
  const out = checkName(args.out ?? name, "bake");
  bakeOptions(args);
  const node = await loadNode(name, gpu, library);
  const sheet = await bakeSheet(node, args, gpu);
  const bakedAt = new Date().toISOString();
  const tiled = sheet.options.tiles > 1;
  const written = bakeTiles(sheet).map((tile) => {
    const tileOut = tiled ? checkName(`${out}-${tile.row}-${tile.col}`, "bake") : out;
    const png = encodePngNode(tile.rgba, tile.width, tile.height);
    const pngPath = bakeFile(tileOut, "png", library);
    const recipePath = bakeFile(tileOut, "json", library);
    const previous = fs.existsSync(recipePath) ? JSON.parse(fs.readFileSync(recipePath, "utf8")) : {};
    const recipe = {
      ...sheet.base,
      ...(tiled ? { tile: { row: tile.row, col: tile.col, of: sheet.options.tiles } } : {}),
      pngSha: pngSha(png),
      bakedAt,
      warnings: sheet.warnings,
      stats: sheet.stats.cells,
      uploads: previous.uploads ?? [],
    };
    fs.mkdirSync(path.dirname(pngPath), { recursive: true });
    fs.writeFileSync(pngPath, png);
    fs.writeFileSync(recipePath, `${JSON.stringify(recipe, null, 2)}\n`);
    return { out: tileOut, recipe, png, pngFile: pngPath, recipeFile: recipePath };
  });
  return { ...written[0], rgba: sheet.rgba, layout: sheet.layout, tiles: written };
}

// Deletes a node or a bake (its PNG and recipe). Answers the files removed, relative to the library.
export function deleteEntry({ kind, name }, library = vfxLibrary()) {
  const files = kind === "node" ? [shaderFile(name, library)] : kind === "bake" ? [bakeFile(name, "png", library), bakeFile(name, "json", library)] : null;
  if (!files) throw new ToolError(`kind must be node or bake, got ${JSON.stringify(kind)}`);
  const existing = files.filter((file) => fs.existsSync(file));
  if (existing.length === 0) throw new ToolError(`no ${kind} ${name}`);
  for (const file of existing) fs.rmSync(file);
  return { kind, name, deleted: existing.map((file) => path.relative(library, file).replaceAll("\\", "/")) };
}

// First start: a library with no shaders/ folder gets the examples (examples/<c>/<n>.wgsl to shaders/, .png and .json
// to bakes/). A file that exists is never overwritten, so an artist's edit survives.
export function seedLibrary(library, examplesDir) {
  if (fs.existsSync(path.join(library, "shaders")) || !fs.existsSync(examplesDir)) return { copied: 0 };
  let copied = 0;
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      const ext = path.extname(entry.name);
      if (prefix === "" || ![".wgsl", ".png", ".json"].includes(ext)) continue;
      const target = path.join(library, ext === ".wgsl" ? "shaders" : "bakes", prefix, entry.name);
      if (fs.existsSync(target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(dir, entry.name), target);
      copied += 1;
    }
  };
  walk(examplesDir, "");
  return { copied };
}

// ---------- Studio ----------

// Serves one PNG on 127.0.0.1 for the duration of `use(url)`: upload_image takes HTTP URLs.
async function serveOnce(bytes, use) {
  const token = crypto.randomBytes(8).toString("hex");
  const server = http.createServer((request, response) => {
    if (request.url !== `/${token}.png`) return response.writeHead(404).end();
    response.writeHead(200, { "content-type": "image/png", "content-length": bytes.length }).end(bytes);
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  try {
    return await use(`http://127.0.0.1:${server.address().port}/${token}.png`);
  } finally {
    server.close();
  }
}

// Uploads a bake's PNG through Roblox's upload_image and records the asset id in its recipe. The same PNG is never
// uploaded twice: its recorded id comes back unless force is true. Studio is reached only when an upload happens.
export async function uploadBake(name, ctx, { force = false, studio_id, library = vfxLibrary() } = {}) {
  const bake = checkName(name, "bake");
  const recipe = readRecipe(bake, library);
  const png = fs.readFileSync(bakeFile(bake, "png", library));
  const sha = pngSha(png);
  const existing = recipe.uploads.find((u) => u.pngSha === sha);
  if (existing && !force) return { bake, assetId: existing.assetId, texture: `rbxassetid://${existing.assetId}`, reused: true };
  const studioId = await pickStudio({ studio_id }, ctx.studio);
  const answer = await serveOnce(png, async (url) => {
    const result = await ctx.studio.call("upload_image", { studio_id: studioId, imagePaths: [url] });
    if (result.isError) throw new ToolError(`upload_image failed: ${resultText(result)}`);
    return resultText(result);
  });
  const match = /rbxassetid:\/\/(\d+)/.exec(answer);
  if (!match) throw new ToolError(`upload_image answered without an asset id: ${answer.slice(0, 300)}`);
  const upload = { assetId: Number(match[1]), pngSha: sha, at: new Date().toISOString() };
  fs.writeFileSync(bakeFile(bake, "json", library), `${JSON.stringify({ ...recipe, uploads: [...recipe.uploads, upload] }, null, 2)}\n`);
  return { bake, assetId: upload.assetId, texture: `rbxassetid://${upload.assetId}`, reused: false };
}

// Puts an uploaded bake (with its flipbook settings) or a texture id on targets, or on a new instance (create).
// Every class is checked before the first write; one set_properties call per class.
export async function applyBake({ bake, texture, targets, create, properties }, ctx, studioId, library = vfxLibrary()) {
  if ((bake === undefined) === (texture === undefined)) throw new ToolError("pass exactly one of bake or texture");
  if ((targets === undefined) === (create === undefined)) throw new ToolError("pass exactly one of targets or create");
  let recipe = null;
  let uri;
  if (bake !== undefined) {
    recipe = readRecipe(checkName(bake, "bake"), library);
    const upload = recipe.uploads.find((u) => u.pngSha === recipe.pngSha);
    if (!upload) throw new ToolError(`${bake} is not uploaded in its current version; run vfx_upload first`);
    uri = `rbxassetid://${upload.assetId}`;
  } else uri = assetUri(texture);
  const extra = properties ?? {};
  if (create !== undefined) {
    const className = create.className ?? "ParticleEmitter";
    const props = { ...textureProperties(className, recipe, uri), ...extra };
    const name = create.name ?? (bake ? bake.split("/").pop() : "VfxTexture");
    const created = await runOp(ctx.studio, studioId, "create_instances", { items: [{ className, name, parent: create.parent, properties: props }] });
    return { created: created.created, className, properties: props };
  }
  if (!Array.isArray(targets) || targets.length === 0) throw new ToolError("targets must be a non-empty array of paths");
  const rows = await runOp(ctx.studio, studioId, "get_properties", { paths: targets, properties: ["Name"] });
  const byClass = new Map();
  targets.forEach((target, index) => {
    const { className } = rows[index];
    if (!byClass.has(className)) byClass.set(className, { properties: { ...textureProperties(className, recipe, uri), ...extra }, paths: [] });
    byClass.get(className).paths.push(target);
  });
  const applied = [];
  for (const [className, { properties: props, paths }] of byClass) {
    await runOp(ctx.studio, studioId, "set_properties", { paths, properties: props });
    applied.push({ className, paths, properties: props });
  }
  return { applied };
}

// A handler's result, or an MCP tool error for a ToolError. Any other error is a bug: its stack goes to stderr.
export async function callTool(tool, args, ctx) {
  try {
    return await tool.handler(args ?? {}, ctx);
  } catch (error) {
    if (!(error instanceof ToolError)) console.error(`[roblox-vfx-lab] ${tool.name} crashed:`, error);
    return { ...text(`${tool.name}: ${error.message}`), isError: true };
  }
}

const studioProp = { type: "string", description: "Studio id from Roblox's list_roblox_studios; optional when one Studio is open" };
const pathProp = { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: 'Dotted path ("Workspace.Fx.Emitter") or an array of names' };
const nameProp = { type: "string", description: "Node name in the library, like ring/shock (letters, digits, _ and -)" };
const valuesProp = { type: "object", description: 'Parameter values for this call only: { glow: 2, tint: "#ffaa33", tilt: [0.2, 0] }' };
const clipProps = {
  mode: { type: "string", enum: ["oneshot", "loop"], description: "oneshot (default): frames span phase 0..1 inclusive; loop: phase 1 wraps to frame 0" },
  duration: { type: "number", description: "Clip length in seconds (vfx.time = phase * duration), default 1" },
  margin: { type: "number", description: "Empty border inside each cell, as a share of the cell (0..0.25), default 0.02; 0 for tiling textures" },
  ss: { type: "number", description: "Samples per pixel axis (1..4); default 3 for render, 4 for bake" },
};

export const VFX_TOOLS = [
  {
    name: "vfx_guide",
    description:
      "How to write, render, bake, upload, apply and preview VFX lab nodes (WGSL baked into Roblox textures). " +
      "Without section: the index and the overview. Sections: overview, node, helpers, examples, quality, roblox. Read overview and node first.",
    inputSchema: { type: "object", properties: { section: { type: "string" } } },
    async handler(args) {
      const sections = Object.fromEntries(GUIDE.replace(/\r\n/g, "\n").split(/^## /m).filter(Boolean).map((part) => [part.slice(0, part.indexOf("\n")).trim(), part.slice(part.indexOf("\n") + 1).trim()]));
      if (args.section === undefined) return text(`Sections: ${Object.keys(sections).join(", ")}\n\n${sections.overview}`);
      if (!(args.section in sections)) throw new ToolError(`no section ${args.section}; sections: ${Object.keys(sections).join(", ")}`);
      return text(sections[args.section]);
    },
  },
  {
    name: "vfx_shader_list",
    description:
      "Every node in the VFX library ($VFX_LAB_LIBRARY, default ~/roblox-vfx-lab/shaders): its hash, " +
      "state (clean, or problems at line:column) and parameters with type, range and default. Compiles each on the GPU.",
    inputSchema: { type: "object", properties: {} },
    async handler(_args, ctx) {
      const nodes = [];
      for (const name of listNames(path.join(vfxLibrary(), "shaders"), ".wgsl")) {
        const source = readSource(name);
        nodes.push(verdict(name, source, await checkNode(source, ctx.gpu)));
      }
      return text({ library: vfxLibrary(), nodes });
    },
  },
  {
    name: "vfx_shader_read",
    description: "A node's source, its hash (what vfx_shader_write's replaces names), its state and problems, and its parameters.",
    inputSchema: { type: "object", properties: { name: nameProp }, required: ["name"] },
    async handler(args, ctx) {
      const name = requireString(args, "name");
      const source = readSource(name);
      return text({ ...verdict(name, source, await checkNode(source, ctx.gpu)), source });
    },
  },
  {
    name: "vfx_shader_write",
    description:
      "Creates a node, or replaces one whole. Replacing needs replaces: the hash from vfx_shader_read or your last " +
      "write or edit; if the file changed since, nothing is written and the current hash comes back. Answers the new hash and " +
      "the verdict (state, problems with line:column in your source, parameters). Read vfx_guide node first.",
    inputSchema: {
      type: "object",
      properties: { name: nameProp, source: { type: "string", description: "WGSL that defines fn effect(uv: vec2f) -> vec4f" }, replaces: { type: "string" } },
      required: ["name", "source"],
    },
    async handler(args, ctx) {
      const name = requireString(args, "name");
      const source = requireString(args, "source");
      checkReplaces(name, args.replaces);
      return text(await writeNode(name, source, ctx.gpu));
    },
  },
  {
    name: "vfx_shader_edit",
    description:
      "Changes a node by exact text replacements, applied in order to the latest version, all or nothing. Each old must " +
      "occur exactly once, or at least once with all: true. Answers the new hash and the verdict; the source is not echoed back.",
    inputSchema: {
      type: "object",
      properties: {
        name: nameProp,
        edits: { type: "array", items: { type: "object", properties: { old: { type: "string" }, new: { type: "string" }, all: { type: "boolean" } }, required: ["old", "new"] } },
      },
      required: ["name", "edits"],
    },
    async handler(args, ctx) {
      const name = requireString(args, "name");
      if (!Array.isArray(args.edits) || args.edits.length === 0) throw new ToolError("edits must be a non-empty array of { old, new, all? }");
      const source = args.edits.reduce((current, edit, index) => {
        if (typeof edit?.old !== "string" || edit.old === "" || typeof edit.new !== "string") throw new ToolError(`edit ${index}: old (non-empty) and new must be strings`);
        const count = current.split(edit.old).length - 1;
        if (count === 0 || (count > 1 && !edit.all)) throw new ToolError(`edit ${index}: old occurs ${count} times${count > 1 ? " (set all: true to replace every one)" : ""}; nothing was written`);
        return current.split(edit.old).join(edit.new);
      }, readSource(name));
      return text(await writeNode(name, source, ctx.gpu));
    },
  },
  {
    name: "vfx_render",
    description:
      "Renders a node on the GPU and shows it as one image, cells in reading order with grey lines between them. " +
      "Default: the clip as a flipbook would play it (frames cells across phase 0..1). phases: chosen moments instead. " +
      "sweep: { param, from?, to?, count?, phase? } renders one f32 parameter across a range (default its own range) at one phase. " +
      "Answers per-cell stats (coverage, peak, edge alpha, full-white share, change) and, for a clip, the quality warnings. " +
      "backdrop: dark (default, how it reads in game), light, checker, or alpha (the shape as grey). The file is not changed.",
    inputSchema: {
      type: "object",
      properties: {
        name: nameProp,
        values: valuesProp,
        frames: { type: "number", description: "Cells across the clip, 1..64, default 16" },
        phases: { type: "array", items: { type: "number" }, description: "1..64 phases in 0..1" },
        sweep: { type: "object", properties: { param: { type: "string" }, from: { type: "number" }, to: { type: "number" }, count: { type: "number" }, phase: { type: "number" } }, required: ["param"] },
        size: { type: "number", description: "Image width in px, 128..1024, default 512" },
        backdrop: { type: "string", enum: ["dark", "light", "checker", "alpha"] },
        ...clipProps,
      },
      required: ["name"],
    },
    async handler(args, ctx) {
      const name = requireString(args, "name");
      const node = await loadNode(name, ctx.gpu, vfxLibrary());
      const values = resolveValues(node.params, args.values);
      const mode = choice(args.mode, ["oneshot", "loop"], "mode", "oneshot");
      const duration = numberIn(args.duration, 0.01, 60, "duration", 1);
      const margin = numberIn(args.margin, 0, 0.25, "margin", 0.02);
      const ss = Math.round(numberIn(args.ss, 1, 4, "ss", 3));
      const size = Math.round(numberIn(args.size, 128, 1024, "size", 512));
      const backdrop = choice(args.backdrop, ["dark", "light", "checker", "alpha"], "backdrop", "dark");
      if (args.phases !== undefined && args.sweep !== undefined) throw new ToolError("pass phases or sweep, not both");
      let specs;
      if (args.sweep !== undefined) {
        const param = node.params.find((p) => p.name === args.sweep.param);
        if (!param || param.type !== "f32") throw new ToolError(`sweep.param must name an f32 parameter; the node has: ${node.params.filter((p) => p.type === "f32").map((p) => p.name).join(", ") || "none"}`);
        const from = args.sweep.from ?? param.min;
        const to = args.sweep.to ?? param.max;
        if (typeof from !== "number" || typeof to !== "number") throw new ToolError(`${param.name} has no range: pass sweep.from and sweep.to`);
        const count = Math.round(numberIn(args.sweep.count, 2, 64, "sweep.count", 9));
        const phase = numberIn(args.sweep.phase, 0, 1, "sweep.phase", 0.5);
        specs = Array.from({ length: count }, (_, i) => {
          const value = round(from + ((to - from) * i) / (count - 1), 4);
          return { phase, frame: i, frames: count, duration, values: { ...values, [param.name]: [value] }, label: { [param.name]: value } };
        });
      } else {
        const phases = args.phases ?? clipPhases(Math.round(numberIn(args.frames, 1, 64, "frames", 16)), mode);
        if (!Array.isArray(phases) || phases.length === 0 || phases.length > 64 || !phases.every((p) => typeof p === "number" && p >= 0 && p <= 1)) {
          throw new ToolError("phases must hold 1..64 numbers in 0..1");
        }
        specs = phases.map((phase, i) => ({ phase, frame: i, frames: phases.length, duration, values, label: { phase: round(phase, 4) } }));
      }
      const grid = Math.ceil(Math.sqrt(specs.length));
      const layout = gridLayout({ count: specs.length, grid, cell: Math.floor(size / grid), margin });
      const rgba = await renderCells(ctx.gpu, node, layout, specs, ss);
      const stats = cellStats(rgba, layout.width, layout.rects, layout.pad);
      const clip = args.phases === undefined && args.sweep === undefined;
      const view = drawGrid(composite(rgba, layout.width, layout.height, backdrop), layout.width, layout.height, layout.cell);
      const report = {
        name,
        hash: node.hash,
        grid,
        cell: layout.cell,
        cells: stats.cells.map((cell, i) => ({ ...specs[i].label, ...cell })),
        warnings: clip ? bakeWarnings(stats, { mode, margin, duration }) : [],
      };
      return { content: [imageContent(view, layout.width, layout.height), { type: "text", text: JSON.stringify(report, null, 2) }] };
    },
  },
  {
    name: "vfx_bake",
    description:
      "Renders a node into its final PNG: grid 1 (a still) or a 2x2, 4x4 or 8x8 flipbook sheet at size 256, 512 or 1024, " +
      "or a still sharper than Roblox's 1024 cap as tiles x tiles PNGs of size px (bakes/<out>-<row>-<col>), to lay out in one gui, " +
      "supersampled, straight alpha with the colour spread into transparent pixels (no dark halos). Writes bakes/<out>.png and " +
      "bakes/<out>.json (the recipe: node, hash, values, grid, mode, duration, stats, warnings, uploads). Answers the paths, " +
      "the flipbook settings, the warnings and a preview over the dark backdrop. Upload it with vfx_upload.",
    inputSchema: {
      type: "object",
      properties: {
        name: nameProp,
        values: valuesProp,
        grid: { type: "number", enum: [1, 2, 4, 8], description: "Cells per side: 1 still, 2, 4 (default) or 8" },
        size: { type: "number", enum: [256, 512, 1024], description: "Sheet px, default 1024 (with tiles: each tile's px)" },
        tiles: { type: "number", enum: [1, 2, 3, 4], description: "Still only: render tiles x size px and split it into tiles x tiles PNGs, <out>-<row>-<col> (row 1 at the top). Default 1" },
        out: { type: "string", description: "Bake name, default the node name" },
        ...clipProps,
      },
      required: ["name"],
    },
    async handler(args, ctx) {
      const { recipe, png, rgba, layout, pngFile: pngPath, recipeFile, tiles } = await bakeNode(args, ctx.gpu);
      const factor = Math.max(1, Math.ceil(layout.width / PREVIEW_MAX));
      const small = downscale(composite(rgba, layout.width, layout.height, "dark"), layout.width, layout.height, factor);
      const uploadedId = (r) => r.uploads.find((u) => u.pngSha === r.pngSha)?.assetId ?? null;
      const summary =
        tiles.length > 1
          ? { tiles: tiles.map((t) => ({ bake: t.out, png: t.pngFile, row: t.recipe.tile.row, col: t.recipe.tile.col, uploaded: uploadedId(t.recipe) })), size: layout.width, tile: recipe.size, warnings: recipe.warnings }
          : { png: pngPath, recipe: recipeFile, bytes: png.length, flipbookLayout: recipe.flipbookLayout, frames: recipe.frames, mode: recipe.mode, cell: layout.cell, warnings: recipe.warnings, uploaded: uploadedId(recipe) };
      return { content: [imageContent(drawGrid(small.rgba, small.width, small.height, layout.cell / factor), small.width, small.height), { type: "text", text: JSON.stringify(summary, null, 2) }] };
    },
  },
  {
    name: "vfx_upload",
    description:
      "Uploads a baked PNG through Roblox's own Studio MCP (upload_image, under the Studio user's account) and records the " +
      "asset id in the recipe. Uploads are public, moderated and permanent: only on an explicit request, after the look is " +
      "settled. The same PNG is never uploaded twice: the recorded id comes back unless force is true.",
    inputSchema: { type: "object", properties: { studio_id: studioProp, bake: { type: "string" }, force: { type: "boolean" } }, required: ["bake"] },
    async handler(args, ctx) {
      return text(await uploadBake(requireString(args, "bake"), ctx, { force: args.force === true, studio_id: args.studio_id }));
    },
  },
  {
    name: "vfx_apply",
    description:
      "Puts an uploaded bake (or any texture id) on instances in Studio, with the flipbook settings a sheet needs " +
      "(FlipbookLayout, FlipbookMode, FlipbookFramerate for a loop) on a ParticleEmitter; Texture on a Beam, Trail or Decal, " +
      "TextureID on a MeshPart. targets: existing instances; create: { parent, name?, className? } makes a new one " +
      "(default ParticleEmitter). properties: more values set in the same call (same format as set_properties).",
    inputSchema: {
      type: "object",
      properties: {
        studio_id: studioProp,
        bake: { type: "string", description: "An uploaded bake; its recipe gives the flipbook settings" },
        texture: { type: "string", description: "A texture id instead of a bake (no flipbook settings)" },
        targets: { type: "array", items: pathProp },
        create: { type: "object", properties: { parent: pathProp, name: { type: "string" }, className: { type: "string" } }, required: ["parent"] },
        properties: { type: "object" },
      },
    },
    async handler(args, ctx) {
      if ((args.bake === undefined) === (args.texture === undefined)) throw new ToolError("pass exactly one of bake or texture");
      if ((args.targets === undefined) === (args.create === undefined)) throw new ToolError("pass exactly one of targets or create");
      return text(await applyBake(args, ctx, await pickStudio(args, ctx.studio)));
    },
  },
  {
    name: "vfx_preview",
    description:
      "Plays the ParticleEmitters at or under targets in the Edit viewport and freezes them (TimeScale 0) at each " +
      "moment in at (seconds after the emit), then captures the screen: one image per moment. Burst emitters (Enabled false) " +
      "emit EmitCount (attribute, default 1, or emit) after EmitDelay; Enabled emitters run from empty. The camera frames " +
      "the emitters unless camera_position and look_at_position are given. TimeScales are restored after.",
    inputSchema: {
      type: "object",
      properties: {
        studio_id: studioProp,
        targets: { type: "array", items: pathProp },
        at: { type: "array", items: { type: "number" }, description: "1..8 moments in seconds, default [0.1, 0.3, 0.6]" },
        emit: { type: "number", description: "Particles per burst emitter, overriding EmitCount" },
        camera_position: { type: "array", items: { type: "number" } },
        look_at_position: { type: "array", items: { type: "number" } },
      },
      required: ["targets"],
    },
    async handler(args, ctx) {
      if (!Array.isArray(args.targets) || args.targets.length === 0) throw new ToolError("targets must be a non-empty array of paths");
      const moments = args.at ?? [0.1, 0.3, 0.6];
      if (!Array.isArray(moments) || moments.length === 0 || moments.length > 8 || !moments.every((t) => typeof t === "number" && t >= 0 && t <= 30)) {
        throw new ToolError("at must hold 1..8 moments in 0..30 seconds");
      }
      if ((args.camera_position === undefined) !== (args.look_at_position === undefined)) throw new ToolError("pass both camera_position and look_at_position, or neither");
      const studioId = await pickStudio(args, ctx.studio);
      let timeScales;
      const content = [];
      try {
        for (const [index, at] of moments.entries()) {
          const frozen = await runOp(ctx.studio, studioId, "vfx_freeze", { targets: args.targets, at, emit: args.emit, timeScales });
          timeScales ??= frozen.timeScales;
          const capture = await ctx.studio.call("screen_capture", {
            studio_id: studioId,
            capture_id: `VfxPreview_${index + 1}`,
            camera_position: args.camera_position ?? frozen.camera,
            look_at_position: args.look_at_position ?? frozen.focus,
          });
          if (capture.isError) throw new ToolError(`screen_capture failed: ${resultText(capture)}`);
          content.push({ type: "text", text: `t = ${at}s (${frozen.emitters} emitters)` }, ...capture.content.filter((item) => item.type === "image"));
        }
      } finally {
        if (timeScales) await runOp(ctx.studio, studioId, "vfx_restore", { targets: args.targets, timeScales });
      }
      return { content };
    },
  },
  {
    name: "vfx_delete",
    description:
      "Deletes a node (shaders/<name>.wgsl) or a bake (bakes/<name>.png and its recipe) from the library for good. " +
      "Only on the developer's request: there is no undo. A bake stays when its node is deleted, and an uploaded asset stays on Roblox.",
    inputSchema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["node", "bake"] }, name: nameProp },
      required: ["kind", "name"],
    },
    async handler(args) {
      return text(deleteEntry(args));
    },
  },
];
