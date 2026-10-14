'use strict';
// 生成 PWA 图标（无第三方依赖，用 Node 内置 zlib）
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function png(size, pixelFn) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelFn(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// 5x7 点阵字母 E 和 N
const E = ['11111', '10000', '10000', '11110', '10000', '10000', '11111'];
const N = ['10001', '11001', '10101', '10011', '10001', '10001', '10001'];

function makeIcon(size) {
  const totalCells = 5 + 1 + 5; // E + 间隔 + N
  const cell = Math.floor(size / (totalCells + 4));
  const textW = totalCells * cell;
  const textH = 7 * cell;
  const ox = Math.floor((size - textW) / 2);
  const oy = Math.floor((size - textH) / 2);

  return png(size, (x, y) => {
    const t = y / size;
    const r = Math.round(14 + (99 - 14) * t);
    const g = Math.round(165 + (102 - 165) * t);
    const b = Math.round(233 + (241 - 233) * t);

    const cx = x - ox, cy = y - oy;
    if (cx >= 0 && cy >= 0 && cx < textW && cy < textH) {
      const cellX = Math.floor(cx / cell);
      const cellY = Math.floor(cy / cell);
      let glyph = null, gx = cellX;
      if (cellX < 5) { glyph = E; gx = cellX; }
      else if (cellX >= 6) { glyph = N; gx = cellX - 6; }
      if (glyph && cellY < 7 && glyph[cellY][gx] === '1') return [255, 255, 255];
    }
    return [r, g, b];
  });
}

const dir = path.join(__dirname, 'icons');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon-192.png'), makeIcon(192));
fs.writeFileSync(path.join(dir, 'icon-512.png'), makeIcon(512));
console.log('icons generated');
