import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

// Minimal PNG decoder for the single job of turning a screenshot into grayscale pixels so a
// perceptual hash can be computed before anything is uploaded. A full image library is not
// available under the zero-dependency rule, and pulling one in for hashing would be the whole
// reason to have one.
//
// Supports what a Windows screen capture actually produces: bit depth 8, non-interlaced, colour
// types 0 (gray), 2 (RGB), 3 (palette), 6 (RGBA). Anything else returns null and the caller
// treats the frame as "cannot tell" and uploads it.

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePngGray(source) {
  const buf = typeof source === 'string' ? readFileSync(source) : source;
  if (!buf || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return null;
  let off = 8;
  let ihdr = null;
  const idat = [];
  let palette = null;
  let trns = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    off += 12 + len;
    if (len > buf.length) break;
  }
  if (!ihdr) return null;
  if (ihdr.depth !== 8 || ihdr.interlace !== 0) return null;
  if (![0, 2, 3, 4, 6].includes(ihdr.color)) return null;
  const { width, height, color } = ihdr;
  const channels = color === 0 ? 1 : color === 2 ? 3 : color === 3 ? 1 : color === 4 ? 2 : 4;
  let raw;
  try {
    // PNG's compressed payload is a zlib stream (RFC 1950) with its own 2-byte header, not raw
    // deflate -- inflateRawSync throws Z_DATA_ERROR on every real PNG.
    raw = inflateSync(Buffer.concat(idat));
  } catch { return null; }
  const stride = width * channels;
  if (raw.length < stride * height + height) return null;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    switch (filter) {
      case 0: line.copy(cur); break;
      case 1: // Sub
        for (let x = 0; x < stride; x++) {
          const a = x >= channels ? cur[x - channels] : 0;
          cur[x] = (line[x] + a) & 0xff;
        }
        break;
      case 2: // Up
        for (let x = 0; x < stride; x++) cur[x] = (line[x] + prev[x]) & 0xff;
        break;
      case 3: // Average
        for (let x = 0; x < stride; x++) {
          const a = x >= channels ? cur[x - channels] : 0;
          cur[x] = (line[x] + ((a + prev[x]) >> 1)) & 0xff;
        }
        break;
      case 4: // Paeth
        for (let x = 0; x < stride; x++) {
          const a = x >= channels ? cur[x - channels] : 0;
          const b = prev[x];
          const c = x >= channels ? prev[x - channels] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          cur[x] = (line[x] + pred) & 0xff;
        }
        break;
      default:
        return null;
    }
    cur.copy(prev);
  }
  // Rec. 709 luma weights; the point is only relative brightness, not colour fidelity.
  const gray = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    if (color === 0) {
      gray[i] = out[p];
    } else if (color === 3) {
      // A palette pixel is an index: expand to the RGB triplet before taking luma. Reading only
      // the index byte would make every palette screenshot a near-identical hash.
      const idx = out[p];
      const r = palette?.[idx * 3] ?? idx;
      const g = palette?.[idx * 3 + 1] ?? idx;
      const b = palette?.[idx * 3 + 2] ?? idx;
      gray[i] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    } else if (color === 2) {
      gray[i] = Math.round(0.2126 * out[p] + 0.7152 * out[p + 1] + 0.0722 * out[p + 2]);
    } else if (color === 4) {
      gray[i] = out[p];
    } else {
      if (trns && out[p + 3] === 0) { gray[i] = 255; continue; }
      gray[i] = Math.round(0.2126 * out[p] + 0.7152 * out[p + 1] + 0.0722 * out[p + 2]);
    }
  }
  return { width, height, gray };
}
