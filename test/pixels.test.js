import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { apngFile, bakeWarnings, cellStats, crc32, dilate, pngFile, pngRows } from "../src/pixels.js";
import { chunks, chunkTypes, decodeRgba, sequenceNumbers } from "./png-helpers.js";

test("dilate gives transparent pixels the nearest drawn colour without crossing cells", () => {
  const width = 4;
  const straight = new Uint8Array(4 * 2 * 4);
  straight.set([255, 128, 0, 128], 0);
  straight.set([0, 0, 255, 230], 3 * 4);
  const filled = dilate(straight, width, [[0, 0, 2, 2], [2, 0, 2, 2]]);
  const at = (x, y) => Array.from(filled.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
  assert.deepEqual(at(0, 0), [255, 128, 0, 128]);
  assert.deepEqual(at(1, 0), [255, 128, 0, 0]);
  assert.deepEqual(at(1, 1), [255, 128, 0, 0]);
  assert.deepEqual(at(2, 0), [0, 0, 255, 0]);
  assert.deepEqual(at(2, 1), [0, 0, 255, 0]);
  assert.deepEqual(Array.from(dilate(new Uint8Array(16), 2, [[0, 0, 2, 2]])), Array(16).fill(0));
});

test("cellStats and bakeWarnings catch cut edges, an empty first frame, stills and loop jumps", () => {
  const width = 20;
  const rgba = new Uint8Array(width * 10 * 4);
  const put = (x, y, a) => rgba.set([255, 255, 255, a], (y * width + x) * 4);
  for (let y = 3; y < 7; y += 1) for (let x = 13; x < 17; x += 1) put(x, y, 255);
  put(11, 5, 200);
  const stats = cellStats(rgba, width, [[0, 0, 10, 10], [10, 0, 10, 10]], 1);
  assert.deepEqual(stats.cells[0], { frame: 0, coverage: 0, peak: 0, edge: 0, full: 0, change: null });
  assert.deepEqual(stats.cells[1], { frame: 1, coverage: 0.17, peak: 1, edge: 0.784, full: 0.941, change: 0.1678 });
  assert.equal(stats.wrap, 0.1678);
  const warnings = bakeWarnings(stats, { mode: "oneshot", margin: 0.1 });
  assert.match(warnings[0], /frames 1 touch the cell edge \(alpha up to 0.784\)/);
  assert.match(warnings[1], /frame 0 is empty/);
  assert.match(warnings[3], /frames 1 are over half full white/);
  assert.deepEqual(bakeWarnings({ cells: [{ frame: 0, coverage: 0 }], wrap: 0 }, { mode: "oneshot", margin: 0 }), [
    "every frame is empty: effect() returns alpha 0 everywhere (alpha is the 4th component)",
  ]);
  const faint = (count, margin) =>
    bakeWarnings(
      { cells: Array.from({ length: count }, (_, frame) => ({ frame, coverage: 0.2, peak: 1, edge: 0.03, full: 0, change: frame ? 0.02 : null })), wrap: 0.02 },
      { mode: "loop", margin, duration: 1 },
    ).filter((w) => /touch the cell edge/.test(w));
  assert.equal(faint(4, 0.02).length, 1);
  assert.equal(faint(4, 0).length, 1);
  assert.equal(faint(1, 0).length, 0);
  const cell = (frame, change) => ({ frame, coverage: 0.2, peak: 1, edge: 0, full: 0, change });
  assert.ok(bakeWarnings({ cells: [cell(0, null), cell(1, 0.001), cell(2, 0.001)], wrap: 0 }, { mode: "oneshot", margin: 0.02 }).some((w) => /barely change/.test(w)));
  assert.ok(bakeWarnings({ cells: [cell(0, null), cell(1, 0.02), cell(2, 0.02)], wrap: 0.2 }, { mode: "loop", margin: 0.02 }).some((w) => /loop jumps/.test(w)));
  assert.ok(!bakeWarnings({ cells: [cell(0, null), cell(1, 0.02), cell(2, 0.02)], wrap: 0.03 }, { mode: "loop", margin: 0.02 }).some((w) => /loop jumps/.test(w)));
});

test("bakeWarnings names the in-game loop time when a loop needs more than Roblox's 30 fps", () => {
  const cells = Array.from({ length: 64 }, (_, frame) => ({ frame, coverage: 0.2, peak: 1, edge: 0, full: 0, change: frame ? 0.02 : null }));
  const warned = (mode, duration) => bakeWarnings({ cells, wrap: 0.02 }, { mode, margin: 0.02, duration }).filter((w) => /30 fps at most/.test(w));
  assert.deepEqual(warned("loop", 1), [
    "the loop needs 64 fps (64 frames in 1s) but Roblox plays a flipbook at 30 fps at most: in game it takes 2.1333s; set duration to 2.1333 or use a smaller grid",
  ]);
  assert.deepEqual(warned("loop", 2.1333), []);
  assert.deepEqual(warned("oneshot", 1), []);
});

test("pngFile with zlib-deflated rows decodes back to the same RGBA", () => {
  const rgba = Uint8Array.from({ length: 4 * 4 * 4 }, (_, i) => (i * 37) % 256);
  const png = pngFile(4, 4, zlib.deflateSync(pngRows(rgba, 4, 4)));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png instanceof Uint8Array && !Buffer.isBuffer(png));
  assert.deepEqual(chunkTypes(png), ["IHDR", "IDAT", "IEND"]);
  for (const c of chunks(png)) assert.equal(c.crc, zlib.crc32(c.body));
  assert.deepEqual(decodeRgba(png), rgba);
});

test("crc32 matches zlib.crc32", () => {
  for (const s of ["", "IEND", "hello vfx"]) assert.equal(crc32(new TextEncoder().encode(s)), zlib.crc32(s));
});

test("apngFile writes acTL, then fcTL+IDAT, then fcTL+fdAT with rising sequence numbers", () => {
  const frame = zlib.deflateSync(pngRows(new Uint8Array(2 * 2 * 4), 2, 2));
  const apng = apngFile(2, 2, [frame, frame, frame], 50);
  assert.deepEqual(chunkTypes(apng), ["IHDR", "acTL", "fcTL", "IDAT", "fcTL", "fdAT", "fcTL", "fdAT", "IEND"]);
  assert.deepEqual(sequenceNumbers(apng), [0, 1, 2, 3, 4]);
  const acTL = chunks(apng)[1].data;
  assert.deepEqual([acTL[3], acTL[7]], [3, 0]); // 3 frames, plays forever
  for (const c of chunks(apng)) assert.equal(c.crc, zlib.crc32(c.body));
});

test("pixels imports nothing from node", () => {
  assert.doesNotMatch(fs.readFileSync(new URL("../src/pixels.js", import.meta.url), "utf8"), /from "node:/);
});
