// The lab in the browser alone (GitHub Pages): the examples are read-only nodes and bakes fetched from the site, the
// artist's own nodes and bakes live in the kv (IndexedDB), and bakes run on the browser's WebGPU with the same
// bakeSheet as the MCP. There is no Export to Roblox here: the upload needs the Studio MCP on the artist's machine.
import { ToolError, checkName } from "./lib/core.js";
import { bakeSheet, checkNode, requireClean } from "./lib/bake.js";
import { pngFile, pngRows } from "./lib/pixels.js";

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes) => hex(await crypto.subtle.digest("SHA-256", bytes));
// Same as the MCP's sourceHash: the first 12 hex digits of the source's SHA-256.
const sourceHash = async (source) => (await sha256(new TextEncoder().encode(source))).slice(0, 12);
const deflate = async (bytes) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());

async function fetchOk(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response;
}

export async function createHostedBackend({
  kv,
  gpu,
  base = "./",
  fetchJson = async (file) => (await fetchOk(`${base}${file}`)).json(),
  fetchBytes = async (file) => new Uint8Array(await (await fetchOk(`${base}${file}`)).arrayBuffer()),
  now = () => new Date(),
}) {
  const examples = await fetchJson("examples/index.json");
  const exampleNodes = new Map();
  for (const entry of examples) {
    if (exampleNodes.has(entry.node)) continue;
    const source = new TextDecoder().decode(await fetchBytes(entry.wgsl));
    exampleNodes.set(entry.node, { name: entry.node, source, hash: await sourceHash(source), readOnly: true });
  }
  const exampleBakes = new Map(examples.map((entry) => [entry.name, entry]));
  const exampleRecipes = new Map();
  const sheetUrls = new Map(); // bake name -> { pngSha, url } for bakes made here
  const listeners = [];
  const notify = (changes) => listeners.forEach((listener) => queueMicrotask(() => listener(changes)));

  async function node(name) {
    if (exampleNodes.has(name)) return { ...exampleNodes.get(name) };
    const saved = await kv.get("nodes", name);
    return saved ? { name, source: saved.source, hash: saved.hash, readOnly: false } : null;
  }

  async function recipe(name) {
    const saved = await kv.get("bakes", name);
    if (saved) return { name, ...saved.recipe };
    const entry = exampleBakes.get(name);
    if (!entry) return null;
    if (!exampleRecipes.has(name)) exampleRecipes.set(name, await fetchJson(entry.recipe));
    return { name, ...exampleRecipes.get(name) };
  }

  return {
    mode: "hosted",
    persistent: kv.persistent,
    location: kv.persistent ? "Saved in this browser" : "This window does not save: storage is blocked",
    examples,
    async listing() {
      const mine = await Promise.all((await kv.keys("nodes")).map(async (name) => ({ name, hash: (await kv.get("nodes", name)).hash, readOnly: false })));
      const nodes = [...[...exampleNodes.values()].map(({ name, hash }) => ({ name, hash, readOnly: true })), ...mine].sort((a, b) => a.name.localeCompare(b.name));
      const baked = new Map();
      for (const entry of examples) {
        baked.set(entry.name, { name: entry.name, node: entry.node, grid: entry.grid, frames: entry.frames, mode: entry.mode, duration: entry.duration, size: entry.bake.size, warnings: [], assetId: null, readOnly: true });
      }
      for (const name of await kv.keys("bakes")) {
        const { recipe: r } = await kv.get("bakes", name);
        baked.set(name, { name, node: r.node, grid: r.grid, frames: r.frames, mode: r.mode, duration: r.duration, size: r.size, pngSha: r.pngSha, warnings: r.warnings, assetId: null, readOnly: false });
      }
      return { nodes, bakes: [...baked.values()].sort((a, b) => a.name.localeCompare(b.name)) };
    },
    node,
    async saveNode({ name, source, replaces }) {
      checkName(name, "shader");
      if (exampleNodes.has(name)) throw new ToolError("examples are read-only; Duplicate it first");
      if (typeof source !== "string") throw new ToolError("source must be a string");
      const current = await kv.get("nodes", name);
      if (current && current.hash !== replaces) throw new ToolError(`stale: ${name} exists with hash ${current.hash}; open it again before you save`);
      const hash = await sourceHash(source);
      const check = gpu ? await checkNode(source, gpu) : { state: "unchecked", params: [], problems: [] };
      await kv.put("nodes", name, { source, hash });
      notify([{ kind: "node", name }]);
      return { name, hash, state: check.state, problems: check.problems, params: check.params };
    },
    recipe,
    // Delete: the artist's own nodes and bakes only. A bake made here of an example's name hides that example's
    // sheet; deleting it shows the example again, so only a bake with no example under it counts as read-only.
    async remove({ kind, name }) {
      if (kind !== "node" && kind !== "bake") throw new ToolError(`kind must be node or bake, got ${JSON.stringify(kind)}`);
      const store = kind === "node" ? "nodes" : "bakes";
      const saved = await kv.get(store, name);
      if (!saved && (kind === "node" ? exampleNodes : exampleBakes).has(name)) throw new ToolError("examples are read-only");
      if (!saved) throw new ToolError(`no ${kind} ${name}`);
      await kv.delete(store, name);
      if (kind === "bake" && sheetUrls.has(name)) {
        URL.revokeObjectURL(sheetUrls.get(name).url);
        sheetUrls.delete(name);
      }
      notify([{ kind, name }]);
      return { kind, name };
    },
    async sheetUrl(name, r) {
      const saved = await kv.get("bakes", name);
      if (!saved) return `${base}${exampleBakes.get(name).png}?v=${r?.pngSha ?? ""}`;
      const known = sheetUrls.get(name);
      if (known?.pngSha === saved.recipe.pngSha) return known.url;
      if (known) URL.revokeObjectURL(known.url);
      const url = URL.createObjectURL(new Blob([saved.png], { type: "image/png" }));
      sheetUrls.set(name, { pngSha: saved.recipe.pngSha, url });
      return url;
    },
    async bake(call) {
      if (!gpu) throw new ToolError("this browser has no WebGPU, and bakes need it: open the lab in Chrome, Edge, Safari 26 or Firefox 141 on Windows");
      const started = performance.now();
      const name = checkName(call.name, "shader");
      const out = checkName(call.out ?? name, "bake");
      if ((call.tiles ?? 1) > 1) throw new ToolError("tiles is an MCP option (vfx_bake); the page bakes whole sheets");
      const found = await node(name);
      if (!found) throw new ToolError(`no node ${name}`);
      const clean = await requireClean(name, found.source, gpu);
      const sheet = await bakeSheet({ name, hash: found.hash, ...clean }, call, gpu);
      const { width, height } = sheet.layout;
      const png = pngFile(width, height, await deflate(pngRows(sheet.rgba, width, height)));
      const r = { ...sheet.base, pngSha: await sha256(png), bakedAt: now().toISOString(), warnings: sheet.warnings, stats: sheet.stats.cells, uploads: [] };
      await kv.put("bakes", out, { recipe: r, png });
      notify([{ kind: "bake", name: out }]);
      return { name: out, ms: Math.round(performance.now() - started), bytes: png.length, recipe: r };
    },
    subscribe(onChange) {
      listeners.push(onChange);
    },
  };
}
