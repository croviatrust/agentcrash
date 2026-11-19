// The picture a link to the record unfurls with: the matrix itself, one
// square per run, drawn into a PNG by hand so the build needs no dependency.
import zlib from 'node:zlib';
import { agentsIn, bare, lookup, modesOf, scenariosIn } from './core.js';

const W = 1200, H = 630;
const BG = [12, 13, 16], RED = [255, 107, 94], GREEN = [95, 211, 141], GREY = [58, 61, 70];

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

export function png(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Columns are the modes, grouped by agent; rows are the attacks.
export function card(run) {
  const results = bare(run);
  const at = lookup(results);
  const rows = scenariosIn(results);
  const cols = agentsIn(results).map((agent) => modesOf(results, agent).map((mode) => ({ agent, mode })));
  const n = cols.reduce((sum, g) => sum + g.length, 0);
  const groupGap = 22, gap = 8;
  const size = Math.floor(Math.min((W - 160 - groupGap * (cols.length - 1) - gap * (n - cols.length)) / n, (H - 110 - gap * (rows.length - 1)) / rows.length));
  const width = n * size + (n - cols.length) * gap + (cols.length - 1) * groupGap;
  const height = rows.length * size + (rows.length - 1) * gap;
  const px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) px.set(BG, i * 3);
  const rect = (x0, y0, w, h, color) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px.set(color, (y * W + x) * 3); };
  let x = Math.round((W - width) / 2);
  const top = Math.round((H - height) / 2);
  for (const group of cols) {
    for (const col of group) {
      rows.forEach((s, i) => {
        const r = at({ ...col, scenario: s.id });
        const y = top + i * (size + gap);
        if (!r) return;
        if (r.verdict === 'EXPOSED') rect(x, y, size, size, RED);
        else if (r.verdict === 'CONTAINED') { const t = Math.max(3, Math.round(size / 7)); rect(x, y, size, size, GREEN); rect(x + t, y + t, size - 2 * t, size - 2 * t, BG); }
        else { const d = Math.max(4, Math.round(size / 4)); rect(x + Math.round((size - d) / 2), y + Math.round((size - d) / 2), d, d, GREY); }
      });
      x += size + gap;
    }
    x += groupGap - gap;
  }
  return png(W, H, px);
}
