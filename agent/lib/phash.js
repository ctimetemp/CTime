import { decodePngGray } from './png.js';

// dHash over a 9x8 box-averaged grayscale grid: 64 bits, rendered as 16 hex chars. It is chosen
// over an average hash because a screen that scrolled a few pixels or shifted a window changes a
// dHash while an aHash can stay identical -- and a false "unchanged" is the failure that would
// silently drop real activity from the record.
//
// This runs on the device, before any upload. The point of the hash is that an unchanged screen
// costs one small event instead of a megabyte of PNG.
const W = 9;
const H = 8;

export function phashFromPng(pngBuffer) {
  const img = decodePngGray(pngBuffer);
  if (!img) return null;
  return dHash(img);
}

function dHash({ width, height, gray }) {
  const cell = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Box average over the source region for this cell.
      const x0 = Math.floor((x * width) / W);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / W));
      const y0 = Math.floor((y * height) / H);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / H));
      let sum = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) { sum += gray[sy * width + sx]; n += 1; }
      }
      cell[y * W + x] = n ? Math.round(sum / n) : 0;
    }
  }
  let bits = '';
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      bits += cell[y * W + x] < cell[y * W + x + 1] ? '1' : '0';
    }
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

export function hamming(hexA, hexB) {
  if (!hexA || !hexB) return Infinity;
  let a;
  let b;
  try {
    a = BigInt(`0x${hexA}`);
    b = BigInt(`0x${hexB}`);
  } catch { return Infinity; }
  let x = a ^ b;
  let n = 0;
  while (x > 0n) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

// Frames within this many differing bits are treated as the same screen. Kept at 0 deliberately
// for v1: "identical" is the claim the notice text makes to the device user, and a tolerant
// threshold would quietly widen what the agent decides not to upload.
export const UNCHANGED_THRESHOLD = 0;

export function isUnchanged(prevHex, nextHex, threshold = UNCHANGED_THRESHOLD) {
  if (!prevHex || !nextHex) return false;
  return hamming(prevHex, nextHex) <= threshold;
}
