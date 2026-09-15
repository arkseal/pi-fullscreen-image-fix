import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateTestPng } from "../png.ts";

describe("generateTestPng", () => {
  it("generates a valid RGBA PNG buffer with standard signature and headers", () => {
    const width = 64;
    const height = 64;
    const buf = generateTestPng(width, height);

    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 50, "PNG output must be non-empty");

    // Standard PNG signature: 89 50 4E 47 0D 0A 1A 0A
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < pngSignature.length; i++) {
      assert.equal(buf[i], pngSignature[i], `PNG signature byte at ${i} mismatch`);
    }

    // Verify IHDR chunk dimensions (16..19 width, 20..23 height)
    assert.equal(buf.readUInt32BE(16), width, "IHDR width mismatch");
    assert.equal(buf.readUInt32BE(20), height, "IHDR height mismatch");
  });

  it("supports customizable dimensions", () => {
    const buf = generateTestPng(32, 16);
    assert.equal(buf.readUInt32BE(16), 32);
    assert.equal(buf.readUInt32BE(20), 16);
  });
});
