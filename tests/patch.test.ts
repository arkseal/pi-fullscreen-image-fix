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
    assert.equal(extractKittyRows("\x1b[2KSome text"), 0);
  });

  it("returns 1 for Kitty sequences without an explicit r parameter", () => {
    const seq = "\x1b_Ga=T,f=100,c=20;BASE64\x1b\\";
    assert.equal(extractKittyRows(seq), 1);
  });

  it("extracts row count from standard Kitty transmission sequences", () => {
    const seq = "\x1b_Ga=T,f=100,c=60,r=15,i=123;BASE64DATA\x1b\\";
    assert.equal(extractKittyRows(seq), 15);
  });

  it("extracts row count from Kitty placement sequences (a=p)", () => {
    const seq = "\x1b_Ga=p,q=2,C=1,c=60,r=28,i=123\x1b\\";
    assert.equal(extractKittyRows(seq), 28);
  });

  it("extracts row count from cropped Kitty sequences (y=...,h=...,r=...)", () => {
    const seq = "\x1b_Ga=T,f=100,q=2,C=1,c=60,i=123,y=2,h=60,r=26;BASE64DATA\x1b\\";
    assert.equal(extractKittyRows(seq), 26);
  });
});

describe("isEraseOnly", () => {
  it("returns true for empty or whitespace-only content", () => {
    assert.equal(isEraseOnly(""), true);
    assert.equal(isEraseOnly("   \t  "), true);
  });

  it("returns true for standard line erase commands", () => {
    assert.equal(isEraseOnly("\x1b[2K"), true);
    assert.equal(isEraseOnly("\x1b[2K\x1b[0m\x1b]8;;\x07"), true);
  });

  it("returns true for width-limited erase commands (pi-sidebar-tui style)", () => {
    assert.equal(isEraseOnly("\x1b[45X"), true);
    assert.equal(isEraseOnly("\x1b[118X\x1b[0m"), true);
  });

  it("returns false for content containing visible text", () => {
    assert.equal(isEraseOnly("\x1b[2KHello"), false);
    assert.equal(isEraseOnly("\x1b[45XA"), false);
    assert.equal(isEraseOnly("Line content"), false);
  });
});

describe("detectEraseCommand", () => {
  it("detects \\x1b[2K", () => {
    assert.equal(detectEraseCommand("\x1b[2Kline"), "\x1b[2K");
    assert.equal(detectEraseCommand("\x1b[0K"), "\x1b[0K");
  });

  it("detects \\x1b[<N>X", () => {
    assert.equal(detectEraseCommand("\x1b[45Xline"), "\x1b[45X");
    assert.equal(detectEraseCommand("\x1b[118X\x1b_G"), "\x1b[118X");
  });

  it("defaults to \\x1b[2K when no erase prefix is present", () => {
    assert.equal(detectEraseCommand("regular text"), "\x1b[2K");
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

  it("suppresses placeholder line erases for multi-row Kitty images without touching start row", () => {
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

    // 1. Start row must keep its line erase and image sequence
    assert.ok(output.includes("\x1b[3;1H\x1b[2K\x1b_Ga=T,r=4,c=60;BASE64DATA\x1b\\"));

    // 2. Placeholder rows 4, 5, 6 must have their line erases stripped
    const afterImage = output.slice(output.indexOf("BASE64DATA\x1b\\"));
    assert.ok(!afterImage.includes("\x1b[4;1H\x1b[2K"), "Row 4 erase must be stripped");
    assert.ok(!afterImage.includes("\x1b[5;1H\x1b[2K"), "Row 5 erase must be stripped");
    assert.ok(!afterImage.includes("\x1b[6;1H\x1b[2K"), "Row 6 erase must be stripped");

    // 3. Subsequent content outside image must be preserved intact
    assert.ok(afterImage.includes("\x1b[7;1H\x1b[2KLine 7"), "Line 7 must be preserved");

    assert.equal(stats.framesPatched, 1);
    assert.equal(stats.imagesPatched, 3); // 3 placeholder rows protected
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

    assert.ok(output.includes("\x1b[2;1H\x1b[2K\x1b_Ga=T,r=2;IMG1\x1b\\"));
    assert.ok(!output.includes("\x1b[3;1H\x1b[2K"));
    assert.ok(output.includes("\x1b[4;1H\x1b[2KText in between"));
    assert.ok(output.includes("\x1b[5;1H\x1b[2K\x1b_Ga=T,r=3;IMG2\x1b\\"));
    assert.ok(!output.includes("\x1b[6;1H\x1b[2K"));
    assert.ok(!output.includes("\x1b[7;1H\x1b[2K"));
    assert.ok(output.includes("\x1b[8;1H\x1b[2KFooter"));

    assert.equal(stats.framesPatched, 1);
  });

  it("works with pi-sidebar-tui erase commands (\\x1b[<N>X) and never emits \\x1b[2K", () => {
    const input = [
      "\x1b[10;1H\x1b[118X\x1b_Ga=T,r=3;IMG\x1b\\",
      "\x1b[11;1H\x1b[118X",
      "\x1b[12;1H\x1b[118X",
      "\x1b[13;1H\x1b[118XAfter",
    ].join("");

    const output = patchKittyBuffer(input, 24);

    // Must never contain \x1b[2K (which would erase the sidebar)
    assert.ok(!output.includes("\x1b[2K"), "Must never introduce full-line \\x1b[2K erase");

    // Must strip \x1b[118X on rows 11 and 12
    const afterImg = output.slice(output.indexOf("IMG\x1b\\"));
    assert.ok(!afterImg.includes("\x1b[11;1H\x1b[118X"), "Row 11 erase must be stripped");
    assert.ok(!afterImg.includes("\x1b[12;1H\x1b[118X"), "Row 12 erase must be stripped");
    assert.ok(output.includes("\x1b[13;1H\x1b[118XAfter"));
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

  it("is strictly idempotent", () => {
    const input = [
      "\x1b[1;1H\x1b[118XBefore",
      "\x1b[2;1H\x1b[118X\x1b_Ga=T,r=3;IMG\x1b\\",
      "\x1b[3;1H\x1b[118X\x1b[0m",
      "\x1b[4;1H\x1b[118X\x1b[0m",
      "\x1b[5;1H\x1b[118XAfter",
    ].join("");

    const pass1 = patchKittyBuffer(input, 24);
    const pass2 = patchKittyBuffer(pass1, 24);

    assert.equal(pass1, pass2, "Running patchKittyBuffer multiple times must produce identical output");
  });
});
