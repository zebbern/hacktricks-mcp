#!/usr/bin/env node
/**
 * Draws the plugin icon, .claude-plugin/icon.png: a terminal prompt on a dark
 * square. No image library: the picture is composed pixel by pixel, at four
 * samples a pixel, and written as a PNG with node:zlib. The mark is deliberately
 * not HackTricks' own artwork.
 *
 * Change the shapes or the colours below and run:  node scripts/make-icon.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const SAMPLES = 4;
const BACKGROUND = [15, 23, 42]; // slate 950
const PROMPT = [74, 222, 128]; // green 400
const CURSOR = [248, 250, 252]; // slate 50
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".claude-plugin", "icon.png");

// Signed distances, negative inside.
const segment = (x, y, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
};
const roundedRect = (x, y, cx, cy, halfWidth, halfHeight, radius) => {
  const qx = Math.abs(x - cx) - (halfWidth - radius);
  const qy = Math.abs(y - cy) - (halfHeight - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
};

const STROKE = 88;
const tile = (x, y) => roundedRect(x, y, SIZE / 2, SIZE / 2, SIZE / 2, SIZE / 2, 208);
const chevron = (x, y) => Math.min(segment(x, y, 290, 322, 506, 512), segment(x, y, 506, 512, 290, 702)) - STROKE / 2;
const cursor = (x, y) => roundedRect(x, y, 650, 658, 86, STROKE / 2, STROKE / 2);

/** The colour of one sample: the topmost shape that holds it, else transparent. */
const sample = (x, y) => {
  if (chevron(x, y) <= 0) return PROMPT;
  if (cursor(x, y) <= 0) return CURSOR;
  if (tile(x, y) <= 0) return BACKGROUND;
  return null;
};

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let py = 0; py < SIZE; py++) {
  const rowStart = py * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter type: none
  for (let px = 0; px < SIZE; px++) {
    let red = 0;
    let green = 0;
    let blue = 0;
    let covered = 0;
    for (let sy = 0; sy < SAMPLES; sy++) {
      for (let sx = 0; sx < SAMPLES; sx++) {
        const colour = sample(px + (sx + 0.5) / SAMPLES, py + (sy + 0.5) / SAMPLES);
        if (!colour) continue;
        red += colour[0];
        green += colour[1];
        blue += colour[2];
        covered++;
      }
    }
    const at = rowStart + 1 + px * 4;
    raw[at] = covered ? Math.round(red / covered) : 0;
    raw[at + 1] = covered ? Math.round(green / covered) : 0;
    raw[at + 2] = covered ? Math.round(blue / covered) : 0;
    raw[at + 3] = Math.round((255 * covered) / (SAMPLES * SAMPLES));
  }
}

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bits a sample
header[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", header),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
fs.writeFileSync(OUT, png);
console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${SIZE} x ${SIZE}, ${(png.length / 1024).toFixed(0)} KB`);
