// Test doubles and helpers shared by the lab tests: a GPU that draws a disk per cell, a sample node, a temp library.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Draws a disk per cell whose radius grows with the cell's phase (uniform float 5), like a real node would.
export const fakeGpu = (messages = []) => ({
  compiled: [],
  async compile(code) {
    this.compiled.push(code);
    return messages;
  },
  async render({ width, height, cells }) {
    const out = new Uint8Array(width * height * 4);
    for (const { rect, uniforms } of cells) {
      const [x0, y0, w] = rect;
      const radius = (0.1 + 0.3 * uniforms[5]) * w;
      for (let y = y0; y < y0 + w; y += 1) {
        for (let x = x0; x < x0 + w; x += 1) {
          if (Math.hypot(x + 0.5 - x0 - w / 2, y + 0.5 - y0 - w / 2) > radius) continue;
          out.set([255, 128, 64, 204], (y * width + x) * 4); // straight, as vfx_fs_straight writes it
        }
      }
    }
    return out;
  },
});

export const NODE = `// @param glow f32 0..4 = 1.5 core brightness
// @param tint color = #ff8000
fn effect(uv: vec2f) -> vec4f {
  return vec4f(params.tint, length(uv - 0.5) * params.glow);
}
`;

export const textOf = (result) => result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

// A temp library whose path has a space and a non-ASCII letter, as a Windows user folder can.
export function withLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vfx lab ü-"));
  process.env.VFX_LAB_LIBRARY = dir;
  return dir;
}
