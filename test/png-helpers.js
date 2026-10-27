// Test helpers that read PNG and APNG files back: the chunk list, the decoded RGBA of a plain PNG.
import zlib from "node:zlib";

export function chunks(png) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const list = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    list.push({ type, data: png.subarray(at + 8, at + 8 + length), crc: view.getUint32(at + 8 + length), body: png.subarray(at + 4, at + 8 + length) });
    at += 12 + length;
  }
  return list;
}

export const chunkTypes = (png) => chunks(png).map((c) => c.type);

// fcTL and fdAT carry a sequence number in their first 4 bytes.
export const sequenceNumbers = (png) =>
  chunks(png)
    .filter((c) => c.type === "fcTL" || c.type === "fdAT")
    .map((c) => new DataView(c.data.buffer, c.data.byteOffset).getUint32(0));

export function decodeRgba(png) {
  const list = chunks(png);
  const header = new DataView(list[0].data.buffer, list[0].data.byteOffset);
  const [width, height] = [header.getUint32(0), header.getUint32(4)];
  const rows = zlib.inflateSync(Buffer.concat(list.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) out.set(rows.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  return out;
}
