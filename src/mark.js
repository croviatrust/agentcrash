// The agentcrash mark: the quartered target of a crash test, one quarter in the
// red of an exposed cell. One description, drawn as SVG for pages and as pixels
// for the PNGs the site build writes without a dependency.
export const INK = '#e8e6e1';
export const RED = '#ff6b5e';
export const NIGHT = '#0c0d10';

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// The shapes on a 64 x 64 canvas. A small rendering needs a heavier ring.
export function markShapes({ ink = INK, accent = RED, ring = 4 } = {}) {
  return `<circle cx="32" cy="32" r="${29 - ring / 2}" fill="none" stroke="${ink}" stroke-width="${ring}"/>`
    + `<path d="M32 32V3A29 29 0 0 1 61 32Z" fill="${accent}"/>`
    + `<path d="M32 32V61A29 29 0 0 1 3 32Z" fill="${ink}"/>`;
}

// attrs: extra attributes of the <svg>, e.g. ' class="mark" width="20" height="20" aria-hidden="true"'.
export function markSvg({ attrs = '', ...shapes } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"${attrs}>${markShapes(shapes)}</svg>`;
}

// The mark on its own dark tile, so a browser tab shows it on a light theme too.
const TILE = { inset: 5 / 32, ring: 7 };
export function iconSvg() {
  const side = 32 * (1 - 2 * TILE.inset);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="${NIGHT}"/>`
    + `<g transform="translate(${32 * TILE.inset} ${32 * TILE.inset}) scale(${side / 64})">${markShapes({ ring: TILE.ring })}</g></svg>\n`;
}

// Paints the mark into an RGB buffer (three bytes a pixel, `stride` pixels a
// row) over whatever is there, antialiased with 4 x 4 samples a pixel.
export function paintMark(px, stride, x0, y0, size, { ink = INK, accent = RED, ring = 4 } = {}) {
  const n = 4, total = n * n, inner = 29 - ring;
  const inkRgb = rgb(ink), accentRgb = rgb(accent);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let red = 0, light = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const u = (x + (sx + 0.5) / n) * 64 / size - 32;
          const v = (y + (sy + 0.5) / n) * 64 / size - 32;
          const d = Math.hypot(u, v);
          if (d > 29) continue;
          if (u >= 0 && v <= 0) red++;
          else if ((u <= 0 && v >= 0) || d >= inner) light++;
        }
      }
      if (!red && !light) continue;
      const o = ((y0 + y) * stride + x0 + x) * 3;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round((accentRgb[c] * red + inkRgb[c] * light + px[o + c] * (total - red - light)) / total);
    }
  }
}

// The tile as pixels: an RGB buffer of side x side, for the icons a browser or
// a phone wants as PNG.
export function iconPixels(side) {
  const px = Buffer.alloc(side * side * 3);
  const night = rgb(NIGHT);
  for (let i = 0; i < side * side; i++) px.set(night, i * 3);
  const inset = Math.round(side * TILE.inset);
  paintMark(px, side, inset, inset, side - 2 * inset, { ring: TILE.ring });
  return px;
}
