import * as zlib from "node:zlib";

/**
 * Precomputes the CRC-32 table once for PNG chunk checksumming.
 */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcData = Buffer.concat([typeBuf, data]);
  const crcVal = crc32(crcData);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Generate a standalone RGBA test PNG with an 8x8 checkerboard pattern.
 * Defaults to 64x64 pixels.
 */
export function generateTestPng(width = 64, height = 64): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR chunk: 13 bytes
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA color type
  ihdr[10] = 0; // Deflate compression
  ihdr[11] = 0; // Standard adaptive filter
  ihdr[12] = 0; // No interlacing
  const ihdrChunk = createPngChunk("IHDR", ihdr);

  // Scanlines: 1 filter byte (0 = none) + width * 4 bytes per row
  const lineSize = 1 + width * 4;
  const rawData = Buffer.alloc(lineSize * height);

  for (let y = 0; y < height; y++) {
    const lineOffset = y * lineSize;
    rawData[lineOffset] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const pxOffset = lineOffset + 1 + x * 4;
      const isCheck = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      rawData[pxOffset] = isCheck ? 255 : Math.floor((x / width) * 255);
      rawData[pxOffset + 1] = isCheck ? Math.floor((y / height) * 255) : 80;
      rawData[pxOffset + 2] = isCheck ? 60 : 230;
      rawData[pxOffset + 3] = 255;
    }
  }

  const idatChunk = createPngChunk("IDAT", zlib.deflateSync(rawData));
  const iendChunk = createPngChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}
