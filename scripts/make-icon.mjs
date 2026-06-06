// Generates a 1024×1024 "Turbo the Cat" source icon (no deps, pure zlib PNG).
// Run: node scripts/make-icon.mjs  →  src-tauri/icons/source.png
// Then: pnpm tauri icon src-tauri/icons/source.png
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const W = 1024,
  H = 1024;
const buf = Buffer.alloc(W * H * 4); // RGBA, transparent by default

const NAVY = [28, 30, 38];
const TEAL_TOP = [94, 224, 200];
const TEAL_BOT = [59, 191, 166];
const WHITE = [240, 244, 252];
const PINK = [255, 138, 209];

const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function put(x, y, c) {
  const i = (y * W + x) * 4;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
  buf[i + 3] = c[3] ?? 255;
}

const insideRR = (x, y, m = 28, rad = 184) => {
  if (x < m || x > W - m || y < m || y > H - m) return false;
  const nx = Math.max(m + rad - x, x - (W - m - rad), 0);
  const ny = Math.max(m + rad - y, y - (H - m - rad), 0);
  return nx === 0 || ny === 0 || nx * nx + ny * ny <= rad * rad;
};

const dist2 = (x, y, cx, cy) => (x - cx) ** 2 + (y - cy) ** 2;

// point-in-triangle via sign test
function inTri(px, py, a, b, c) {
  const s = (p, q, r) =>
    (px - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (py - r[1]);
  const d1 = s(0, a, b),
    d2 = s(0, b, c),
    d3 = s(0, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

const earL = [[210, 320], [330, 60], [470, 300]];
const earR = [[814, 320], [694, 60], [554, 300]];
const earLin = [[260, 290], [338, 130], [430, 285]];
const earRin = [[764, 290], [686, 130], [594, 285]];
const nose = [[478, 612], [546, 612], [512, 664]];

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!insideRR(x, y)) continue;
    let c = lerp(TEAL_TOP, TEAL_BOT, y / H); // background gradient

    // ears (outer navy, inner pink)
    if (inTri(x, y, ...earL) || inTri(x, y, ...earR)) c = NAVY;
    if (inTri(x, y, ...earLin) || inTri(x, y, ...earRin)) c = PINK;

    // head
    if (dist2(x, y, 512, 580) <= 300 * 300) c = NAVY;

    // eyes: teal iris, navy pupil, white glint
    for (const ex of [430, 594]) {
      if (dist2(x, y, ex, 560) <= 80 * 80) c = TEAL_TOP;
      if (dist2(x, y, ex, 560) <= 42 * 42) c = NAVY;
      if (dist2(x, y, ex - 18, 542) <= 15 * 15) c = WHITE;
    }

    // nose
    if (inTri(x, y, ...nose)) c = PINK;

    put(x, y, c);
  }
}

// ---- encode PNG ----
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
// raw scanlines with filter byte 0
const raw = Buffer.alloc(H * (W * 4 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
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
