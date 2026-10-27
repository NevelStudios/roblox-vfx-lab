// Builds the hosted lab: site/* at the root, the browser-safe lab modules under lib/, the examples, and .nojekyll so
// GitHub Pages serves every file as it is. The Pages workflow and the hosted tests run this same build.
//   node scripts/build-site.js [out]   (default _site)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const LIB_MODULES = ["core.js", "pixels.js", "bake.js", "wgsl.js"];

// Not fs.cpSync: on Windows (Node 24) it copies nothing into a folder whose path has non-ASCII letters, and says nothing.
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyTree(path.join(from, entry.name), path.join(to, entry.name));
    else fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
  }
}

export function buildSite(out = path.join(ROOT, "_site")) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "lib"), { recursive: true });
  for (const entry of fs.readdirSync(path.join(ROOT, "site"), { withFileTypes: true })) {
    if (entry.isFile()) fs.copyFileSync(path.join(ROOT, "site", entry.name), path.join(out, entry.name));
  }
  for (const file of LIB_MODULES) fs.copyFileSync(path.join(ROOT, "src", file), path.join(out, "lib", file));
  copyTree(path.join(ROOT, "examples"), path.join(out, "examples"));
  fs.writeFileSync(path.join(out, ".nojekyll"), "");
  return out;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  console.log(`built ${buildSite(process.argv[2] ? path.resolve(process.argv[2]) : undefined)}`);
}
