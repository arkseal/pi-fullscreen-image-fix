import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  extractKittyDims,
  patchKittyBuffer,
  stats,
} from "../patch.ts";

describe("extractKittyDims", () => {
  it("returns null for content without Kitty escape sequences", () => {
    assert.equal(extractKittyDims(""), null);
    assert.equal(extractKittyDims("Hello world"), null);
    assert.equal(extractKittyDims("\x1b[2KSome text"), null);
  });

  it("returns null for 1-row Kitty sequences", () => {
    const seq = "\x1b_Ga=T,f=100,c=20;BASE64\x1b\\";
    assert.equal(extractKittyDims(seq), null);
  });

  it("extracts rows and cols from standard Kitty transmission sequences", () => {
    const seq = "\x1b_Ga=T,f=100,c=37,r=15,i=123;BASE64DATA\x1b\\";
    const dims = extractKittyDims(seq);
    assert.deepEqual(dims, { rows: 15, cols: 37 });
  });

  it("extracts rows and cols from Kitty placement sequences (a=p)", () => {
    const seq = "\x1b_Ga=p,q=2,C=1,c=60,r=28,i=123\x1b\\";
    const dims = extractKittyDims(seq);
    assert.deepEqual(dims, { rows: 28, cols: 60 });
  });
});

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

  it("repositions placeholder erases to cols+1 to wipe stale text while protecting graphic cells", () => {
    // Image at row 3 with r=4, c=37 on a 118-column terminal
    const input = [
      "\x1b[1;1H\x1b[118XLine 1",
      "\x1b[2;1H\x1b[118XLine 2",
      "\x1b[3;1H\x1b[118X\x1b_Ga=T,c=37,r=4;IMG\x1b\\",
      "\x1b[4;1H\x1b[118Xold stale text", // placeholder row 4
      "\x1b[5;1H\x1b[118Xold stale text", // placeholder row 5
      "\x1b[6;1H\x1b[118Xold stale text", // placeholder row 6
      "\x1b[7;1H\x1b[118XLine 7",
    ].join("");

    const output = patchKittyBuffer(input, 24);

    // 1. Start row must keep its line erase and image sequence
    assert.ok(output.includes("\x1b[3;1H\x1b[118X\x1b_Ga=T,c=37,r=4;IMG\x1b\\"));

    // 2. Placeholder rows must move cursor to column 38 and erase remaining 81 columns (118 - 37)
    assert.ok(output.includes("\x1b[4;38H\x1b[81Xold stale text"), "Row 4 must erase from col 38");
    assert.ok(output.includes("\x1b[5;38H\x1b[81Xold stale text"), "Row 5 must erase from col 38");
    assert.ok(output.includes("\x1b[6;38H\x1b[81Xold stale text"), "Row 6 must erase from col 38");

    // 3. Image columns 1..37 must NOT have an erase command at column 1
    assert.ok(!output.includes("\x1b[4;1H\x1b[118X"));
    assert.ok(!output.includes("\x1b[5;1H\x1b[118X"));
    assert.ok(!output.includes("\x1b[6;1H\x1b[118X"));

    // 4. Content outside image must be preserved
    assert.ok(output.includes("\x1b[7;1H\x1b[118XLine 7"));
    assert.equal(stats.framesPatched, 1);
  });

  it("handles Kitty placement sequences (a=p) on scroll frames", () => {
    const scrollFrame = [
      "\x1b_Ga=d,d=a,q=2\x1b\\",
      "\x1b[1;1H\x1b[118XScrolled Line",
      "\x1b[2;1H\x1b[118X\x1b_Ga=p,q=2,C=1,c=37,r=3,i=42\x1b\\",
      "\x1b[3;1H\x1b[118X\x1b[0m", // placeholder 1
      "\x1b[4;1H\x1b[118X\x1b[0m", // placeholder 2
      "\x1b[5;1H\x1b[118XLine 5",
    ].join("");

    const output = patchKittyBuffer(scrollFrame, 24);

    assert.ok(output.includes("\x1b[2;1H\x1b[118X\x1b_Ga=p,q=2,C=1,c=37,r=3,i=42\x1b\\"));
    assert.ok(output.includes("\x1b[3;38H\x1b[81X\x1b[0m"));
    assert.ok(output.includes("\x1b[4;38H\x1b[81X\x1b[0m"));
    assert.ok(output.includes("\x1b[5;1H\x1b[118XLine 5"));

    assert.equal(stats.framesPatched, 1);
  });

  it("is completely stateless between frames so scroll adjustments never leak stale rows", () => {
    // Frame 1: Image at rows 2..5
    const f1 = [
      "\x1b[2;1H\x1b[118X\x1b_Ga=T,c=37,r=4;IMG\x1b\\",
      "\x1b[3;1H\x1b[118X",
      "\x1b[4;1H\x1b[118X",
      "\x1b[5;1H\x1b[118X",
    ].join("");
    patchKittyBuffer(f1, 24);

    // Frame 2: Image scrolled down to rows 4..7 (rows 2 and 3 now have normal text!)
    const f2 = [
      "\x1b_Ga=d,d=a,q=2\x1b\\",
      "\x1b[2;1H\x1b[118XNormal Text 2",
      "\x1b[3;1H\x1b[118XNormal Text 3",
      "\x1b[4;1H\x1b[118X\x1b_Ga=p,q=2,C=1,c=37,r=4,i=1\x1b\\",
      "\x1b[5;1H\x1b[118X",
      "\x1b[6;1H\x1b[118X",
      "\x1b[7;1H\x1b[118X",
    ].join("");
    const out2 = patchKittyBuffer(f2, 24);

    // Rows 2 and 3 must NOT be treated as image placeholders; they must retain column 1 erase
    assert.ok(out2.includes("\x1b[2;1H\x1b[118XNormal Text 2"), "Row 2 must not have stale image offset");
    assert.ok(out2.includes("\x1b[3;1H\x1b[118XNormal Text 3"), "Row 3 must not have stale image offset");

    // Rows 5..7 must have offset erase
    assert.ok(out2.includes("\x1b[5;38H\x1b[81X"));
    assert.ok(out2.includes("\x1b[6;38H\x1b[81X"));
    assert.ok(out2.includes("\x1b[7;38H\x1b[81X"));
  });

  it("handles multiple Kitty images on the same screen", () => {
    const input = [
      "\x1b[2;1H\x1b[118X\x1b_Ga=T,c=20,r=2;IMG1\x1b\\",
      "\x1b[3;1H\x1b[118X", // placeholder for IMG1
      "\x1b[4;1H\x1b[118XText in between",
      "\x1b[5;1H\x1b[118X\x1b_Ga=T,c=30,r=3;IMG2\x1b\\",
      "\x1b[6;1H\x1b[118X", // placeholder for IMG2
      "\x1b[7;1H\x1b[118X", // placeholder for IMG2
      "\x1b[8;1H\x1b[118XFooter",
    ].join("");

    const output = patchKittyBuffer(input, 24);

    // IMG1 covers rows 2..3, cols=20 -> row 3 erased from col 21
    assert.ok(output.includes("\x1b[3;21H\x1b[98X"));

    // Text in between is unmodified
    assert.ok(output.includes("\x1b[4;1H\x1b[118XText in between"));

    // IMG2 covers rows 5..7, cols=30 -> rows 6 and 7 erased from col 31
    assert.ok(output.includes("\x1b[6;31H\x1b[88X"));
    assert.ok(output.includes("\x1b[7;31H\x1b[88X"));

    assert.ok(output.includes("\x1b[8;1H\x1b[118XFooter"));
  });

  it("is strictly idempotent", () => {
    const input = [
      "\x1b[1;1H\x1b[118XBefore",
      "\x1b[2;1H\x1b[118X\x1b_Ga=T,c=37,r=3;IMG\x1b\\",
      "\x1b[3;1H\x1b[118X\x1b[0m",
      "\x1b[4;1H\x1b[118X\x1b[0m",
      "\x1b[5;1H\x1b[118XAfter",
    ].join("");

    const pass1 = patchKittyBuffer(input, 24);
    const pass2 = patchKittyBuffer(pass1, 24);

    assert.equal(pass1, pass2, "Running patchKittyBuffer multiple times must produce identical output");
  });
});
