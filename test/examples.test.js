import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EDGE_LIMIT } from "../src/pixels.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXAMPLES = path.join(ROOT, "examples");
const index = JSON.parse(fs.readFileSync(path.join(EXAMPLES, "index.json"), "utf8"));
const files = (dir, ext) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name), ext) : e.name.endsWith(ext) ? [path.join(dir, e.name)] : []));

test("index.json lists every example file and nothing else", () => {
  assert.equal(index.length, 2);
  assert.deepEqual(index.map((e) => e.name), [...index.map((e) => e.name)].sort());
  for (const entry of index) {
    for (const key of ["png", "wgsl", "recipe", "preview"]) assert.ok(fs.existsSync(path.join(ROOT, entry[key])), `${entry.name}: ${entry[key]}`);
    for (const key of ["title", "description", "target"]) assert.equal(typeof entry[key], "string", `${entry.name}.${key}`);
  }
  const named = new Set(index.map((e) => path.normalize(path.join(ROOT, e.wgsl))));
  for (const file of files(EXAMPLES, ".wgsl")) assert.ok(named.has(path.normalize(file)), `${file} is in no entry`);
  const baked = new Set(index.map((e) => path.normalize(path.join(ROOT, e.png))));
  for (const file of files(EXAMPLES, ".png")) assert.ok(baked.has(path.normalize(file)), `${file} is in no entry`);
});

test("no example file, name or preview uses IP names", () => {
  const ip = /jjk|jujutsu|rick|morty|itadori|gojo|sukuna|cursed energy|divergent|vfx forge/i;
  for (const entry of index) assert.doesNotMatch(JSON.stringify(entry), ip, entry.name);
  for (const file of [...files(EXAMPLES, ".wgsl"), ...files(EXAMPLES, ".json")]) assert.doesNotMatch(fs.readFileSync(file, "utf8"), ip, file);
  for (const file of files(path.join(ROOT, "docs", "media"), ".png")) assert.doesNotMatch(path.basename(file), ip, file);
});

test("every example recipe has no warnings, no uploads and no cut edge", () => {
  for (const entry of index) {
    const recipe = JSON.parse(fs.readFileSync(path.join(ROOT, entry.recipe), "utf8"));
    assert.deepEqual(recipe.warnings, [], entry.name);
    assert.deepEqual(recipe.uploads, [], entry.name);
    const tiling = recipe.margin === 0 && recipe.grid === 1;
    if (!tiling) assert.ok(Math.max(...recipe.stats.map((s) => s.edge)) <= EDGE_LIMIT, `${entry.name} edge ${Math.max(...recipe.stats.map((s) => s.edge))}`);
  }
});
