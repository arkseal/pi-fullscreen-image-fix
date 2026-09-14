import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  extractKittyRows,
  isEraseOnly,
  detectEraseCommand,
  patchKittyBuffer,
  stats,
} from "../patch.ts";

describe("extractKittyRows", () => {
  it("returns 0 for content without Kitty escape sequences", () => {
    assert.equal(extractKittyRows(""), 0);
    assert.equal(extractKittyRows("Hello world"), 0);
    assert.equal(extractKittyRows("\x1b[31mRed text\x1b[0m"), 0);
  });

  it("returns 1 for Kitty sequences without an explicit r parameter", () => {
    assert.equal(extractKittyRows("\x1b_Ga=T,f=100;AAAA\x1b\\"), 1);
  });

  it("extracts row count from standard Kitty transmission sequences", () => {
    assert.equal(extractKittyRows("\x1b_Ga=T,f=100,r=30,c=60;AAAA\x1b\\"), 30);
    assert.equal(extractKittyRows("\x1b_Gr=12,a=T;AAAA\x1b\\"), 12);
    assert.equal(extractKittyRows("\x1b_Ga=T,c=80,r=4;AAAA\x1b\\"), 4);
  });

  it("extracts row count from Kitty placement sequences (a=p)", () => {
    assert.equal(extractKittyRows("\x1b_Ga=p,q=2,i=42,r=25,c=60\x1b\\"), 25);
  });

  it("extracts row count from cropped Kitty sequences (y=...,h=...,r=...)", () => {
    assert.equal(extractKittyRows("\x1b_Ga=p,q=2,i=1,y=10,h=50,r=18\x1b\\"), 18);
  });
});

describe("isEraseOnly", () => {
  it("returns true for empty or whitespace-only content", () => {
    assert.equal(isEraseOnly(""), true);
    assert.equal(isEraseOnly("   "), true);
  });

  it("returns true for standard line erase commands", () => {
    assert.equal(isEraseOnly("\x1b[2K"), true);
    assert.equal(isEraseOnly("\x1b[0K"), true);
    assert.equal(isEraseOnly("\x1b[1K"), true);
    assert.equal(isEraseOnly("\x1b[K"), true);
    assert.equal(isEraseOnly("\x1b[2K   "), true);
  });

  it("returns true for width-limited erase commands (pi-sidebar-tui style)", () => {
    assert.equal(isEraseOnly("\x1b[50X"), true);
    assert.equal(isEraseOnly("\x1b[120X"), true);
    assert.equal(isEraseOnly("\x1b[50X  "), true);
  });

  it("returns false for content containing visible text", () => {
    assert.equal(isEraseOnly("\x1b[2KHello"), false);
    assert.equal(isEraseOnly("\x1b[50XSome title"), false);
    assert.equal(isEraseOnly("Normal line"), false);
    assert.equal(isEraseOnly("\x1b[32mSuccess\x1b[0m"), false);
  });
});

describe("detectEraseCommand", () => {
  it("detects \\x1b[2K", () => {
    assert.equal(detectEraseCommand("\x1b[2KSome content"), "\x1b[2K");
  });

  it("detects \\x1b[<N>X", () => {
    assert.equal(detectEraseCommand("\x1b[45XSome content"), "\x1b[45X");
  });

  it("defaults to \\x1b[2K when no erase prefix is present", () => {
    assert.equal(detectEraseCommand("Plain text"), "\x1b[2K");
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

  it("leaves 1-row Kitty sequences untouched", () => {
    const singleRow = "\x1b[1;1H\x1b[2KLine 1\x1b[2;1H\x1b[2K\x1b_Ga=T,r=1;IMG\x1b\\\x1b[3;1H\x1b[2KLine 3";
    const result = patchKittyBuffer(singleRow);
    assert.equal(result, singleRow);
    assert.equal(stats.framesPatched, 0);
  });

  it("pre-clears rows and suppresses placeholder line erases for multi-row Kitty images", () => {
    // An image on row 3 with r=4 (occupies rows 3, 4, 5, 6)
    const input = [
      "\x1b[?2026h",
      "\x1b[1;1H\x1b[2KLine 1",
      "\x1b[2;1H\x1b[2KLine 2",
      "\x1b[3;1H\x1b[2K\x1b_Ga=T,r=4,c=60;BASE64DATA\x1b\\",
      "\x1b[4;1H\x1b[2K", // placeholder 1
      "\x1b[5;1H\x1b[2K", // placeholder 2
      "\x1b[6;1H\x1b[2K", // placeholder 3
      "\x1b[7;1H\x1b[2KLine 7",
      "\x1b[?2026l",
    ].join("");

    const output = patchKittyBuffer(input, 24);

    // 1. Must pre-clear rows 3, 4, 5, 6 before the image
    const expectedPreClear = "\x1b[3;1H\x1b[2K\x1b[4;1H\x1b[2K\x1b[5;1H\x1b[2K\x1b[6;1H\x1b[2K";
    assert.ok(output.includes(expectedPreClear), "Output must contain pre-clear sequence for all 4 rows");

    // 2. Must reposition cursor to row 3 and emit image sequence
    assert.ok(
      output.includes(`${expectedPreClear}\x1b[3;1H\x1b_Ga=T,r=4,c=60;BASE64DATA\x1b\\`),
      "Image must be emitted immediately after pre-clearing"
    );

    // 3. Must NOT contain trailing erase-lines after the image for rows 4, 5, 6
    const afterImage = output.slice(output.indexOf("BASE64DATA\x1b\\"));
    assert.ok(!afterImage.includes("\x1b[4;1H\x1b[2K"), "Row 4 erase must be suppressed after image");
    assert.ok(!afterImage.includes("\x1b[5;1H\x1b[2K"), "Row 5 erase must be suppressed after image");
    assert.ok(!afterImage.includes("\x1b[6;1H\x1b[2K"), "Row 6 erase must be suppressed after image");

    // 4. Must preserve subsequent content
    assert.ok(afterImage.includes("\x1b[7;1H\x1b[2KLine 7"), "Line 7 must be preserved");

    assert.equal(stats.framesPatched, 1);
    assert.equal(stats.imagesPatched, 1);
  });

  it("handles multiple Kitty images on the same screen", () => {
    const input = [
      "\x1b[?2026h",
      "\x1b[2;1H\x1b[2K\x1b_Ga=T,r=2;IMG1\x1b\\",
      "\x1b[3;1H\x1b[2K",
      "\x1b[4;1H\x1b[2KText in between",
      "\x1b[5;1H\x1b[2K\x1b_Ga=T,r=3;IMG2\x1b\\",
      "\x1b[6;1H\x1b[2K",
      "\x1b[7;1H\x1b[2K",
      "\x1b[8;1H\x1b[2KFooter",
      "\x1b[?2026l",
    ].join("");

    const output = patchKittyBuffer(input, 24);

    // Both images must be pre-cleared and trailing erases suppressed
    assert.ok(output.includes("\x1b[2;1H\x1b[2K\x1b[3;1H\x1b[2K\x1b[2;1H\x1b_Ga=T,r=2;IMG1\x1b\\"));
    assert.ok(output.includes("\x1b[4;1H\x1b[2KText in between"));
    assert.ok(output.includes("\x1b[5;1H\x1b[2K\x1b[6;1H\x1b[2K\x1b[7;1H\x1b[2K\x1b[5;1H\x1b_Ga=T,r=3;IMG2\x1b\\"));
    assert.ok(output.includes("\x1b[8;1H\x1b[2KFooter"));

    assert.equal(stats.imagesPatched, 2);
    assert.equal(stats.framesPatched, 1);
  });

  it("preserves actual text lines that overlap the image region", () => {
    // If something intentionally draws text on row 4, do not suppress row 4!
    const input = [
      "\x1b[3;1H\x1b[2K\x1b_Ga=T,r=3;IMG\x1b\\",
      "\x1b[4;1H\x1b[2KOverlay Caption", // has visible text
      "\x1b[5;1H\x1b[2K", // empty placeholder
      "\x1b[6;1H\x1b[2KNext",
    ].join("");

    const output = patchKittyBuffer(input, 24);

    const afterImage = output.slice(output.indexOf("IMG\x1b\\"));
    // Row 4 has visible text, so it must be preserved (with leading erase stripped)
    assert.ok(afterImage.includes("\x1b[4;1HOverlay Caption"), "Visible text on row 4 must be kept");
    // Row 5 is empty erase, so \x1b[2K must be stripped
    assert.ok(!afterImage.includes("\x1b[5;1H\x1b[2K"), "Empty row 5 erase must be stripped after image");
    assert.ok(afterImage.includes("\x1b[6;1H\x1b[2KNext"), "Row 6 must be kept");
  });

  it("handles chunked Kitty transmissions (m=1 and m=0)", () => {
    const chunkedSeq = "\x1b_Ga=T,r=3,m=1;CHUNK1\x1b\\\x1b_Gm=0;CHUNK2\x1b\\";
    const input = [
      "\x1b[5;1H\x1b[2K" + chunkedSeq,
      "\x1b[6;1H\x1b[2K",
      "\x1b[7;1H\x1b[2K",
      "\x1b[8;1H\x1b[2KAfter",
    ].join("");

    const output = patchKittyBuffer(input, 24);

    assert.ok(output.includes("\x1b[5;1H\x1b[2K\x1b[6;1H\x1b[2K\x1b[7;1H\x1b[2K\x1b[5;1H" + chunkedSeq));
    const afterChunk = output.slice(output.indexOf("CHUNK2\x1b\\"));
    assert.ok(!afterChunk.includes("\x1b[6;1H\x1b[2K"), "Row 6 erase must be stripped");
    assert.ok(!afterChunk.includes("\x1b[7;1H\x1b[2K"), "Row 7 erase must be stripped");
    assert.ok(output.includes("\x1b[8;1H\x1b[2KAfter"));
  });

  it("works with pi-sidebar-tui erase commands (\\x1b[<N>X)", () => {
    const input = [
      "\x1b[10;1H\x1b[45X\x1b_Ga=T,r=3;IMG\x1b\\",
      "\x1b[11;1H\x1b[45X",
      "\x1b[12;1H\x1b[45X",
      "\x1b[13;1H\x1b[45XAfter",
    ].join("");

    const output = patchKittyBuffer(input, 24);

    // Pre-clear should use the \x1b[45X erase command
    assert.ok(output.includes("\x1b[10;1H\x1b[45X\x1b[11;1H\x1b[45X\x1b[12;1H\x1b[45X\x1b[10;1H\x1b_Ga=T,r=3;IMG\x1b\\"));
    const afterImg = output.slice(output.indexOf("IMG\x1b\\"));
    assert.ok(!afterImg.includes("\x1b[11;1H\x1b[45X"), "Row 11 erase must be stripped");
    assert.ok(!afterImg.includes("\x1b[12;1H\x1b[45X"), "Row 12 erase must be stripped");
    assert.ok(output.includes("\x1b[13;1H\x1b[45XAfter"));
  });

  it("clamps pre-clearing to maxRows", () => {
    // Image at row 22 with r=6 would reach row 27, but maxRows is 24
    const input = [
      "\x1b[22;1H\x1b[2K\x1b_Ga=T,r=6;IMG\x1b\\",
      "\x1b[23;1H\x1b[2K",
      "\x1b[24;1H\x1b[2K",
    ].join("");

    const output = patchKittyBuffer(input, 24);

    // Pre-clear must not exceed row 24
    assert.ok(output.includes("\x1b[22;1H\x1b[2K\x1b[23;1H\x1b[2K\x1b[24;1H\x1b[2K\x1b[22;1H\x1b_Ga=T,r=6;IMG\x1b\\"));
    assert.ok(!output.includes("\x1b[25;1H"), "Must not emit row 25");
    assert.ok(!output.includes("\x1b[26;1H"), "Must not emit row 26");
    assert.ok(!output.includes("\x1b[27;1H"), "Must not emit row 27");
  });

  it("restores a=p placements back to full a=T transmissions on scroll", () => {
    // Frame 1: initial transmission
    const frame1 = "\x1b[1;1H\x1b[2K\x1b_Ga=T,f=100,r=4,c=60,i=777;MY_IMAGE_BYTES\x1b\\\x1b[2;1H\x1b[2K\x1b[3;1H\x1b[2K\x1b[4;1H\x1b[2K";
    patchKittyBuffer(frame1, 24);

    // Frame 2: scroll sends a=p without payload
    const frame2 = "\x1b[2;1H\x1b[2K\x1b_Ga=p,q=2,C=1,c=60,r=4,i=777,y=2,h=62\x1b\\\x1b[3;1H\x1b[2K\x1b[4;1H\x1b[2K\x1b[5;1H\x1b[2K";
    const out2 = patchKittyBuffer(frame2, 24);

    // out2 must have been converted back to a=T and contain the original image payload
    assert.ok(out2.includes("a=T"), "Must convert a=p to a=T");
    assert.ok(out2.includes("MY_IMAGE_BYTES"), "Must include the cached image payload");
    assert.ok(!out2.includes("a=p"), "Must not contain placement-only a=p");
  });
});
