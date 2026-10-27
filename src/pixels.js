// The browser-safe pixel half of the lab: colour spread into transparent pixels, per-frame stats, the quality
// warnings, views for looking at a sheet, and PNG/APNG files. The MCP and the page both import it. No Node APIs:
// a caller deflates the rows itself (zlib in Node, CompressionStream in the browser) and hands the bytes in.
import { round } from "./core.js";

const BACKDROPS = { dark: [22, 24, 28], light: [233, 233, 236] };
// Roblox plays a Loop flipbook at FlipbookFramerate, 30 fps at most (a OneShot spans the particle's lifetime instead).
export const ROBLOX_MAX_FPS = 30;
// Edge alpha above 5/255 shows as a cut line.
export const EDGE_LIMIT = 0.02;

// Copies each drawn pixel's RGB into the transparent pixels nearest to it inside its cell (one BFS per cell, so
// O(pixels)), so filtering and mipmaps never pull black into an edge: the dark halo on particles. Alpha is unchanged.
export function dilate(rgba, width, rects) {
  const out = Uint8Array.from(rgba);
  const size = Math.max(0, ...rects.map(([, , w, h]) => w * h));
  const queue = new Int32Array(size);
  const seen = new Uint8Array(size);
  for (const [x0, y0, w, h] of rects) {
    seen.fill(0, 0, w * h);
    let head = 0;
    let tail = 0;
    for (let y = 0; y < h; y += 1) {
      const row = ((y0 + y) * width + x0) * 4 + 3;
      for (let x = 0; x < w; x += 1) {
        if (out[row + x * 4] === 0) continue;
        seen[y * w + x] = 1;
        queue[tail++] = y * w + x;
      }
    }
    if (tail === 0 || tail === w * h) continue;
    // Hot loop: no closure, no allocation; offsets in the sheet are cell-local index + a per-row shift.
    const shift = y0 * width + x0;
    while (head < tail) {
      const local = queue[head++];
      const x = local % w;
      const y = (local - x) / w;
      const from = (shift + y * width + x) * 4;
      for (let k = 0; k < 4; k += 1) {
        const nx = k === 0 ? x - 1 : k === 1 ? x + 1 : x;
        const ny = k === 2 ? y - 1 : k === 3 ? y + 1 : y;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const next = ny * w + nx;
        if (seen[next] === 1) continue;
        seen[next] = 1;
        queue[tail++] = next;
        const to = (shift + ny * width + nx) * 4;
        out[to] = out[from];
        out[to + 1] = out[from + 1];
        out[to + 2] = out[from + 2];
      }
    }
  }
  return out;
}

// Per frame: coverage (share of the cell drawn), peak alpha, alpha on the edge just inside the margin, share of the
// drawn pixels at full white, and mean alpha change from the frame before. wrap: change from the last to the first.
export function cellStats(rgba, width, rects, pad) {
  let first = null;
  let previous = null;
  const diff = (a, b) => {
    let sum = 0;
    for (let k = 0; k < a.length; k += 1) sum += Math.abs(a[k] - b[k]);
    return round(sum / (a.length * 255), 4);
  };
  const cells = rects.map(([x0, y0, w, h], frame) => {
    const alpha = new Uint8Array(w * h);
    let drawn = 0, full = 0, peak = 0, edge = 0;
    const [ex0, ey0, ex1, ey1] = [x0 + pad, y0 + pad, x0 + w - pad - 1, y0 + h - pad - 1];
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) {
        const i = (y * width + x) * 4;
        const a = rgba[i + 3];
        alpha[(y - y0) * w + (x - x0)] = a;
        peak = Math.max(peak, a);
        if (a >= 8) {
          drawn += 1;
          if (a >= 250 && Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) >= 250) full += 1;
        }
        const onEdge = (x === ex0 || x === ex1 || y === ey0 || y === ey1) && x >= ex0 && x <= ex1 && y >= ey0 && y <= ey1;
        if (onEdge) edge = Math.max(edge, a);
      }
    }
    const change = previous ? diff(alpha, previous) : null;
    previous = alpha;
    first ??= alpha;
    return { frame, coverage: round(drawn / (w * h), 4), peak: round(peak / 255), edge: round(edge / 255), full: drawn ? round(full / drawn) : 0, change };
  });
  return { cells, wrap: rects.length > 1 ? diff(previous, first) : 0 };
}

export function bakeWarnings({ cells, wrap }, { mode, margin, duration }) {
  const frames = (list) => list.map((c) => c.frame).join(", ");
  if (cells.every((c) => c.coverage === 0)) return ["every frame is empty: effect() returns alpha 0 everywhere (alpha is the 4th component)"];
  const warnings = [];
  // Any visible alpha on the edge cuts the particle in game. Only a still with margin 0 (made to tile on a Beam or a
  // Trail) may reach it; flipbook frames are particles even with margin 0.
  const cut = margin > 0 || cells.length > 1 ? cells.filter((c) => c.edge > EDGE_LIMIT) : [];
  if (cut.length > 0) {
    warnings.push(`frames ${frames(cut)} touch the cell edge (alpha up to ${Math.max(...cut.map((c) => c.edge))}): the shape looks cut in game; keep it inside uv 0.05..0.95 or fade it before the edge`);
  }
  if (cells.length > 1 && cells[0].coverage === 0) warnings.push("frame 0 is empty: devices that switch flipbooks off show only frame 0");
  const empty = cells.filter((c) => c.coverage === 0);
  if (cells.length > 1 && empty.length > 0) warnings.push(`frames ${frames(empty)} are empty (fine for the last frames of a OneShot, wasted cells elsewhere)`);
  // 0.01 of slack: 30 fps typed in the viewer stores the duration rounded to 4 decimals (64 / 2.1333 = 30.0005).
  if (mode === "loop" && cells.length > 1 && cells.length / duration > ROBLOX_MAX_FPS + 0.01) {
    const inGame = round(cells.length / ROBLOX_MAX_FPS, 4);
    warnings.push(`the loop needs ${round(cells.length / duration, 2)} fps (${cells.length} frames in ${duration}s) but Roblox plays a flipbook at 30 fps at most: in game it takes ${inGame}s; set duration to ${inGame} or use a smaller grid`);
  }
  const flat = cells.filter((c) => c.full > 0.5);
  if (flat.length > 0) warnings.push(`frames ${frames(flat)} are over half full white: the shape reads flat; keep full brightness for a core or an accent`);
  const changes = cells.map((c) => c.change).filter((v) => v !== null).sort((a, b) => a - b);
  if (changes.length > 0) {
    const median = changes[Math.floor(changes.length / 2)];
    if (median < 0.002) warnings.push("the frames barely change: the sheet plays like a still image");
    if (mode === "loop" && wrap > 3 * median + 0.01) {
      warnings.push(`the loop jumps from the last frame to the first (change ${wrap}, median ${median}): make the motion periodic in vfx.phase`);
    }
  }
  return warnings;
}

// Opaque RGBA for looking at: over a backdrop, or alpha as grey.
export function composite(rgba, width, height, backdrop) {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const a = rgba[i + 3] / 255;
      out[i + 3] = 255;
      if (backdrop === "alpha") {
        out.fill(rgba[i + 3], i, i + 3);
        continue;
      }
      const bg = backdrop === "checker" ? ((((x >> 3) + (y >> 3)) & 1) === 1 ? [61, 61, 61] : [43, 43, 43]) : BACKDROPS[backdrop];
      for (let c = 0; c < 3; c += 1) out[i + c] = Math.round(rgba[i + c] * a + bg[c] * (1 - a));
    }
  }
  return out;
}

// Grey lines between cells (preview images only).
export function drawGrid(rgba, width, height, cell) {
  const out = Uint8Array.from(rgba);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((x > 0 && x % cell === 0) || (y > 0 && y % cell === 0)) out.set([96, 96, 104, 255], (y * width + x) * 4);
    }
  }
  return out;
}

export function downscale(rgba, width, height, factor) {
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy += 1) for (let dx = 0; dx < factor; dx += 1) sum += rgba[((y * factor + dy) * width + x * factor + dx) * 4 + c];
        out[(y * w + x) * 4 + c] = Math.round(sum / (factor * factor));
      }
    }
  }
  return { rgba: out, width: w, height: h };
}

// One rectangle of an RGBA image as its own image.
export function crop(rgba, width, x0, y0, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) out.set(rgba.subarray(((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + w) * 4), y * w * 4);
  return out;
}

// ---------- PNG and APNG ----------

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32 = (...values) => {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint32(i * 4, v));
  return out;
};

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function chunk(type, data) {
  const body = concat([new TextEncoder().encode(type), data]);
  return concat([u32(data.length), body, u32(crc32(body))]);
}

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
// 8-bit RGBA, no interlace.
const header = (width, height) => chunk("IHDR", concat([u32(width, height), Uint8Array.from([8, 6, 0, 0, 0])]));

// The raw scanlines a PNG deflates: filter byte 0, then the row's RGBA. The caller deflates them (zlib format).
export function pngRows(rgba, width, height) {
  const rows = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return rows;
}

// A PNG file around rows already deflated by the caller.
export function pngFile(width, height, idat) {
  return concat([SIGNATURE, header(width, height), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]);
}

// An animated PNG that plays forever, each frame `delayMs` long. Every frame is full size and replaces the last
// (dispose 0, blend 0: source), so a straight-alpha frame never draws over the one before.
export function apngFile(width, height, frames, delayMs) {
  let sequence = 0;
  const control = () => chunk("fcTL", concat([u32(sequence++, width, height, 0, 0), Uint8Array.from([delayMs >> 8, delayMs & 0xff, 0x03, 0xe8, 0, 0])]));
  const parts = [SIGNATURE, header(width, height), chunk("acTL", u32(frames.length, 0))];
  frames.forEach((data, index) => {
    parts.push(control());
    parts.push(index === 0 ? chunk("IDAT", data) : chunk("fdAT", concat([u32(sequence++), data])));
  });
  parts.push(chunk("IEND", new Uint8Array(0)));
  return concat(parts);
}

