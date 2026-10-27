import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bakeSheet, requireClean } from "../src/bake.js";
import { buildSite } from "../scripts/build-site.js";
import { fakeGpu } from "./fake-gpu.js";
import { decodeRgba } from "./png-helpers.js";

// The hosted page imports ./lib/*.js, so it is tested from a real build, as Pages serves it.
const SITE = buildSite(fs.mkdtempSync(path.join(os.tmpdir(), "vfx site ü-")));
const { createHostedBackend } = await import(pathToFileURL(path.join(SITE, "backend-hosted.js")).href);
after(() => fs.rmSync(SITE, { recursive: true, force: true }));
const { memoryKv } = await import(pathToFileURL(path.join(SITE, "idb.js")).href);

const fetchBytes = async (file) => new Uint8Array(fs.readFileSync(path.join(SITE, file)));
const fetchJson = async (file) => JSON.parse(fs.readFileSync(path.join(SITE, file), "utf8"));
const hosted = (kv = memoryKv(true), gpu = fakeGpu()) => createHostedBackend({ kv, gpu, fetchJson, fetchBytes, now: () => new Date("2026-10-27T12:00:00Z") });
const EXAMPLE = "portal/green-portal";

test("hosted delete removes the artist's own nodes and bakes, never an example", async () => {
  const backend = await hosted();
  await backend.saveNode({ name: "mine/a", source: (await backend.node(EXAMPLE)).source });
  await backend.bake({ name: "mine/a", grid: 1, size: 256 });
  await assert.rejects(backend.remove({ kind: "node", name: EXAMPLE }), /examples are read-only/);
  await assert.rejects(backend.remove({ kind: "bake", name: EXAMPLE }), /examples are read-only/);
  await backend.remove({ kind: "bake", name: "mine/a" });
  assert.equal(await backend.recipe("mine/a"), null);
  await backend.remove({ kind: "node", name: "mine/a" });
  assert.equal(await backend.node("mine/a"), null);
  await assert.rejects(backend.remove({ kind: "node", name: "mine/a" }), /no node mine\/a/);
  const listing = await backend.listing();
  assert.ok(!listing.nodes.some((n) => n.name === "mine/a"));
  assert.equal(listing.bakes.find((b) => b.name === EXAMPLE).readOnly, true);
});

test("hosted bake writes a PNG that decodes and a recipe like the Node bake", async () => {
  const gpu = fakeGpu();
  const backend = await hosted(memoryKv(true), gpu);
  const answer = await backend.bake({ name: EXAMPLE, grid: 2, size: 256 });
  const stored = await backend.recipe(EXAMPLE);
  assert.equal(answer.name, EXAMPLE);
  assert.equal(answer.recipe.flipbookLayout, "Grid2x2");
  assert.equal(answer.recipe.bakedAt, "2026-10-27T12:00:00.000Z");
  assert.match(answer.recipe.pngSha, /^[0-9a-f]{64}$/);
  assert.deepEqual(stored, { name: EXAMPLE, ...answer.recipe });

  const node = await backend.node(EXAMPLE);
  const clean = await requireClean(node.name, node.source, gpu);
  const sheet = await bakeSheet({ name: node.name, hash: node.hash, ...clean }, { grid: 2, size: 256 }, gpu);
  const png = new Uint8Array(await (await fetch(await backend.sheetUrl(EXAMPLE, stored))).arrayBuffer());
  assert.equal(png.length, answer.bytes);
  assert.deepEqual(decodeRgba(png), sheet.rgba);
});

test("examples are read-only and Duplicate makes an editable copy", async () => {
  const backend = await hosted();
  const example = await backend.node(EXAMPLE);
  assert.equal(example.readOnly, true);
  assert.match(example.hash, /^[0-9a-f]{12}$/);
  await assert.rejects(backend.saveNode({ name: EXAMPLE, source: example.source, replaces: example.hash }), /read-only; Duplicate it first/);
  const copy = await backend.saveNode({ name: "mine/green-portal", source: example.source });
  assert.equal(copy.state, "clean");
  assert.equal(copy.hash, example.hash);
  await assert.rejects(backend.saveNode({ name: "mine/green-portal", source: "// changed\n" + example.source }), /stale/);
  const listing = await backend.listing();
  assert.deepEqual(
    listing.nodes.filter((n) => n.name.endsWith("green-portal")).map((n) => [n.name, n.readOnly]),
    [["mine/green-portal", false], [EXAMPLE, true]],
  );
  assert.ok(listing.bakes.some((b) => b.name === "space/black-hole" && b.grid === 4));
});

test("a non-persistent kv still opens examples and bakes", async () => {
  const backend = await hosted(memoryKv(false));
  assert.equal(backend.persistent, false);
  assert.ok((await backend.listing()).nodes.length >= 2);
  assert.ok(await backend.node("space/black-hole"));
  const answer = await backend.bake({ name: "space/black-hole", grid: 1, size: 256 });
  assert.equal(answer.recipe.flipbookLayout, "None");
});

test("subscribe hears the page's own writes", async () => {
  const backend = await hosted();
  const heard = [];
  backend.subscribe((changes) => heard.push(...changes));
  await backend.saveNode({ name: "mine/a", source: (await backend.node(EXAMPLE)).source });
  await backend.bake({ name: "mine/a", grid: 1, size: 256 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(heard, [{ kind: "node", name: "mine/a" }, { kind: "bake", name: "mine/a" }]);
});
