# roblox-vfx-lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public repo `NevelStudios/roblox-vfx-lab` with an MCP server, a hosted site and examples that give Roblox VFX artists the studio-hub VFX lab, with export through Roblox's own Studio MCP.

**Architecture:** One npm package of plain ES modules, no build step. Three browser-safe modules (`src/core.js`, `src/pixels.js`, `src/bake.js`) hold every decision about nodes, pixels and bakes; the Node MCP (`src/lab.js`, `src/gpu.js`, `src/studio.js`, `src/server.js`, `src/index.js`) and the page (`site/*.js`) both call them. The page runs on two backends behind one interface: the local server (disk library, Dawn bakes, Export to Roblox) or the browser (IndexedDB, WebGPU bakes).

**Tech Stack:** Node 20+, `@modelcontextprotocol/sdk` 1.27.1, `webgpu` 0.6.2 (Dawn), WGSL, WebGPU in the browser, `node --test`, GitHub Actions, GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-10-27-roblox-vfx-lab-design.md`

**Two refinements of the spec:** the page is split into `site/index.html` plus small modules (the studio-hub page is 1,236 lines before the editor, export, gallery and hosted backend), and a third browser-safe module, `src/bake.js`, holds the bake steps so the hosted page bakes with the same code as the MCP. Pages therefore copies `src/bake.js` too.

**Source to port:** `E:\nevel\tools\studio-mcp-hub\` files `vfx-core.js`, `vfx.js`, `vfx-gpu.js`, `vfx-viewer.js`, `vfx-viewer.html`, `vfx-guide.md`, `vfx.test.js`, `vfx-viewer.test.js`, `smoke-vfx.js`, `common.js`, and the ops `get_properties`, `set_properties`, `create_instances` (with their helpers) in `studio-ops.luau`, `vfx_freeze` and `vfx_restore` in `studio-ops-extra.luau`. Read only; never edit studio-hub.

## Global Constraints

- Repo root: `E:\roblox-vfx-lab`, branch `main`. License MIT, copyright "Nevel Studios".
- `package.json`: `"name": "roblox-vfx-lab"`, `"type": "module"`, `"bin": { "roblox-vfx-lab": "src/index.js" }`, `"engines": { "node": ">=20" }`, dependencies exactly `@modelcontextprotocol/sdk` 1.27.1 and `webgpu` 0.6.2. No other runtime dependency; no dev dependency.
- `src/core.js`, `src/pixels.js`, `src/bake.js` import nothing from Node and nothing outside these three files.
- Env: `VFX_LAB_LIBRARY` (default `~/roblox-vfx-lab`), `VFX_LAB_PORT` (default `4518`), `ROBLOX_STUDIO_MCP` (a full command line).
- Studio launch: Windows `cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat`; macOS `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP` (no args; confirmed on https://create.roblox.com/docs/studio/mcp).
- Tool names and arguments match studio-hub: `vfx_guide`, `vfx_shader_list`, `vfx_shader_read`, `vfx_shader_write`, `vfx_shader_edit`, `vfx_render`, `vfx_bake`, `vfx_upload`, `vfx_apply`, `vfx_preview`, `vfx_viewer` (11 tools).
- Bake limits: grid 1/2/4/8, size 256/512/1024, tiles 1..4, margin 0..0.25 (default 0.02), duration 0.01..60, edge limit 0.02, Roblox loop cap 30 fps.
- No IP names (Jujutsu Kaisen, JJK, Rick, Morty, character names) anywhere in the repo.
- Every expected failure is a `ToolError` with cause and next step. No silent fallback.
- Every page URL is relative (`./lib/core.js`, `./examples/index.json`), so one page works at `https://nevelstudios.github.io/roblox-vfx-lab/` and `http://127.0.0.1:4518/`.
- Commits: Conventional Commits, stage files by explicit path.

## Review Focus

1. A library path with spaces or non-ASCII characters (Windows user names): every file read, write and watch works. Test in Task 2.
2. The Studio MCP is missing or exits mid-call: the call fails with a `ToolError` that names `ROBLOX_STUDIO_MCP`, and the next call starts a new child. Test in Task 3.
3. Two Studio windows are open when the artist clicks Export to Roblox: the page asks which one; it never picks one at random. Test in Task 5.
4. Hosted mode in a private window (IndexedDB blocked): the page still opens examples and bakes, and says that nothing is saved. Test in Task 8.
5. A node saved from the editor with a compile error: the file is saved, the problems show at their lines, the last good pipeline stays on screen, and no bake runs from the broken source. Test in Task 7.

---

### Task 1: Browser-safe core and pixels

**Files:**
- Create: `package.json`, `LICENSE`, `.gitignore` (`node_modules/`, `_site/`)
- Create: `src/core.js`, `src/pixels.js`
- Test: `test/core.test.js`, `test/pixels.test.js`

**Interfaces:**
- Produces, `src/core.js`: `ToolError` (class), `PARAM_TYPES`, `round(value, digits = 3)`, `coerceValue(param, value)`, `parseParams(source) -> { params, problems }`, `resolveValues(params, overrides) -> { [name]: number[] }`, `buildModule(source, params) -> { code, lineOffset }`, `mapMessages(messages, lineOffset, sourceLines)`, `gridLayout({ count, grid, cell, margin }) -> { width, height, cell, pad, rects }`, `clipPhases(frames, mode) -> number[]`, `cellUniforms({ rect, pad, ss, phase, duration, frame, frames, params, values }) -> Float32Array`, `checkName(name, label) -> string` (pattern `/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/i`), `textureProperties(className, recipe, uri) -> object`, `assetUri(value) -> string`. All bodies as in studio-hub `vfx-core.js` and `vfx.js`.
- Produces, `src/pixels.js`: `dilate(rgba, width, rects)`, `cellStats(rgba, width, rects, pad) -> { cells, wrap }`, `bakeWarnings(stats, { mode, margin, duration }) -> string[]`, `composite(rgba, width, height, backdrop)`, `drawGrid(rgba, width, height, cell)`, `downscale(rgba, width, height, factor)`, `crop(rgba, width, x0, y0, w, h)`, `crc32(bytes) -> number`, `pngRows(rgba, width, height) -> Uint8Array` (filter byte 0 per row), `pngFile(width, height, idat) -> Uint8Array`, `apngFile(width, height, frames: Uint8Array[], delayMs) -> Uint8Array` (each frame is already-deflated rows), `EDGE_LIMIT = 0.02`, `ROBLOX_MAX_FPS = 30`. All return `Uint8Array`, never `Buffer`.

- [ ] **Step 1: Write the failing tests**

Port every pure test of studio-hub `vfx.test.js` (lines 49 to 217: parseParams, resolveValues, buildModule, gridLayout, clipPhases, cellUniforms, dilate, cellStats and bakeWarnings, the 30 fps warning, textureProperties, shader names) to import from `../src/core.js` and `../src/pixels.js`. Add:

```js
test("pngFile with zlib-deflated rows decodes back to the same RGBA", () => {
  const rgba = Uint8Array.from({ length: 4 * 4 * 4 }, (_, i) => (i * 37) % 256);
  const png = pngFile(4, 4, zlib.deflateSync(pngRows(rgba, 4, 4)));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png instanceof Uint8Array && !Buffer.isBuffer(png));
  // decode: read IDAT, inflate, drop the filter byte per row
  assert.deepEqual(decodeRgba(png), rgba);
});
test("crc32 matches zlib.crc32", () => {
  for (const s of ["", "IEND", "hello vfx"]) assert.equal(crc32(new TextEncoder().encode(s)), zlib.crc32(s));
});
test("apngFile writes acTL, then fcTL+IDAT, then fcTL+fdAT with rising sequence numbers", () => {
  const frame = zlib.deflateSync(pngRows(new Uint8Array(2 * 2 * 4), 2, 2));
  const types = chunkTypes(apngFile(2, 2, [frame, frame, frame], 50));
  assert.deepEqual(types, ["IHDR", "acTL", "fcTL", "IDAT", "fcTL", "fdAT", "fcTL", "fdAT", "IEND"]);
  assert.deepEqual(sequenceNumbers(apngFile(2, 2, [frame, frame, frame], 50)), [0, 1, 2, 3, 4]);
});
test("core and pixels import nothing from node", () => {
  for (const file of ["core.js", "pixels.js"]) assert.doesNotMatch(fs.readFileSync(`src/${file}`, "utf8"), /from "node:/);
});
```

`decodeRgba`, `chunkTypes`, `sequenceNumbers` are test helpers in `test/pixels.test.js` (walk the chunk list; `zlib.inflateSync` for IDAT).

- [ ] **Step 2: Run the tests, expect failure**

Run: `node --test test/` — Expected: FAIL, cannot find `../src/core.js`.

- [ ] **Step 3: Create `package.json`, `LICENSE`, `.gitignore`, then port `src/core.js` and `src/pixels.js`**

`package.json` scripts: `"start": "node src/index.js"`, `"test": "node --test test/"`, `"smoke": "node scripts/examples.js --check"`, `"examples": "node scripts/examples.js"`. Run `npm install` to write `package-lock.json`. In `apngFile`: `acTL` has num_frames and num_plays 0; each `fcTL` has the full frame size, offset 0,0, delay `delayMs/1000` as num `delayMs`, den `1000`, dispose 0, blend 0; frame 0 data goes in `IDAT`, later frames in `fdAT` with a sequence number before the data.

- [ ] **Step 4: Run the tests, expect pass**

Run: `npm test` — Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json LICENSE .gitignore src/core.js src/pixels.js test/core.test.js test/pixels.test.js
git commit -m "feat: browser-safe node core and pixel encoders"
```

### Task 2: Bake pipeline, library and the GPU tools

**Files:**
- Create: `src/bake.js`, `src/lab.js`, `src/gpu.js`, `src/guide.md`
- Test: `test/lab.test.js`, `test/fake-gpu.js`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces, `src/bake.js` (browser-safe):
  - `BAKE_GRIDS = [1, 2, 4, 8]`, `BAKE_SIZES = [256, 512, 1024]`, `BAKE_TILES = [1, 2, 3, 4]`
  - `bakeOptions(args) -> { grid, size, mode, duration, margin, ss, tiles }` (defaults 4, 1024, "oneshot", 1, 0.02, 4, 1; `ToolError` on bad values; tiles > 1 needs grid 1)
  - `checkNode(source, gpu) -> Promise<{ state: "clean" | "problems", params, problems }>`
  - `requireClean(name, source, gpu) -> Promise<{ source, params }>` (`ToolError` naming `line:column message` of each problem)
  - `renderCells(gpu, node, layout, specs, ss) -> Promise<Uint8Array>` (dilated)
  - `bakeSheet({ name, hash, source, params }, args, gpu) -> Promise<{ options, values, layout, rgba, stats, warnings, base }>`; `base` is the recipe fields `node, nodeHash, values, grid, size, frames, mode, duration, margin, ss, flipbookLayout`
  - `bakeTiles(sheet) -> [{ row, col, rgba, width, height }]` (one entry when tiles is 1)
  - `GPU interface`: `{ compile(code) -> Promise<messages[]>, render({ code, width, height, cells: [{ rect, uniforms }] }) -> Promise<Uint8Array> }`
- Produces, `src/lab.js` (Node):
  - `vfxLibrary() -> string` (`VFX_LAB_LIBRARY` or `path.join(os.homedir(), "roblox-vfx-lab")`)
  - `shaderFile(name, library)`, `bakeFile(name, ext, library)`, `sourceHash(source) -> 12 hex`, `listNames(dir, ext)`, `readRecipe(name, library)`
  - `encodePngNode(rgba, width, height) -> Uint8Array` (`pngFile` + `zlib.deflateSync(rows, { level: 1 })`)
  - `bakeNode(args, gpu, library) -> Promise<{ out, recipe, png, rgba, layout, pngFile, recipeFile, tiles }>` (same files and recipe as studio-hub; keeps `uploads` from the previous recipe)
  - `VFX_TOOLS`: tool objects `{ name, description, inputSchema, handler(args, ctx) }` for the 11 tools; `ctx = { gpu, studio }`. This task implements the 7 tools with no Studio; Task 3 adds `vfx_upload`, `vfx_apply`, `vfx_preview`; Task 5 adds `vfx_viewer`.
  - `callTool(tool, args, ctx)`: returns the handler's result, or `{ content: [text], isError: true }` for a `ToolError` (other errors also log their stack to stderr).
- Produces, `src/gpu.js`: `gpu` with the GPU interface (Dawn in a child process), as studio-hub `vfx-gpu.js`.
- `src/guide.md`: studio-hub `vfx-guide.md` with `$STUDIO_HUB_VFX_LIBRARY` and `~/.studio-mcp-hub/vfx-library` replaced by `$VFX_LAB_LIBRARY` and `~/roblox-vfx-lab`, the viewer URL text pointing at `vfx_viewer` and the hosted site URL, and "through Studio" meaning Roblox's Studio MCP.

- [ ] **Step 1: Write the failing tests**

`test/fake-gpu.js` exports `fakeGpu(messages = [])`, the disk-per-cell fake of studio-hub `vfx.test.js` lines 20 to 39. `test/lab.test.js` ports studio-hub tests "write, edit and read keep hashes honest", "render shows a clip, a sweep or chosen phases", "bake tiles a still", "guide sections are reachable", and the bake part of "bake writes the sheet and recipe" (to the recipe assertions). Each test sets `process.env.VFX_LAB_LIBRARY` to `fs.mkdtempSync(path.join(os.tmpdir(), "vfx lab ü-"))` (a space and a non-ASCII letter: Review Focus 1). Add:

```js
test("bakeSheet in bake.js gives the same pixels and warnings as bakeNode writes", async () => {
  const gpu = fakeGpu();
  const node = { name: "fx/ring", hash: sourceHash(NODE), source: NODE, ...(await requireClean("fx/ring", NODE, gpu)) };
  const sheet = await bakeSheet(node, { grid: 2, size: 256 }, gpu);
  writeNode("fx/ring", NODE);
  const written = await bakeNode({ name: "fx/ring", grid: 2, size: 256 }, gpu, vfxLibrary());
  assert.deepEqual(written.rgba, sheet.rgba);
  assert.deepEqual(written.recipe.warnings, sheet.warnings);
});
test("bake.js imports nothing from node", () => assert.doesNotMatch(fs.readFileSync("src/bake.js", "utf8"), /from "node:/));
```

- [ ] **Step 2: Run, expect failure** — `npm test`, FAIL on missing `src/lab.js`.

- [ ] **Step 3: Write `src/bake.js`, `src/lab.js`, `src/gpu.js`, `src/guide.md`**

`bakeNode` calls `bakeOptions`, `requireClean`, `bakeSheet`, `bakeTiles`, then hashes and writes files. Tool handlers use `ctx.gpu`.

- [ ] **Step 4: Run, expect pass** — `npm test`, all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bake.js src/lab.js src/gpu.js src/guide.md test/lab.test.js test/fake-gpu.js
git commit -m "feat: bake pipeline, node library and GPU tools"
```

### Task 3: Roblox Studio MCP client and the Studio tools

**Files:**
- Create: `src/studio.js`, `src/studio-ops.luau`
- Modify: `src/lab.js` (add `vfx_upload`, `vfx_apply`, `vfx_preview`, `uploadBake`, `applyBake`)
- Test: `test/studio.test.js`, `test/fake-studio.js`

**Interfaces:**
- Consumes: `readRecipe`, `bakeFile`, `textureProperties`, `assetUri`, `checkName` (Tasks 1 and 2).
- Produces, `src/studio.js`:
  - `studioLaunch({ platform = process.platform, env = process.env, exists = fs.existsSync }) -> { command, args }`: `ROBLOX_STUDIO_MCP` first (split on spaces outside double quotes), then the Windows and macOS commands of Global Constraints (checked with `exists`), else `ToolError` "no Roblox Studio MCP found at <path>; install Roblox Studio or set ROBLOX_STUDIO_MCP".
  - `createStudio({ launch = studioLaunch, connect = connectStdio }) -> { call(name, args) -> Promise<result>, close() }`: starts the child at the first `call`; when the child exits, pending calls reject with a `ToolError` that has the exit code, and the next `call` starts a new child. `connect({ command, args })` returns an SDK `Client`.
  - `listStudios(studio) -> Promise<[{ id, name }]>`: parses the JSON in `list_roblox_studios`'s text answer.
  - `pickStudio(args, studio) -> Promise<string>`: `args.studio_id` if given; else the only open studio; else `ToolError` "studio_id is required. Open studios: <name (id), ...>" (none open: "open a place in Roblox Studio").
  - `opCode(op, args) -> string` and `runOp(studio, studioId, op, args) -> Promise<any>`: studio-hub `opCode` and `runLuau` (Edit datamodel, `CommandExecution:N:` prefix removed, JSON answer parsed).
- Produces, `src/lab.js`:
  - `uploadBake(name, ctx, { force, studioId }) -> Promise<{ bake, assetId, texture, reused }>` (one-time `http://127.0.0.1` URL to `upload_image`, as studio-hub)
  - `applyBake({ bake, texture, targets, create, properties }, ctx, studioId) -> Promise<{ applied } | { created, className, properties }>`
  - `vfx_upload`, `vfx_apply`, `vfx_preview` handlers as studio-hub, with `pickStudio` in place of `requireStudio` and `ctx.studio` in place of `ctx.call("official", …)`.
- Produces, `src/studio-ops.luau`: ops `get_properties`, `set_properties`, `create_instances`, `vfx_freeze`, `vfx_restore` (with the helpers they use, copied), plus `vfx_selection` that answers `{ targets: [{ path, className }], parent: path | null }`: selected ParticleEmitter, Beam, Trail, Decal, Texture or MeshPart go in `targets`; else the first selected BasePart or Attachment is `parent`; paths as arrays of names from the service down.

- [ ] **Step 1: Write the failing tests**

`test/fake-studio.js` exports `fakeStudio({ studios, luau })`: `call("list_roblox_studios")` answers `JSON.stringify(studios)` as text; `call("upload_image", { imagePaths })` fetches the URL, records the bytes and answers `{"<url>": "rbxassetid://987"}` as text; `call("execute_luau", { code })` answers `luau(code)`; `call("screen_capture")` answers one image. Port studio-hub's upload, apply and preview tests (`vfx.test.js` lines 269 to 365) onto it. Add:

```js
test("studioLaunch prefers ROBLOX_STUDIO_MCP, then the platform command, else names the variable", () => {
  assert.deepEqual(studioLaunch({ env: { ROBLOX_STUDIO_MCP: '"C:\\My Tools\\mcp.exe" --stdio' } }), { command: "C:\\My Tools\\mcp.exe", args: ["--stdio"] });
  assert.deepEqual(studioLaunch({ platform: "darwin", env: {}, exists: () => true }), { command: "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP", args: [] });
  assert.equal(studioLaunch({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, exists: () => true }).args.at(-1), "C:\\L\\Roblox\\mcp.bat");
  assert.throws(() => studioLaunch({ platform: "linux", env: {}, exists: () => false }), /ROBLOX_STUDIO_MCP/);
});
test("a child that exits fails the pending call and the next call starts a new one", async () => { /* connect fake: first client's callTool rejects after emitting close; assert ToolError /exited/, then a second call resolves and connect ran twice */ });
test("pickStudio uses the only studio, and lists them when several are open", async () => { /* 1 studio -> its id; 2 -> ToolError listing both names; 0 -> /open a place/ */ });
test("render and bake never start Studio", async () => { /* createStudio with a connect that throws; vfx_render and vfx_bake pass */ });
```

- [ ] **Step 2: Run, expect failure** — `npm test`, FAIL on missing `src/studio.js`.

- [ ] **Step 3: Write `src/studio.js`, `src/studio-ops.luau`, the three tools in `src/lab.js`**

- [ ] **Step 4: Run, expect pass** — `npm test`, all PASS.

- [ ] **Step 5: Live check of the answer format**

With Roblox Studio open: `node -e "import('./src/studio.js').then(async ({ createStudio, listStudios }) => { const s = createStudio(); console.log(await listStudios(s)); s.close(); })"`. Expected: an array of `{ id, name }`. If the text is not JSON, fix `listStudios` and its fake to the real format and rerun Step 4.

- [ ] **Step 6: Commit**

```bash
git add src/studio.js src/studio-ops.luau src/lab.js test/studio.test.js test/fake-studio.js
git commit -m "feat: upload, apply and preview through Roblox's Studio MCP"
```

### Task 4: MCP entry, first-start examples and the stdio smoke

**Files:**
- Create: `src/index.js`, `scripts/smoke-mcp.js`
- Modify: `src/lab.js` (add `seedLibrary`)
- Test: `test/index.test.js`

**Interfaces:**
- Consumes: `VFX_TOOLS`, `callTool` (Task 2), `createStudio` (Task 3), `gpu` (Task 2).
- Produces: `seedLibrary(library, examplesDir) -> { copied: number }`: only when `<library>/shaders` does not exist; copies `examples/<c>/<n>.wgsl` to `shaders/<c>/<n>.wgsl` and `.png`/`.json` to `bakes/`; never overwrites. `src/index.js`: shebang `#!/usr/bin/env node`; MCP `Server` named `roblox-vfx-lab` with the package version; `ListTools` answers the 11 tools; `CallTool` routes to `callTool(tool, args, { gpu, studio })`; calls `seedLibrary(vfxLibrary(), <repo>/examples)` before connecting stdio; nothing writes to stdout except the transport.

- [ ] **Step 1: Write the failing tests**

```js
test("seedLibrary copies examples into an empty library only", () => { /* temp examples dir with impact/a.wgsl, a.png, a.json -> copied 3; second call -> copied 0; an edited shaders/impact/a.wgsl is not overwritten */ });
test("the server lists 11 tools over stdio and answers vfx_guide", async () => { /* spawn node src/index.js with VFX_LAB_LIBRARY temp; SDK client listTools().tools.length === 11; callTool vfx_guide -> text contains "Sections:" */ });
```

- [ ] **Step 2: Run, expect failure** — `npm test`.
- [ ] **Step 3: Write `seedLibrary` and `src/index.js`** (from studio-hub `index.js` main, without upstream merging).
- [ ] **Step 4: Run, expect pass** — `npm test`.
- [ ] **Step 5: GPU smoke** — write `scripts/smoke-mcp.js` from studio-hub `smoke-vfx.js` (GPU part and the optional Studio part with a built-in texture; `--upload` stays opt-in; `--npx` spawns `npx -y github:NevelStudios/roblox-vfx-lab` in place of `node src/index.js`), then run `node scripts/smoke-mcp.js`. Expected: exit 0, images saved in the temp library, no Dawn output on the MCP stream.
- [ ] **Step 6: Commit**

```bash
git add src/index.js src/lab.js scripts/smoke-mcp.js test/index.test.js
git commit -m "feat: MCP server entry with first-start examples"
```

### Task 5: Local page server with save and export

**Files:**
- Create: `src/server.js`
- Modify: `src/lab.js` (add `vfx_viewer` from `src/server.js`'s `startViewer`)
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `createLibrary` shape of studio-hub `vfx-viewer.js`, `bakeNode`, `uploadBake`, `applyBake`, `pickStudio`, `runOp`, `sourceHash`, `checkNode`.
- Produces, `src/server.js`:
  - `createLibrary(root)` as studio-hub, with `listing().nodes[i].readOnly = false`.
  - `route(library, method, rawUrl, headers)` for GET: `/` and `/<file>` from `site/` (only names in `fs.readdirSync("site")`), `/lib/core.js`, `/lib/pixels.js`, `/lib/bake.js` from `src/`, `/examples/<path>` from `examples/` (resolved path must stay inside `examples/`), and the studio-hub `/api/*` routes.
  - `postRequest(library, ctx, url, headers, body) -> Promise<answer>` for `/api/bake` (studio-hub `bakeRequest`), `/api/node` (`{ name, source, replaces }`, stale rule of `vfx_shader_write`, answers `{ name, hash, state, problems, params }`), `/api/export` (`{ bake, studio_id? }`). The loopback `Host`, same `Origin`, JSON type and 64 KiB checks run first for all three.
  - Export: `pickStudio`; when several studios are open, answer `409 { error, studios: [{ id, name }] }`; then `uploadBake` (reuses a recorded id); then `runOp(…, "vfx_selection", {})`; `targets` non-empty: `applyBake({ bake, targets })`; else `parent`: `applyBake({ bake, create: { parent } })`; else `400 { error: "select a part, an attachment or an emitter in Studio" }`. Answers `{ assetId, reused, applied | created }`.
  - `startViewer({ port = Number(process.env.VFX_LAB_PORT ?? 4518), library, keepAlive, ctx })`, `stopViewer()`. A port held by another program: `ToolError` naming `VFX_LAB_PORT`.

- [ ] **Step 1: Write the failing tests**

Port studio-hub `vfx-viewer.test.js` (6 tests). Add:

```js
test("static routes serve the page, the three lib modules and examples, and refuse paths outside them", () => { /* /lib/bake.js 200; /lib/lab.js 404; /examples/../package.json 404 */ });
test("POST /api/node saves with the stale rule and reports problems at node lines", async () => { /* new name -> 200 + hash; same name without replaces -> 409 naming current hash; source with an error -> 200, state "problems", problem line in node lines, file written */ });
test("POST /api/export applies to selected emitters, else creates one on the selected part", async () => { /* fakeStudio luau answers vfx_selection with targets -> applied; with parent only -> created; with neither -> 400 message */ });
test("POST /api/export with two studios open answers 409 with both, and does not upload", async () => { /* Review Focus 3: fakeStudio with 2 studios; status 409; studios.length 2; upload count 0 */ });
test("every POST from another origin is refused before any work", async () => { /* /api/node and /api/export with Origin https://evil.example -> 403; nothing written, nothing uploaded */ });
```

- [ ] **Step 2: Run, expect failure** — `npm test`.
- [ ] **Step 3: Write `src/server.js` and the `vfx_viewer` tool**
- [ ] **Step 4: Run, expect pass** — `npm test`.
- [ ] **Step 5: Commit**

```bash
git add src/server.js src/lab.js test/server.test.js
git commit -m "feat: local lab server with node save and Export to Roblox"
```

### Task 6: Examples

**Files:**
- Create: `examples/<category>/<name>.wgsl` (10 nodes), `scripts/examples.js`, `examples/index.json`, `docs/media/<category>-<name>.png` (APNG previews)
- Test: `test/examples.test.js`

**Interfaces:**
- Consumes: `requireClean`, `bakeSheet` (Task 2), `pngRows`, `pngFile`, `apngFile` (Task 1), `gpu`.
- Produces: `examples/index.json`: `[{ name, title, description, target, bake: { grid, size, mode, duration, margin, tiles } , png, wgsl, preview }]`, sorted by name. `scripts/examples.js [--check]`: bakes every example from its entry, fails with exit 1 on any warning or on edge alpha above 0.02 (except an entry with `margin: 0` and grid 1), writes `examples/<name>.png` and `.json` (recipe with `uploads: []`), regenerates `index.json` and one APNG per example (frames of the sheet at its frame rate, 256 px); `--check` bakes in a temp folder and only reports.

| Source in `~/.studio-mcp-hub/vfx-library` | Example | target | bake |
|---|---|---|---|
| `shaders/examples/shock-ring.wgsl` | `impact/shock-ring` | ParticleEmitter | grid 4, oneshot |
| `shaders/examples/smoke-puff.wgsl` | `smoke/smoke-puff` | ParticleEmitter | grid 4, loop (duration from its recipe) |
| `shaders/jjk/cursed-aura.wgsl` | `aura/blue-flame-aura` | ParticleEmitter | grid 4, loop |
| `shaders/jjk/divergent-impact.wgsl` | `impact/double-impact` | ParticleEmitter | grid 4, oneshot |
| `shaders/portal/rick.wgsl` | `portal/vortex` | ParticleEmitter | grid 8, loop; plus entry `portal/vortex-body` (same node, grid 1) |
| `shaders/portal/rick-swirl.wgsl` | `portal/vortex-swirl` | ParticleEmitter | grid 1 |
| `shaders/space/quasar.wgsl` | `space/quasar` | ParticleEmitter | grid 4, loop; plus entry `space/quasar-still` (grid 1) |
| new | `slash/sword-slash` | ParticleEmitter | grid 4, oneshot |
| new | `spark/spark-burst` | ParticleEmitter | grid 4, oneshot |
| new | `beam/energy-beam` | Beam | grid 1, margin 0, tiles across uv.x |

Two-entry nodes use `"node"` in the entry to name the shared `.wgsl`. Bake values (`values`) come from each source recipe in `~/.studio-mcp-hub/vfx-library/bakes/`.

- [ ] **Step 1: Write the failing test**

```js
test("index.json lists every example file and nothing else", () => { /* each entry's png, wgsl, preview exists; every .wgsl under examples/ is named by an entry */ });
test("no example names or comments use IP names", () => { /* every file under examples/ and docs/media names: no /jjk|jujutsu|rick|morty|itadori|gojo|sukuna|cursed energy|divergent/i */ });
test("every example recipe has no warnings and no uploads", () => { /* recipe.warnings.length === 0, recipe.uploads.length === 0 */ });
```

- [ ] **Step 2: Run, expect failure** — `npm test`.
- [ ] **Step 3: Copy the 7 nodes with the new names; rewrite their header comments with no IP names; write the 3 new nodes** (each new node follows the guide's quality section; the slash is drawn matter with crisp edges and breakup; the spark burst is light with streaks that taper inside uv 0.07..0.93; the beam is white, margin 0, periodic on uv.x so it tiles).
- [ ] **Step 4: Write `scripts/examples.js`, run `npm run examples`.** Expected: exit 0. Where it reports a warning or an edge above 0.02 (`impact/shock-ring`, `impact/double-impact`, `portal/vortex` today), change the node until the run is clean. Look at each fix over the dark and the light backdrop with `vfx_render` (through `scripts/smoke-mcp.js`'s client or the MCP in this session), not only at the numbers.
- [ ] **Step 5: Run, expect pass** — `npm test` and `npm run smoke`.
- [ ] **Step 6: Commit**

```bash
git add examples scripts/examples.js docs/media test/examples.test.js
git commit -m "feat: ten example effects with clean bakes and previews"
```

### Task 7: The page on the local backend, with editor and export

**Files:**
- Create: `site/index.html` (markup and CSS of studio-hub `vfx-viewer.html` plus new panels), `site/app.js` (the viewer script), `site/backend-local.js`, `site/editor.js`, `site/export.js`
- Test: `test/site.test.js`

**Interfaces:**
- Consumes: `/lib/core.js`, `/lib/pixels.js`, `/lib/bake.js`, the Task 5 routes.
- Produces, the backend interface that `site/app.js` uses and Task 8 implements again:

```js
// mode: "local" | "hosted"; location: string shown in the side foot
// listing() -> Promise<{ nodes: [{ name, hash, readOnly }], bakes: [{ name, node, grid, frames, mode, duration, size, pngSha, warnings, assetId }] }>
// node(name) -> Promise<{ name, hash, source, readOnly } | null>
// saveNode({ name, source, replaces }) -> Promise<{ name, hash, state, problems, params }>   (rejects with Error(message))
// recipe(name) -> Promise<recipe | null>
// sheetUrl(name, recipe) -> Promise<string>
// bake(call) -> Promise<{ name, ms, bytes, recipe }>                                         (call = app.js bakeCall())
// subscribe(onChange: (changes: [{ kind, name? }]) => void) -> void
// exportToRoblox(bake, studioId?) -> Promise<{ assetId, reused, applied?, created? }>      (local only; rejects with Error that has .studios on 409)
```

- `createLocalBackend(base = "./") -> Promise<backend | null>`: `null` when `GET api/library` fails (the page then tries hosted mode).
- `mountEditor(container, { source, problems, readOnly, onSave(source), onNew(name) }) -> { setSource(source), setProblems(problems) }`: textarea plus a line-number gutter, Ctrl+S saves, a click on a problem moves the caret to its line and column.
- `exportPanel({ backend, bake, uri }) -> HTMLElement`: Download PNG, Download recipe, the Roblox block from `textureProperties("ParticleEmitter", recipe, uri ?? "rbxassetid://<id after upload>")` with a Copy button; in local mode, Export to Roblox with a confirm dialog whose text says the upload is public, moderated and permanent, and a Studio select when the answer has `studios`.

- [ ] **Step 1: Write the failing test**

```js
test("site modules use relative URLs only", () => { /* no fetch("/ or src="/ or from "/ in site/* */ });
test("app.js reaches the server only through the backend", () => { /* no fetch( or EventSource in site/app.js */ });
```

- [ ] **Step 2: Run, expect failure** — `npm test`.
- [ ] **Step 3: Split studio-hub `vfx-viewer.html` into `site/index.html` and `site/app.js`; replace each server call with the backend** (fetch sites in the studio-hub file: lines 911, 926, 946, 966, 1087, 1093, 1139, 1143, 1174); add the Editor panel and the Export panel to `renderProps()` and `bakePanel()`; empty-library texts name both the MCP tools and New node. Title "Roblox VFX Lab".
- [ ] **Step 4: Run, expect pass** — `npm test`.
- [ ] **Step 5: Browser check, local mode** — run `node -e "import('./src/server.js').then(m => m.startViewer({ keepAlive: true }))"`, open `http://127.0.0.1:4518/` in the browser pane. Expected: examples listed; `impact/shock-ring` plays; a slider change re-bakes (auto bake on); New node, save a source with `let x: f32 = ;` shows the error at its line while the last good node keeps playing and no bake runs (Review Focus 5); Download PNG gives a file; Export to Roblox with no Studio shows the Studio error text. Console has no errors.
- [ ] **Step 6: Commit**

```bash
git add site test/site.test.js
git commit -m "feat: lab page with editor and Export to Roblox"
```

### Task 8: Hosted mode and the gallery

**Files:**
- Create: `site/backend-hosted.js`, `site/web-gpu.js`, `site/idb.js`, `site/gallery.js`
- Modify: `site/app.js` (pick the backend; gallery view; Duplicate on read-only nodes), `site/index.html` (gallery markup, no-WebGPU note)
- Test: `test/hosted.test.js`

**Interfaces:**
- Consumes: the backend interface (Task 7), `bakeSheet`, `bakeTiles`, `requireClean`, `checkNode` (Task 2), `pngRows`, `pngFile` (Task 1), `examples/index.json` (Task 6).
- Produces:
  - `createHostedBackend({ kv, gpu, fetchJson, fetchBytes, now = () => new Date() }) -> Promise<backend>`: examples from `examples/index.json` are nodes with `readOnly: true`; `saveNode` on a read-only name rejects with "examples are read-only; Duplicate it first"; `bake` renders with `bakeSheet` on `gpu`, encodes with `pngFile(w, h, await deflate(pngRows(…)))` where `deflate` uses `new Response(new Blob([rows]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer()`, hashes with `crypto.subtle.digest("SHA-256")`, stores `{ recipe, png }` in `kv`; `subscribe` calls back after its own writes; no `exportToRoblox`.
  - `kv` interface: `{ get(store, key), put(store, key, value), keys(store), persistent: boolean }`, stores `"nodes"` and `"bakes"`.
  - `openKv(name = "roblox-vfx-lab") -> Promise<kv>` in `site/idb.js`: IndexedDB; when open fails, an in-memory kv with `persistent: false` and the error logged with `console.error` (the page then shows "This window does not save: storage is blocked").
  - `createWebGpu(device) -> GPU interface` in `site/web-gpu.js`: the Dawn worker's `compile` and `render` on the browser device (`rgba8unorm`, `vfx_fs_straight`, 256-byte uniform slots).
  - `renderGallery(container, examples, { onOpen(name), baseUrl }) -> void`: one card per example, the sheet animated in a canvas at its frame rate, Open, Download PNG, Download WGSL.

- [ ] **Step 1: Write the failing tests** (Node has `CompressionStream` and `crypto.subtle`)

```js
test("hosted bake writes a PNG that decodes and a recipe like the Node bake", async () => { /* createHostedBackend with an in-memory kv, fakeGpu, examples from disk; bake({ name: "impact/shock-ring", grid: 2, size: 256 }); decodeRgba(png) equals bakeSheet(...).rgba; recipe.flipbookLayout "Grid2x2" */ });
test("examples are read-only and Duplicate makes an editable copy", async () => { /* saveNode on impact/shock-ring rejects /read-only/; saveNode on mine/shock-ring resolves; listing shows both */ });
test("a non-persistent kv still opens examples and bakes", async () => { /* Review Focus 4: kv with persistent false; listing, node, bake all resolve; backend.persistent === false */ });
```

- [ ] **Step 2: Run, expect failure** — `npm test`.
- [ ] **Step 3: Write the four modules and wire `site/app.js`**: `createLocalBackend()` first, then `createHostedBackend(...)`. The gallery is the start view in hosted mode and a "Gallery" item in local mode. With no WebGPU, the note lists Chrome, Edge, Safari 26 and Firefox 141 on Windows, and the gallery still plays the PNG sheets.
- [ ] **Step 4: Run, expect pass** — `npm test`.
- [ ] **Step 5: Browser check, hosted mode** — `node -e` a static server over a `_site` folder built as Task 10's workflow builds it (`site/*`, `src/{core,pixels,bake}.js` to `lib/`, `examples/`), on a port other than 4518. Expected: gallery plays all examples; Open, change a value, Duplicate, Save, Bake, Download PNG; reload keeps the duplicate; the downloaded PNG's grid and look match the example's; console clean.
- [ ] **Step 6: Commit**

```bash
git add site test/hosted.test.js
git commit -m "feat: hosted lab with in-browser bakes and example gallery"
```

### Task 9: README and guide

**Files:**
- Create: `README.md`
- Modify: `src/guide.md` (final facts: site URL, Export to Roblox, examples)

**Interfaces:**
- Consumes: `docs/media/*.png` (Task 6), tools and env (Tasks 2 to 5).

- [ ] **Step 1: Write `README.md`** in the 14 sections of spec section 10, in that order. The top strip shows 5 APNG previews in one row (`<img width="160">` each). Install configs: Claude Code `claude mcp add roblox-vfx-lab -- npx -y github:NevelStudios/roblox-vfx-lab`; Claude Desktop and Cursor JSON from the spec. A Mermaid diagram for the flow (node, render, bake, upload, apply, preview). Troubleshooting covers: no GPU adapter (the exact Dawn message from `src/gpu.js`), Studio MCP not found (the exact `studioLaunch` message), the Assistant MCP toggle in Studio, port in use, browsers with no WebGPU, the shared `nevelstudios.github.io` origin. Every fact checked against the code it names.
- [ ] **Step 2: Check** — every relative link and image in `README.md` resolves to a file in the repo (`node -e` script that reads the links and runs `fs.existsSync`); every tool name and variable in the README exists in `src/`.
- [ ] **Step 3: Commit**

```bash
git add README.md src/guide.md
git commit -m "docs: README for artists and the final guide"
```

### Task 10: CI, Pages, publish and final check

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/pages.yml`

- [ ] **Step 1: Write `ci.yml`** — on push and pull request; matrix `ubuntu-latest`, `windows-latest`; Node 20; `npm ci`; `npm test`. Tests that need a GPU adapter skip with a printed reason when `gpu.compile` rejects with "no GPU adapter".
- [ ] **Step 2: Write `pages.yml`** — on push to `main` and `workflow_dispatch`; permissions `pages: write`, `id-token: write`; build `_site/` (`site/*` to the root, `src/core.js`, `src/pixels.js`, `src/bake.js` to `_site/lib/`, `examples/` to `_site/examples/`, an empty `.nojekyll`); `actions/upload-pages-artifact@v3`; `actions/deploy-pages@v4`.
- [ ] **Step 3: Local full check** — `npm test`, `npm run smoke`, `node scripts/smoke-mcp.js`. Expected: all pass. Name any check that did not run and why.
- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/pages.yml
git commit -m "ci: tests on Ubuntu and Windows, Pages deploy"
```

- [ ] **Step 5: Publish (approved with the plan)** — `gh repo create NevelStudios/roblox-vfx-lab --public --source . --push --description "Bake WGSL into Roblox VFX textures: MCP server, in-browser lab and examples"`; then `gh api -X POST repos/NevelStudios/roblox-vfx-lab/pages -f build_type=workflow`; then `gh workflow run pages.yml`.
- [ ] **Step 6: Check the deployed site** — open `https://nevelstudios.github.io/roblox-vfx-lab/` in the browser pane after the Pages run is green (`gh run list --workflow pages.yml`). Expected: hosted mode, gallery plays, one bake and download works, console clean. Check that `ci.yml` is green on both runners.
- [ ] **Step 7: Install check as an artist** — `node scripts/smoke-mcp.js --npx` (installs from GitHub as the README tells artists). Expected: 11 tools, the GPU part passes.
