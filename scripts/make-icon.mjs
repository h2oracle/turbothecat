// Generates a 1024×1024 "Turbo the Cat" source icon (no deps, pure zlib PNG).
// It renders the same minimal white cat as the in-app mascot (src/face.ts):
// attached ears, almond green eyes, pink nose, whiskers and a smile, on a dark
// rounded square with a soft teal brand glow. 4× supersampled for clean edges.
// Run: node scripts/make-icon.mjs  →  src-tauri/icons/source.png
// Then: pnpm tauri icon src-tauri/icons/source.png
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const W = 1024;
const H = 1024;
const SS = 4; // supersampling factor (SS×SS samples per pixel)
const buf = Buffer.alloc(W * H * 4); // RGBA, transparent by default

// ———— palette (matches the in-app mascot: white cat on near-black) ————
const BG_TOP = [18, 19, 24];
const BG_BOT = [8, 8, 11];
const WHITE = [244, 246, 251];
const PUPIL = [10, 10, 13];
const GLINT = [255, 255, 255];

const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ———— rounded-square mask (icon space, 0..1024) ————
function insideRR(x, y, m = 64, rad = 224) {
  if (x < m || x > W - m || y < m || y > H - m) return false;
  const nx = Math.max(m + rad - x, x - (W - m - rad), 0);
  const ny = Math.max(m + rad - y, y - (H - m - rad), 0);
  return nx === 0 || ny === 0 || nx * nx + ny * ny <= rad * rad;
}

// ———— geometry helpers (all in face.ts 0..100 space) ————
function inTri(px, py, a, b, c) {
  const s = (p, q, r) => (px - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (py - r[1]);
  const d1 = s(0, a, b);
  const d2 = s(0, b, c);
  const d3 = s(0, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
const inEllipse = (px, py, cx, cy, rx, ry) =>
  ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1;
const inCircle = (px, py, cx, cy, r) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r;

function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
// distance to a quadratic bézier (sampled) — for the curved smile
function distQuad(px, py, p0, c, p2) {
  let best = Infinity;
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const u = 1 - t;
    const bx = u * u * p0[0] + 2 * u * t * c[0] + t * t * p2[0];
    const by = u * u * p0[1] + 2 * u * t * c[1] + t * t * p2[1];
    const d = (px - bx) ** 2 + (py - by) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// ———— cat shapes (face.ts coords, slightly bolder ears) ————
const S = 0.94; // inset the cat a touch from the icon edge
const earL = [[30, 33], [22, 11], [46, 27]];
const earR = [[70, 33], [78, 11], [54, 27]];
const noseTri = [[46.5, 64], [53.5, 64], [50, 69.5]];
const whiskers = [
  [13, 66, 30, 67],
  [12, 72, 30, 71],
  [87, 66, 70, 67],
  [88, 72, 70, 71],
];

// Colour of the cat face at a face-space point (ux,uy); returns an RGB triple.
function catColor(ux, uy, base) {
  // ears (solid white, like the mascot)
  if (inTri(ux, uy, ...earL) || inTri(ux, uy, ...earR)) return WHITE;

  // whiskers (thin white strokes)
  for (const [x1, y1, x2, y2] of whiskers) {
    if (distSeg(ux, uy, x1, y1, x2, y2) < 0.85) return WHITE;
  }

  // eyes: round white with a big dark pupil glancing toward centre + a glint
  for (const ex of [36, 64]) {
    if (inEllipse(ux, uy, ex, 51, 9.2, 10.5)) {
      const pcx = ex + (ex < 50 ? 1.4 : -1.4); // pupils look inward
      const pcy = 52.2; // ...and slightly down
      if (inCircle(ux, uy, pcx - 2.1, pcy - 2.4, 1.7)) return GLINT;
      if (inCircle(ux, uy, pcx, pcy, 6.0)) return PUPIL;
      return WHITE;
    }
  }

  // nose (white, like the mascot)
  if (inTri(ux, uy, ...noseTri)) return WHITE;

  // smile (white curved stroke)
  if (distQuad(ux, uy, [41, 74], [50, 80], [59, 74]) < 1.5) return WHITE;

  return base;
}

// ———— render with supersampling ————
const total = SS * SS;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let cov = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const fx = x + (sx + 0.5) / SS;
        const fy = y + (sy + 0.5) / SS;
        if (!insideRR(fx, fy)) continue;
        cov++;
        // background: flat near-black with a whisper of vertical gradient
        const base = lerp(BG_TOP, BG_BOT, fy / H);
        // into face space
        const ux = (fx / W) * (100 / S) - (100 / S - 100) / 2;
        const uy = (fy / H) * (100 / S) - (100 / S - 100) / 2;
        const c = catColor(ux, uy, base);
        r += c[0];
        g += c[1];
        b += c[2];
      }
    }
    if (!cov) continue; // stays transparent
    const i = (y * W + x) * 4;
    buf[i] = Math.round(r / cov);
    buf[i + 1] = Math.round(g / cov);
    buf[i + 2] = Math.round(b / cov);
    buf[i + 3] = Math.round((cov / total) * 255);
  }
}

// ———— encode PNG ————
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(H * (W * 4 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0; // filter byte 0
  buf.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(new URL("../src-tauri/icons/", import.meta.url), { recursive: true });
const out = new URL("../src-tauri/icons/source.png", import.meta.url);
writeFileSync(out, png);
console.log("wrote", out.pathname, png.length, "bytes");
