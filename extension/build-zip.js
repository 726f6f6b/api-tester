// Packs the extension's runtime files into public/codi-capture-extension.zip so
// the tester can offer it as a direct download. Pure JS (stored/no-compression
// ZIP) — no dependencies. Run: node extension/build-zip.js
const fs = require('fs');
const path = require('path');

const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

// Keep the extension's copy of the shared serializer in sync with public/.
fs.copyFileSync(
  path.join(__dirname, '..', 'public', 'capture-core.js'),
  path.join(__dirname, 'capture-core.js')
);

// Files that make up the loadable extension (dev scripts excluded).
const NAMES = [
  'manifest.json', 'background.js', 'capture-core.js', 'options.html', 'options.js',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png',
];

const locals = [];
const central = [];
let offset = 0;

for (const name of NAMES) {
  const data = fs.readFileSync(path.join(__dirname, name));
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);            // version needed
  lh.writeUInt16LE(0, 6);             // flags
  lh.writeUInt16LE(0, 8);             // method: store
  lh.writeUInt16LE(0, 10);            // mod time
  lh.writeUInt16LE(0x21, 12);         // mod date (1980-01-01)
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(data.length, 18);  // compressed size
  lh.writeUInt32LE(data.length, 22);  // uncompressed size
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);            // extra len
  locals.push(lh, nameBuf, data);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);            // version made by
  ch.writeUInt16LE(20, 6);            // version needed
  ch.writeUInt16LE(0, 8);
  ch.writeUInt16LE(0, 10);
  ch.writeUInt16LE(0, 12);
  ch.writeUInt16LE(0x21, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(data.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28);
  ch.writeUInt16LE(0, 30);            // extra
  ch.writeUInt16LE(0, 32);            // comment
  ch.writeUInt16LE(0, 34);            // disk start
  ch.writeUInt16LE(0, 36);            // internal attrs
  ch.writeUInt32LE(0, 38);            // external attrs
  ch.writeUInt32LE(offset, 42);       // local header offset
  central.push(ch, nameBuf);

  offset += lh.length + nameBuf.length + data.length;
}

const localPart = Buffer.concat(locals);
const centralPart = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(NAMES.length, 8);
eocd.writeUInt16LE(NAMES.length, 10);
eocd.writeUInt32LE(centralPart.length, 12);
eocd.writeUInt32LE(localPart.length, 16);

const out = path.join(__dirname, '..', 'public', 'codi-capture-extension.zip');
fs.writeFileSync(out, Buffer.concat([localPart, centralPart, eocd]));
console.log('wrote', path.relative(path.join(__dirname, '..'), out), `(${NAMES.length} files)`);
