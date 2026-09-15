import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  patchKittyBuffer,
  stats,
} from "../patch.ts";

describe("patchKittyBuffer", () => {
  beforeEach(() => {
    stats.framesProcessed = 0;
    stats.framesPatched = 0;
    stats.imagesPatched = 0;
  });

  it("leaves buffers without Kitty sequences completely untouched", () => {
    const plain = "\x1b[1;1H\x1b[2KHello\x1b[2;1H\x1b[2KWorld\x1b[3;1H\x1b[2KFooter";
    const result = patchKittyBuffer(plain);
    assert.equal(result, plain);
    assert.equal(stats.framesProcessed, 1);
    assert.equal(stats.framesPatched, 0);
  });

  it("defers Kitty graphic placement to the end of the frame so rows are cleanly erased first", () => {
    const input = [
      "\x1b[?2026h",
      "\x1b[1;1H\x1b[118XLine 1",
      "\x1b[2;1H\x1b[118X\x1b_Ga=T,c=37,r=4;IMG\x1b\\",
      "\x1b[3;1H\x1b[118XPlaceholder 1",
      "\x1b[4;1H\x1b[118XPlaceholder 2",
      "\x1b[5;1H\x1b[118XFooter",
      "\x1b[?2026l",
    ].join("");

    const output = patchKittyBuffer(input);

    // 1. In the row rendering section, the Kitty sequence must be removed
    // so that placeholder rows are erased cleanly without touching the graphic
    const row2Content = output.split("\x1b[2;1H")[1].split("\x1b[3;1H")[0];
    assert.ok(!row2Content.includes("\x1b_G"), "Row 2 body must not contain Kitty sequence");
    assert.ok(row2Content.startsWith("\x1b[118X"), "Row 2 must keep clean erase");

    // 2. All placeholder rows must keep their normal clean erase
    assert.ok(output.includes("\x1b[3;1H\x1b[118XPlaceholder 1"));
    assert.ok(output.includes("\x1b[4;1H\x1b[118XPlaceholder 2"));

    // 3. At the end of the frame (before sync end), the image is placed with cursor save/restore
    const expectedDeferred = "\x1b7\x1b[2;1H\x1b_Ga=T,c=37,r=4;IMG\x1b\\\x1b8\x1b[?2026l";
    assert.ok(output.endsWith(expectedDeferred), "Image must be placed at end of frame with DECSC/DECRC");

    assert.equal(stats.framesPatched, 1);
    assert.equal(stats.imagesPatched, 1);
  });

  it("handles Kitty placement sequences (a=p) on scroll frames", () => {
    const scrollFrame = [
      "\x1b[?2026h",
      "\x1b_Ga=d,d=a,q=2\x1b\\",
      "\x1b[1;1H\x1b[118XScrolled Line",
      "\x1b[2;1H\x1b[118X\x1b_Ga=p,q=2,C=1,c=37,r=3,i=42\x1b\\",
      "\x1b[3;1H\x1b[118XPlaceholder 1",
      "\x1b[4;1H\x1b[118XPlaceholder 2",
      "\x1b[38;10H",
      "\x1b[?2026l",
    ].join("");

    const output = patchKittyBuffer(scrollFrame);

    // Row 2 body should not contain Kitty
    const row2Content = output.split("\x1b[2;1H")[1].split("\x1b[3;1H")[0];
    assert.ok(!row2Content.includes("\x1b_G"));

    // Trailing cursor position 38;10 is preserved
    assert.ok(output.includes("\x1b[38;10H"));

    // Placement is deferred to end
    assert.ok(output.includes("\x1b7\x1b[2;1H\x1b_Ga=p,q=2,C=1,c=37,r=3,i=42\x1b\\\x1b8"));
  });

  it("handles multiple Kitty images on the same screen", () => {
    const input = [
      "\x1b[?2026h",
      "\x1b[1;1H\x1b[118XHeader",
      "\x1b[2;1H\x1b[118X\x1b_Ga=T,c=37,r=3;IMG1\x1b\\",
      "\x1b[3;1H\x1b[118X",
      "\x1b[4;1H\x1b[118XText in between",
      "\x1b[5;1H\x1b[118X\x1b_Ga=T,c=30,r=3;IMG2\x1b\\",
      "\x1b[6;1H\x1b[118X",
      "\x1b[7;1H\x1b[118XFooter",
      "\x1b[?2026l",
    ].join("");

    const output = patchKittyBuffer(input);

    assert.equal(stats.imagesPatched, 2);
    // Both images placed at end in order
    assert.ok(output.includes("\x1b7\x1b[2;1H\x1b_Ga=T,c=37,r=3;IMG1\x1b\\\x1b[5;1H\x1b_Ga=T,c=30,r=3;IMG2\x1b\\\x1b8"));
  });

  it("is strictly idempotent", () => {
    const input = [
      "\x1b[?2026h",
      "\x1b[1;1H\x1b[118XBefore",
      "\x1b[2;1H\x1b[118X\x1b_Ga=T,c=37,r=3;IMG\x1b\\",
      "\x1b[3;1H\x1b[118X\x1b[0m",
      "\x1b[4;1H\x1b[118X\x1b[0m",
      "\x1b[5;1H\x1b[118XAfter",
      "\x1b[?2026l",
    ].join("");

    const pass1 = patchKittyBuffer(input);
    const pass2 = patchKittyBuffer(pass1);

    assert.equal(pass1, pass2, "Running patchKittyBuffer multiple times must produce identical output");
  });
});
