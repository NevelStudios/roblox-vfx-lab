# roblox-vfx-lab: design

Date: 2026-10-27. Status: approved in chat, waiting for review of this file.

## 1. Goal

A public repo, `NevelStudios/roblox-vfx-lab` (MIT), that gives Roblox VFX artists the VFX lab of studio-hub as a
product of its own:

- An MCP server that an AI client (Claude Code, Claude Desktop, Cursor) adds with one config entry. It writes WGSL
  effect nodes, renders them on the GPU, bakes them into Roblox flipbook sheets and textures, uploads them, applies
  them to instances and previews them in Studio.
- A hosted site (GitHub Pages) that runs the full lab in the browser with no install.
- A README that is attractive and also explains the full flow.
- Example effects that artists can download and change.

Success means:

1. An artist with no install opens the site, opens an example, changes a parameter, bakes it and downloads a PNG
   that works in Roblox with the settings the page shows.
2. An artist adds the MCP entry, asks the AI for an effect, and gets it uploaded and on a ParticleEmitter in Studio
   through Roblox's own Studio MCP.
3. Every example bakes with no warnings.

## 2. Decisions

| Topic | Decision | Source |
|---|---|---|
| studio-hub | Stays exactly as it is. The new repo is a separate copy. | User |
| Repo | `NevelStudios/roblox-vfx-lab`, public | User |
| License | MIT | User |
| Site | The full lab in the browser, on GitHub Pages | User |
| Roblox access | Roblox's own Studio MCP (`StudioMCP`), not studio-hub | User |
| Examples | Shipped in the repo and downloadable from the site | User |
| Code shape | One package, plain ES modules, no build step | Approach 1, approved |
| Local folder | `E:\roblox-vfx-lab` | Design |

## 3. Scope

In scope: everything the studio-hub lab does today (the `vfx_*` tools and the viewer page), plus a WGSL editor in
the page, a hosted mode, an Export to Roblox button in local mode, an example gallery and the README.

Out of scope:

- Changes to studio-hub, nevel or the `roblox-vfx` skill.
- Publication to the npm registry (install is from GitHub; npm can follow later).
- Re-exposing Roblox's Studio MCP tools through this server. Artists who want them add Roblox's MCP on its own.
- Upload from the hosted site. The site has no Studio; it gives the PNG and the settings.

## 4. Repo layout

```
roblox-vfx-lab/
  README.md  LICENSE  package.json  .gitignore
  src/
    core.js          browser-safe: ToolError, @param parse, WGSL module, layout, uniforms (from vfx-core.js)
    pixels.js        browser-safe: dilate, cell stats, bake warnings, composite, grid lines, downscale,
                     PNG and APNG encoders (from vfx.js)
    lab.js           Node: library paths, node check, bake to files, MCP tool list (from vfx.js)
    gpu.js           Node: Dawn GPU worker in a child process (from vfx-gpu.js)
    studio.js        Node: client for Roblox's Studio MCP: launch, call, Luau ops
    studio-ops.luau  create_instances, get_properties, set_properties, vfx_freeze, vfx_restore, vfx_selection
    server.js        Node: local page server (from vfx-viewer.js)
    index.js         Node: MCP entry over stdio, also the package bin
    guide.md         the guide vfx_guide answers (from vfx-guide.md)
  site/
    index.html       the lab page, the same file in local and hosted mode
  examples/
    index.json       the example list (generated, checked by a test)
    <category>/<name>.wgsl, .png, .json
  scripts/
    examples.js      re-bakes every example, writes index.json and the README previews
  docs/media/        APNG previews for the README
  test/              node --test files
  .github/workflows/ci.yml, pages.yml
```

`core.js` and `pixels.js` import nothing from Node. They are the only `src/` files the page loads. Thus a bake in
the page and a bake from the MCP run the same code on the same WGSL module.

## 5. Modules from studio-hub

| studio-hub file | New file | Change |
|---|---|---|
| `vfx-core.js` | `src/core.js` | `ToolError` moves here (no `common.js`) |
| `vfx.js` (pixels, PNG) | `src/pixels.js` | `encodePng` uses its own CRC32 table and `deflate` input, so it runs in the browser too; adds `encodeApng` |
| `vfx.js` (files, tools) | `src/lab.js` | Library root and env names change; Studio calls go through `studio.js` |
| `vfx-gpu.js` | `src/gpu.js` | None |
| `vfx-viewer.js` | `src/server.js` | New routes (section 7); port and env names change |
| `vfx-viewer.html` | `site/index.html` | Two backends, editor, export, gallery (section 8) |
| `vfx-guide.md` | `src/guide.md` | Names change; site and install facts |
| `studio-ops-extra.luau` (vfx ops) and the three property ops | `src/studio-ops.luau` | Only the ops the lab calls, plus `vfx_selection` |
| `vfx.test.js`, `vfx-viewer.test.js` | `test/*.test.js` | Ported to the new modules |

`encodePng` in the browser: the page gets the deflate bytes from `CompressionStream("deflate")` (zlib format, which
PNG needs). Node gets them from `zlib.deflateSync`. `pixels.js` takes the compressed bytes as an argument, so it stays
pure and the same on both sides. Canvas `toBlob` is not used: canvas premultiplies alpha and removes the RGB that
`dilate` spreads into transparent pixels.

## 6. MCP server

### Tools

The same names and arguments as studio-hub, so the guide and existing habits carry over:

| Tool | Studio | What it does |
|---|---|---|
| `vfx_guide` | No | The guide, by section |
| `vfx_shader_list` | No | Every node: hash, state, parameters |
| `vfx_shader_read` | No | One node's source and verdict |
| `vfx_shader_write` | No | Create or replace a node (stale-hash check) |
| `vfx_shader_edit` | No | Exact text replacements |
| `vfx_render` | No | Clip, phases or sweep as one image, with stats and warnings |
| `vfx_bake` | No | Final PNG and recipe; grid 1/2/4/8, size 256/512/1024, tiles 1..4 |
| `vfx_upload` | Yes | Upload a bake through Roblox's `upload_image`; never twice for the same PNG |
| `vfx_apply` | Yes | Put a bake or texture id on instances with the flipbook settings, or create an emitter |
| `vfx_preview` | Yes | Play emitters in the Edit viewport, freeze at moments, capture the screen |
| `vfx_viewer` | No | Start the local page and answer its URL |

### Configuration

| Variable | Default | Use |
|---|---|---|
| `VFX_LAB_LIBRARY` | `~/roblox-vfx-lab` | The library folder (`shaders/`, `bakes/`) |
| `VFX_LAB_PORT` | `4518` | The local page port (studio-hub uses 4517) |
| `ROBLOX_STUDIO_MCP` | unset | A command line that starts Roblox's Studio MCP, for installs the defaults miss |

MCP config for an artist:

```json
{ "mcpServers": { "roblox-vfx-lab": { "command": "npx", "args": ["-y", "github:NevelStudios/roblox-vfx-lab"] } } }
```

Requirements: Node 22 or later (Node 20 is end of life since April 2026 and its `node --test` reads no globs; recursive `fs.watch` on Linux), and a GPU that Dawn can use. The `webgpu` package
ships Dawn binaries for win32-x64, win32-arm64, darwin-universal, linux-x64 and linux-arm64.

### First start

If the library has no `shaders/` folder, the server copies `examples/` into it (`shaders/<category>/<name>.wgsl` and
`bakes/<category>/<name>.png` and `.json`). It never copies over a file that exists.

### Roblox Studio connection (`studio.js`)

- The server starts Roblox's Studio MCP as a child process at the first tool call that needs Studio, not at server
  start. Thus write, render and bake work on a machine with no Studio.
- Launch command, first match wins:
  1. `ROBLOX_STUDIO_MCP`, if set.
  2. Windows: `cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat` (the file Studio writes; checked on this machine: it starts
     `StudioMCP.exe` from the current Studio version).
  3. macOS: the `StudioMCP` binary inside the Studio app bundle. The exact path is not in the local creator-docs clone;
     the implementation confirms it from Roblox's documentation. If it cannot be confirmed, macOS needs
     `ROBLOX_STUDIO_MCP`, and the README says so.
  4. Else: a `ToolError` that names `ROBLOX_STUDIO_MCP`.
- Calls used: `list_roblox_studios`, `upload_image`, `execute_luau`, `screen_capture`. Upload passes a one-time
  `http://127.0.0.1` URL for the PNG, as studio-hub does today.
- If the child exits, pending calls fail with its exit code and the next call starts a new child.
- Luau ops run through `execute_luau` from `studio-ops.luau` (the studio-hub pattern: the op source plus a JSON
  argument, answer as JSON).

### Errors

Every expected failure is a `ToolError` with the cause and the next step (no Studio found, no GPU adapter, a node with
problems, a bake not uploaded). No silent default on any failure.

## 7. Local page server (`server.js`)

The server is the studio-hub viewer: the library in memory, `fs.watch` with server-sent events, loopback only.

| Route | Method | Change |
|---|---|---|
| `/` | GET | Serves `site/index.html` |
| `/lib/core.js`, `/lib/pixels.js` | GET | Serves the two browser-safe modules |
| `/examples/*` | GET | Serves the example files (the gallery) |
| `/api/library`, `/api/node`, `/api/bake`, `/api/bake.png`, `/api/events` | GET | Same as today |
| `/api/bake` | POST | Same as today (the page's auto bake) |
| `/api/node` | POST | New: save a node from the editor. Body `{ name, source, replaces }`, the same stale-hash rule as `vfx_shader_write` |
| `/api/export` | POST | New: Export to Roblox. Body `{ bake }`. Uploads (or reuses the recorded id), then applies to the Studio selection |

Every POST keeps today's checks: loopback `Host`, `Origin` equal to the page's own, `application/json`, 64 KiB body
limit. Export target rule, through the `vfx_selection` op:

- Selected ParticleEmitters, Beams, Trails, Decals or MeshParts get the texture and the flipbook settings.
- Else, a selected BasePart or Attachment gets a new ParticleEmitter named after the bake.
- Else, an error: "select a part, an attachment or an emitter in Studio".

A sheet (grid above 1) on a Beam or Trail is an error, as in `vfx_apply`.

## 8. The page (`site/index.html`)

One file. At start it asks `GET /api/library`. An answer means local mode; no answer means hosted mode.

| | Local mode | Hosted mode |
|---|---|---|
| Library | Disk, through the server | IndexedDB in the browser |
| Live updates | Server-sent events | None (one tab owns its library) |
| Examples | In the library after first start | Read-only from `examples/`; Duplicate makes an editable copy |
| Bake | `POST /api/bake` (Dawn) | In the page: WebGPU render, `pixels.js`, `CompressionStream` |
| Save node | `POST /api/node` | IndexedDB |
| Export | Download PNG, settings block, Export to Roblox | Download PNG, settings block |

Panels and views, in both modes:

- Everything the viewer has today: node and bake lists, live WebGPU view, play and scrub, parameter sliders, sheet
  view, alpha view, backdrops, clip panel (duration or FPS, 30 fps cap), auto bake, bake player, warnings.
- Editor: a textarea with line numbers, Save (Ctrl+S), New node, and compiler messages at line:column that move the
  caret on click. A broken save keeps the last good pipeline on screen, as the viewer does today.
- Export panel: Download PNG, Download recipe (JSON), and a Roblox block to copy: `Texture`, `FlipbookLayout`,
  `FlipbookMode`, `FlipbookFramerate`, from `textureProperties`. Local mode adds Export to Roblox, behind a confirm
  dialog that says the upload is public, moderated and permanent.
- Gallery: every example as an animated card (it plays the baked sheet), with Open, Download PNG and Download WGSL.
- No WebGPU: the page says which browsers work (Chrome, Edge, Safari 26, Firefox 141 on Windows) and still shows the
  gallery from the baked PNGs.

Hosted storage: IndexedDB database `roblox-vfx-lab`, stores `nodes` (name to source) and `bakes` (name to recipe and
PNG blob). Every access is in a try/catch that shows the error in the page; the page works for the session when
storage is blocked (a private window) and says so.

## 9. Examples

Each example is a node plus its bake. Names have no IP. Comments are rewritten with no IP names.

| Today | Example | Bake |
|---|---|---|
| `examples/shock-ring` | `impact/shock-ring` | 4x4 OneShot |
| `examples/smoke-puff` | `smoke/smoke-puff` | 4x4 Loop |
| `jjk/cursed-aura` | `aura/blue-flame-aura` | 4x4 Loop |
| `jjk/divergent-impact` | `impact/double-impact` | 4x4 OneShot |
| `portal/rick` | `portal/vortex` | 8x8 Loop, and a still `portal/vortex-body` |
| `portal/rick-swirl` | `portal/vortex-swirl` | Still |
| `space/quasar` | `space/quasar` | 4x4 Loop, and a still `space/quasar-still` |
| new | `slash/sword-slash` | 4x4 OneShot |
| new | `spark/spark-burst` | 4x4 OneShot |
| new | `beam/energy-beam` | Still, margin 0, tiles on uv.x (Beam, Trail) |

Quality bar for every example: the bake has no warnings, and every frame has edge alpha 0.02 or less (the beam, a
tiling still with margin 0, is the one exception, by the guide's rule). Today `shock-ring` and `divergent-impact`
have one warning each and `portal/rick` has edge alpha 0.063: they are fixed before they ship.

`scripts/examples.js` re-bakes all examples, fails on any warning, writes `examples/index.json` and writes one APNG
preview per example to `docs/media/`.

## 10. README

In this order:

1. Name, one-line pitch, an animated strip of example previews, links: Open the lab (the site), Install the MCP.
2. What it is: Roblox has no custom shaders, so the lab bakes WGSL into textures. One diagram: node, render, bake,
   upload, apply, preview.
3. Try it in 60 seconds: the site, open an example, move a slider, bake, download, settings to paste.
4. Install the MCP: requirements (Node 20, a GPU, Studio for export), config for Claude Code, Claude Desktop and
   Cursor, the first prompt to try.
5. Your first effect: a walkthrough from prompt to an emitter in Studio.
6. Writing nodes: the function, uniforms, `@param`, helpers, two short examples.
7. Quality rules: the edge rule, frame 0, loops, white share, how to read the warnings.
8. Roblox export: flipbook settings, the 30 fps cap, LightEmission, Beams and Trails, tiles for big stills.
9. Examples: a table with preview, name, type and target class.
10. Tools reference: the MCP tools table.
11. Configuration: the variables.
12. Troubleshooting: no GPU adapter, Studio MCP not found, macOS, port in use, browsers with no WebGPU.
13. How it works: GPU worker, shared modules, local and hosted modes.
14. Contributing, license, credits (Nevel Studios).

## 11. Hosting

`pages.yml` runs on a push to `main`: it copies `site/index.html` to `_site/index.html`, `src/core.js` and
`src/pixels.js` to `_site/lib/`, and `examples/` to `_site/examples/`, then deploys with
`actions/upload-pages-artifact` and `actions/deploy-pages`. The URL is `https://nevelstudios.github.io/roblox-vfx-lab/`.
The page uses relative URLs only, so the same file works under that path and at `127.0.0.1:4518/`.

## 12. Testing

- `node --test`: core (params, values, module, layout, phases, uniforms), pixels (dilate, stats, warnings, PNG bytes
  decode back, APNG chunk order), lab (names, recipe, stale hash, tiles), server (routes, POST checks, export target
  rule with a fake Studio), studio (launch command per platform and env), examples (`index.json` matches the files).
- `npm run smoke`: bakes every example on this machine's GPU and fails on a warning (the examples script).
- Studio check on this machine: `vfx_apply` and `vfx_preview` with a built-in texture (`rbxasset://`), and the export
  target rule on a selection. No upload during tests; an upload happens only when the user asks.
- Page check in a browser, both modes: open an example, edit and save, compile error shown at its line, bake, download
  PNG, gallery plays. Hosted mode is checked on the deployed URL.
- `ci.yml` on GitHub Actions: `node --test` on Ubuntu and Windows. GPU tests skip when Dawn finds no adapter, and the
  skip is printed.

## 13. Risks

- macOS launch path of Roblox's Studio MCP is not confirmed yet (section 6).
- A bake in the browser and a bake in Dawn can differ in the last bit (driver math). The quality stats must agree; the
  bytes need not.
- GitHub Pages serves every NevelStudios project site from one origin, `nevelstudios.github.io`. Hosted IndexedDB is
  per origin, so another org project site could read it. The data is the artist's own nodes; the README says so.
- Two copies of the lab (studio-hub and this repo) drift over time. A fix in one does not reach the other.

## 14. Outward actions

After the user approves the implementation plan: create the public repo `NevelStudios/roblox-vfx-lab`, push `main`,
turn on GitHub Pages with the Actions source.
