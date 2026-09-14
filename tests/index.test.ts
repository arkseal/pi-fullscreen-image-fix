import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateTestPng } from "../index.ts";
import fullscreenImageFixPlugin from "../index.ts";

describe("generateTestPng", () => {
  it("generates a valid 64x64 PNG buffer with PNG signature and chunks", () => {
    const buf = generateTestPng(64, 64);
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.length > 50, "Buffer should have reasonable PNG size");

    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    assert.equal(buf[0], 0x89);
    assert.equal(buf[1], 0x50);
    assert.equal(buf[2], 0x4e);
    assert.equal(buf[3], 0x47);
    assert.equal(buf[4], 0x0d);
    assert.equal(buf[5], 0x0a);
    assert.equal(buf[6], 0x1a);
    assert.equal(buf[7], 0x0a);

    // Verify IHDR chunk specifies 64x64
    // Chunk layout: 4 bytes len (13), 4 bytes "IHDR", 4 bytes width, 4 bytes height
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert.equal(width, 64);
    assert.equal(height, 64);
  });
});

describe("fullscreenImageFixPlugin", () => {
  it("registers session_start event and image-fix command", () => {
    const registeredEvents: string[] = [];
    const registeredCommands: string[] = [];

    const fakePi = {
      on(event: string) {
        registeredEvents.push(event);
      },
      registerCommand(name: string) {
        registeredCommands.push(name);
      },
    } as any;

    fullscreenImageFixPlugin(fakePi);

    assert.ok(registeredEvents.includes("session_start"), "Should register session_start event");
    assert.ok(registeredCommands.includes("image-fix"), "Should register image-fix command");
  });
});
