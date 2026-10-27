// The local lab page: site/ served on 127.0.0.1 with the library behind it. The page renders nodes live with the
// browser's WebGPU (the browser-safe modules, the same ones a bake runs) and writes the library only through four
// POST routes: /api/bake (auto bake), /api/node (the editor's save), /api/delete and /api/export (Export to Roblox). The library is
// held in memory and kept fresh by fs.watch, which also pushes every change to open pages over server-sent events.
// Started by the vfx_viewer tool, or alone:
//   node src/server.js [port]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolError, checkName } from "./core.js";
import { applyBake, bakeFile, bakeNode, checkReplaces, deleteEntry, listNames, shaderFile, sourceHash, text, uploadBake, vfxLibrary, writeNode } from "./lab.js";
import { pickStudio, runOp } from "./studio.js";

const SELF = fileURLToPath(import.meta.url);
const REPO = path.dirname(path.dirname(SELF));
const DIRS = { site: path.join(REPO, "site"), src: path.join(REPO, "src"), examples: path.join(REPO, "examples") };
const LIB_FILES = new Set(["core.js", "pixels.js", "bake.js", "wgsl.js"]);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wgsl": "text/plain; charset=utf-8",
};
const DEFAULT_PORT = 4518;
const BODY_MAX = 64 * 1024;

export const viewerPort = () => Number(process.env.VFX_LAB_PORT || DEFAULT_PORT);

// The library as the page sees it: node names and hashes, bakes with what the player needs. Rebuilt only after a change.
export function createLibrary(root = vfxLibrary()) {
  const nodes = new Map(); // name -> { hash, source }
  let listing = null;

  const node = (name) => {
    if (!nodes.has(name)) {
      const file = shaderFile(name, root);
      if (!fs.existsSync(file)) return null;
      const source = fs.readFileSync(file, "utf8");
      nodes.set(name, { hash: sourceHash(source), source, readOnly: false });
    }
    return nodes.get(name);
  };

  const recipe = (name) => {
    const file = bakeFile(name, "json", root);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  };

  return {
    root,
    node,
    recipe,
    listing() {
      listing ??= {
        library: root,
        nodes: listNames(path.join(root, "shaders"), ".wgsl").map((name) => ({ name, hash: node(name)?.hash, readOnly: false })),
        bakes: listNames(path.join(root, "bakes"), ".json").map((name) => {
          const r = recipe(name);
          const upload = r.uploads?.find((u) => u.pngSha === r.pngSha);
          return { name, node: r.node, grid: r.grid, frames: r.frames, mode: r.mode, duration: r.duration, size: r.size, pngSha: r.pngSha, warnings: r.warnings?.length ?? 0, assetId: upload?.assetId ?? null };
        }),
      };
      return listing;
    },
    // A file under the library changed: drop what it fed. Answers the change to push, or null for other files.
    invalidate(relative) {
      const [kind, ...rest] = relative.replaceAll("\\", "/").split("/");
      const file = rest.join("/");
      if (kind === "shaders" && file.endsWith(".wgsl")) {
        const name = file.slice(0, -5);
        nodes.delete(name);
        listing = null;
        return { kind: "node", name };
      }
      if (kind === "bakes" && (file.endsWith(".json") || file.endsWith(".png"))) {
        listing = null;
        return { kind: "bake", name: file.replace(/\.(json|png)$/, "") };
      }
      if (kind === "shaders" || kind === "bakes") {
        nodes.clear(); // a folder moved or vanished: start over
        listing = null;
        return { kind: "library" };
      }
      return null;
    },
  };
}

const json = (status, value) => ({ status, type: "application/json; charset=utf-8", body: JSON.stringify(value) });

// A file inside dir, or null: the resolved path must stay inside it.
function inside(dir, relative) {
  const file = path.resolve(dir, relative);
  if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return file;
}

// The static files: site/ at the root, three browser-safe modules at lib/, the examples at examples/.
function staticFile(pathname, dirs) {
  let file = null;
  if (pathname === "/") file = inside(dirs.site, "index.html");
  else if (pathname.startsWith("/lib/")) file = LIB_FILES.has(pathname.slice(5)) ? inside(dirs.src, pathname.slice(5)) : null;
  else if (pathname.startsWith("/examples/")) file = inside(dirs.examples, pathname.slice(10));
  else if (!pathname.slice(1).includes("/")) file = fs.existsSync(dirs.site) && fs.readdirSync(dirs.site).includes(pathname.slice(1)) ? inside(dirs.site, pathname.slice(1)) : null;
  return file && { body: fs.readFileSync(file), type: TYPES[path.extname(file)] ?? "application/octet-stream" };
}

// One GET -> { status, type, body, headers? }. Pure over the library object and the folders, so tests need no socket.
export function route(library, method, rawUrl, headers = {}, dirs = DIRS) {
  if (method !== "GET") return json(405, { error: "GET only; POST goes to /api/bake, /api/node, /api/delete and /api/export" });
  const url = new URL(rawUrl, "http://localhost");
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return json(400, { error: "bad path" });
  }
  // Read per request (well under a millisecond for these files), so an edit to the page shows on reload.
  const asset = staticFile(pathname, dirs);
  if (asset) return { status: 200, type: asset.type, body: asset.body, headers: { "cache-control": "no-cache" } };
  try {
    if (pathname === "/api/library") return json(200, library.listing());
    const name = url.searchParams.get("name");
    if (pathname === "/api/node") {
      const found = library.node(checkName(name, "shader"));
      return found ? json(200, { name, ...found }) : json(404, { error: `no node ${name}` });
    }
    if (pathname === "/api/bake") {
      const found = library.recipe(checkName(name, "bake"));
      return found ? json(200, { name, ...found }) : json(404, { error: `no bake ${name}` });
    }
    if (pathname === "/api/bake.png") {
      const found = library.recipe(checkName(name, "bake"));
      if (!found) return json(404, { error: `no bake ${name}` });
      const etag = `"${found.pngSha}"`;
      if (headers["if-none-match"] === etag) return { status: 304, type: "image/png", body: "", headers: { etag } };
      return { status: 200, type: "image/png", body: fs.readFileSync(bakeFile(name, "png", library.root)), headers: { etag, "cache-control": "no-cache" } };
    }
  } catch (error) {
    if (error instanceof ToolError) return json(400, { error: error.message });
    throw error;
  }
  return json(404, { error: `no route ${pathname}` });
}

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

// The checks every POST passes before any work. Only this server's own page may write: a browser sends Origin on every
// POST and JSON forces a CORS preflight that is never answered, so another site open in the browser cannot write the
// library or upload. The Host check stops DNS rebinding.
function readRequest(headers, body) {
  const host = headers.host ?? "";
  if (!LOOPBACK_HOST.test(host) || (headers.origin !== undefined && headers.origin !== `http://${host}`)) return { answer: json(403, { error: "only the lab page may write" }) };
  if (!String(headers["content-type"] ?? "").startsWith("application/json")) return { answer: json(415, { error: "send application/json" }) };
  if (body === null) return { answer: json(413, { error: `the body is over ${BODY_MAX} bytes` }) };
  let args;
  try {
    args = JSON.parse(body);
  } catch {
    return { answer: json(400, { error: "the body is not JSON" }) };
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return { answer: json(400, { error: "the body must be a JSON object" }) };
  return { args };
}

const POSTS = {
  // One bake, the body is vfx_bake's arguments.
  async "/api/bake"(library, ctx, args) {
    const started = performance.now();
    const { out, recipe, png } = await bakeNode(args, ctx.gpu, library.root);
    return json(200, { name: out, ms: Math.round(performance.now() - started), bytes: png.length, recipe });
  },
  // The editor's save: { name, source, replaces }, with vfx_shader_write's stale rule. A source with problems is saved
  // and its problems come back; nothing renders from it.
  async "/api/node"(library, ctx, args) {
    const name = checkName(args.name, "shader");
    if (typeof args.source !== "string") throw new ToolError("source must be a string");
    try {
      checkReplaces(name, args.replaces, library.root);
    } catch (error) {
      if (error instanceof ToolError) return json(409, { error: error.message });
      throw error;
    }
    return json(200, await writeNode(name, args.source, ctx.gpu, library.root));
  },
  // The page's Delete: { kind: "node" | "bake", name }. fs.watch then tells every open page.
  async "/api/delete"(library, ctx, args) {
    return json(200, deleteEntry(args, library.root));
  },
  // Export to Roblox: { bake, studio_id? }. Uploads the sheet (or reuses its recorded id), then puts it on the
  // emitters selected in Studio, or on a new ParticleEmitter under the selected part or attachment.
  async "/api/export"(library, ctx, args) {
    const bake = checkName(args.bake, "bake");
    let studioId;
    try {
      studioId = await pickStudio(args, ctx.studio);
    } catch (error) {
      if (error.studios) return json(409, { error: error.message, studios: error.studios });
      throw error;
    }
    const upload = await uploadBake(bake, ctx, { studio_id: studioId, library: library.root });
    const selection = await runOp(ctx.studio, studioId, "vfx_selection", {});
    let result;
    if (selection.targets.length > 0) result = await applyBake({ bake, targets: selection.targets.map((t) => t.path) }, ctx, studioId, library.root);
    else if (selection.parent) result = await applyBake({ bake, create: { parent: selection.parent } }, ctx, studioId, library.root);
    else return json(400, { error: "select a part, an attachment or an emitter in Studio" });
    return json(200, { assetId: upload.assetId, reused: upload.reused, ...result });
  },
};

// One POST -> answer. body is the request text, or null when it was over the limit.
export async function postRequest(library, ctx, rawUrl, headers, body) {
  const handler = POSTS[new URL(rawUrl, "http://localhost").pathname];
  if (!handler) return json(404, { error: `no POST route ${rawUrl}` });
  const { answer, args } = readRequest(headers, body);
  if (answer) return answer;
  try {
    return await handler(library, ctx, args);
  } catch (error) {
    if (error instanceof ToolError) return json(400, { error: error.message });
    throw error;
  }
}

// The body as text, or null past the limit (read to the end either way, so the answer still reaches the page).
async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  }
  return size <= limit ? Buffer.concat(chunks).toString("utf8") : null;
}

let running = null; // { url, close } while this process serves the lab

// Starts the lab page once per process. A port held by another lab is that lab's URL; a port held by anything else is
// an error naming the variable that moves it.
export async function startViewer({ port = viewerPort(), library = createLibrary(), keepAlive = false, ctx } = {}) {
  if (running) return { url: running.url, reused: false };
  fs.mkdirSync(library.root, { recursive: true });
  const clients = new Set();
  const failed = (request, error) => {
    console.error("[roblox-vfx-lab] request failed:", request.method, request.url, error);
    return json(500, { error: error.message });
  };
  const send = (response, answer) => {
    response.writeHead(answer.status, { "content-type": answer.type, ...answer.headers });
    response.end(answer.body);
  };
  const server = http.createServer((request, response) => {
    if (request.url === "/api/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      response.write("retry: 1000\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (request.method === "POST") {
      readBody(request, BODY_MAX)
        .then((body) => postRequest(library, ctx, request.url, request.headers, body))
        .catch((error) => failed(request, error))
        .then((answer) => send(response, answer));
      return;
    }
    let answer;
    try {
      answer = route(library, request.method, request.url, request.headers);
    } catch (error) {
      answer = failed(request, error);
    }
    send(response, answer);
  });
  const url = `http://127.0.0.1:${port}/`;
  try {
    await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    const other = await fetch(`${url}api/library`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null);
    if (other?.nodes) return { url, reused: true, library: other.library };
    throw new ToolError(`port ${port} is taken by another program; set VFX_LAB_PORT to a free port`);
  }
  let pending = new Map();
  let timer = null;
  const watcher = fs.watch(library.root, { recursive: true }, (_event, file) => {
    if (!file) return;
    const change = library.invalidate(file);
    if (!change) return;
    pending.set(`${change.kind}:${change.name ?? ""}`, change);
    timer ??= setTimeout(() => {
      // Editors and bakes write in bursts: one push per 40 ms window.
      const frame = `event: change\ndata: ${JSON.stringify([...pending.values()])}\n\n`;
      pending = new Map();
      timer = null;
      for (const client of clients) client.write(frame);
    }, 40);
  });
  if (!keepAlive) {
    server.unref();
    watcher.unref();
  }
  running = {
    url,
    close() {
      watcher.close();
      for (const client of clients) client.end();
      server.close();
      running = null;
    },
  };
  return { url, reused: false };
}

export const stopViewer = () => running?.close();

export const VIEWER_TOOLS = [
  {
    name: "vfx_viewer",
    description:
      "Starts the local lab page (once per machine) and answers its URL, for the artist to open in a WebGPU browser (Chrome, Edge, Safari 26, Firefox 141 on Windows). " +
      "It renders every node live with WebGPU (play, scrub, parameter sliders, flipbook sheet view, alpha view), has a " +
      "WGSL editor, plays baked sheets as Roblox plays them, and has Export to Roblox (upload, then apply to the Studio " +
      "selection). It follows the library live: a node or bake that changes updates the open page. With Auto bake on, " +
      "the page re-bakes bakes/<node>.png after each change the artist makes. Port: $VFX_LAB_PORT, default 4518.",
    inputSchema: { type: "object", properties: {} },
    async handler(_args, ctx) {
      const started = await startViewer({ ctx });
      return text({ ...started, library: started.library ?? vfxLibrary() });
    },
  },
];

if (path.resolve(process.argv[1] ?? "") === SELF) {
  const [{ gpu }, { createStudio }] = await Promise.all([import("./gpu.js"), import("./studio.js")]);
  const port = process.argv[2] ? Number(process.argv[2]) : viewerPort();
  startViewer({ port, keepAlive: true, ctx: { gpu, studio: createStudio() } })
    .then(({ url, reused }) => console.log(reused ? `a lab already runs at ${url}` : `Roblox VFX Lab at ${url} (library ${vfxLibrary()})`))
    .catch((error) => {
      console.error("[roblox-vfx-lab] failed to start the page:", error.message);
      process.exit(1);
    });
}
