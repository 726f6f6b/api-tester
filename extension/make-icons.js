// Generates the extension's PNG icons (the Codi face: dark rounded square with a
// white ring + two eyes) at 16/32/48/128 px. No dependencies — hand-rolled PNG
// encoder. Run: node make-icons.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) { const body = Buffer.concat([Buffer.from(type, 'ascii'), data]); return Buffer.concat([u32(data.length), body, u32(crc32(body))]); }
function encodePNG(S, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.concat([u32(S), u32(S), Buffer.from([8, 6, 0, 0, 0])]);
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function render(S) {
  const SS = 4, N = S * SS, c = N / 2;             // supersample for antialiasing
  const half = N / 2, cornerR = 0.22 * N;
  const rOuter = 0.40 * N, ringHalf = 0.052 * N;
  const eyeR = 0.075 * N, eyeDx = 0.165 * N;
  const bg = [22, 25, 29], white = [255, 255, 255];
  const big = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const rx = Math.max(Math.abs(x - c) - (half - cornerR), 0);
    const ry = Math.max(Math.abs(y - c) - (half - cornerR), 0);
    const inRound = Math.abs(x - c) <= half && Math.abs(y - c) <= half && Math.hypot(rx, ry) <= cornerR;
    let col = null;
    if (inRound) {
      col = bg;
      const d = Math.hypot(x - c, y - c);
      if (Math.abs(d - rOuter) <= ringHalf) col = white;
      if (Math.hypot(x - (c - eyeDx), y - c) <= eyeR) col = white;
      if (Math.hypot(x - (c + eyeDx), y - c) <= eyeR) col = white;
    }
    const i = (y * N + x) * 4;
    if (col) { big[i] = col[0]; big[i + 1] = col[1]; big[i + 2] = col[2]; big[i + 3] = 255; }
  }
  // box-downsample to S
  const out = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) {
      const i = (((y * SS + dy) * N) + (x * SS + dx)) * 4;
      r += big[i]; g += big[i + 1]; b += big[i + 2]; a += big[i + 3];
    }
    const n = SS * SS, o = (y * S + x) * 4;
    out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
  }
  return out;
}

const dir = path.join(__dirname, 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const S of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(dir, `icon${S}.png`), encodePNG(S, render(S)));
  console.log('wrote icons/icon' + S + '.png');
}
