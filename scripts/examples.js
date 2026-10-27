// Bakes every example on this machine's GPU and checks it, then writes what the repo ships:
//   examples/<name>.png and .json (the sheet and its recipe, no uploads), examples/index.json (the gallery list) and
//   docs/media/<category>-<name>.png (an animated APNG preview for the README).
//   node scripts/examples.js [--check] [--only=<name>] [--look=<dir>]
// --check bakes into a temporary library and only reports. --only bakes one entry. --look also writes each sheet over
// the dark and the light backdrop into <dir>, to look at. Exit 1 on any warning or a cut edge.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { gpu } from "../src/gpu.js";
import { bakeNode, encodePngNode } from "../src/lab.js";
import { EDGE_LIMIT, apngFile, composite, crop, downscale, pngRows } from "../src/pixels.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLES = path.join(ROOT, "examples");
const MEDIA = path.join(ROOT, "docs", "media");
const PREVIEW = 256;

// The examples. node: the .wgsl the entry bakes (default its own name). bake: vfx_bake's arguments. settings: the
// emitter values the example was made for, shown in the gallery next to the flipbook settings.
export const ENTRIES = [
  {
    name: "portal/green-portal",
    title: "Green portal",
    description: "A lumpy disk of green liquid with painted spiral arms that wind into a bright eye, a lime rim and white specks.",
    target: "ParticleEmitter",
    bake: { grid: 4, mode: "loop", duration: 1.5 },
    settings: { LightEmission: 0.2 },
  },
  {
    name: "space/black-hole",
    title: "Black hole",
    description: "A ray-traced black hole: a wide, thick accretion disk lensed over and under the shadow, with a crisp photon ring.",
    target: "ParticleEmitter",
    bake: { grid: 4, mode: "loop", duration: 2 },
    settings: { LightEmission: 0 },
  },
];

const flag = (name) => process.argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
const value = (name) => flag(name)?.split("=").slice(1).join("=");
const check = Boolean(flag("check"));
const only = value("only");
const look = value("look");

// Problems that stop an example from shipping: any warning, and alpha on the edge except on a tiling still.
export function problemsOf(recipe) {
  const edge = Math.max(...recipe.stats.map((s) => s.edge));
  const tiling = recipe.margin === 0 && recipe.grid === 1;
  return [...recipe.warnings, ...(tiling || edge <= EDGE_LIMIT ? [] : [`edge alpha ${edge} is over ${EDGE_LIMIT}`])];
}

// One frame per cell over the dark backdrop, PREVIEW px, at the clip's frame rate (Roblox plays at 30 fps at most).
function preview(rgba, layout, recipe) {
  const frames = layout.rects.map(([x, y, w, h]) => {
    const opaque = composite(crop(rgba, layout.width, x, y, w, h), w, h, "dark");
    const small = downscale(opaque, w, h, Math.max(1, Math.round(w / PREVIEW)));
    return { small, deflated: zlib.deflateSync(pngRows(small.rgba, small.width, small.height), { level: 9 }) };
  });
  const { width, height } = frames[0].small;
  const delay = Math.max(34, Math.round((recipe.duration * 1000) / recipe.frames));
  return frames.length === 1 ? encodePngNode(frames[0].small.rgba, width, height) : apngFile(width, height, frames.map((f) => f.deflated), delay);
}

async function main() {
  const library = fs.mkdtempSync(path.join(os.tmpdir(), "vfx-examples-"));
  const entries = ENTRIES.filter((e) => !only || e.name === only);
  if (entries.length === 0) throw new Error(`no example ${only}`);
  let failed = 0;
  for (const entry of entries) {
    const node = entry.node ?? entry.name;
    const source = path.join(EXAMPLES, `${node}.wgsl`);
    fs.mkdirSync(path.dirname(path.join(library, "shaders", `${node}.wgsl`)), { recursive: true });
    fs.copyFileSync(source, path.join(library, "shaders", `${node}.wgsl`));
    const started = performance.now();
    const { recipe, png, rgba, layout } = await bakeNode({ name: node, out: entry.name, size: 1024, ...entry.bake }, gpu, library);
    const problems = problemsOf(recipe);
    const edge = Math.max(...recipe.stats.map((s) => s.edge));
    console.log(`${problems.length ? "FAIL" : "ok  "} ${entry.name} (${Math.round(performance.now() - started)} ms, edge ${edge}, coverage ${Math.max(...recipe.stats.map((s) => s.coverage))})`);
    for (const problem of problems) console.log(`       ${problem}`);
    failed += problems.length > 0 ? 1 : 0;
    if (look) {
      fs.mkdirSync(look, { recursive: true });
      for (const backdrop of ["dark", "light", "alpha"]) {
        const view = downscale(composite(rgba, layout.width, layout.height, backdrop), layout.width, layout.height, Math.max(1, layout.width / 1024));
        fs.writeFileSync(path.join(look, `${entry.name.replace("/", "-")}-${backdrop}.png`), encodePngNode(view.rgba, view.width, view.height));
      }
    }
    if (check) continue;
    const { uploads: _uploads, ...rest } = recipe;
    fs.writeFileSync(path.join(EXAMPLES, `${entry.name}.png`), png);
    fs.writeFileSync(path.join(EXAMPLES, `${entry.name}.json`), `${JSON.stringify({ ...rest, uploads: [] }, null, 2)}\n`);
    fs.mkdirSync(MEDIA, { recursive: true });
    fs.writeFileSync(path.join(MEDIA, `${entry.name.replace("/", "-")}.png`), preview(rgba, layout, recipe));
  }
  if (!check && !only) {
    const index = ENTRIES.map(({ name, node, title, description, target, bake, settings }) => {
      const recipe = JSON.parse(fs.readFileSync(path.join(EXAMPLES, `${name}.json`), "utf8"));
      return {
        name,
        node: node ?? name,
        title,
        description,
        target,
        settings,
        grid: recipe.grid,
        frames: recipe.frames,
        mode: recipe.mode,
        duration: recipe.duration,
        margin: recipe.margin,
        values: recipe.values,
        bake: { size: 1024, ...bake },
        png: `examples/${name}.png`,
        recipe: `examples/${name}.json`,
        wgsl: `examples/${node ?? name}.wgsl`,
        preview: `docs/media/${name.replace("/", "-")}.png`,
      };
    });
    fs.writeFileSync(path.join(EXAMPLES, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  }
  fs.rmSync(library, { recursive: true, force: true });
  if (failed > 0) {
    console.error(`${failed} example(s) do not ship as they are`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => setTimeout(() => process.exit(), 10));
}
