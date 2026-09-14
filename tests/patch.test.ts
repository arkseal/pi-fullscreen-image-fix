import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  extractKittyRows,
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
    const seq = "\x1b_Ga=p,q=2,C=1,c=60,i=123,y=2,h=60,r=26\x1b\\";
    assert.equal(extractKittyRows(seq), 26);
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
    assert.equal(stats.imagesPatched, 3);
  });

  it("handles Kitty placement sequences (a=p) on scroll frames", () => {
    const scrollFrame = [
      "\x1b[2;1H\x1b[118XLine 2",
      "\x1b[3;1H\x1b[118X\x1b_Ga=p,q=2,C=1,c=60,r=3,i=42\x1b\\",
      "\x1b[4;1H\x1b[118X\x1b[0m", // placeholder 1
      "\x1b[5;1H\x1b[118X\x1b[0m", // placeholder 2
      "\x1b[6;1H\x1b[118XLine 6",
    ].join("");

    const output = patchKittyBuffer(scrollFrame, 24);

    assert.ok(output.includes("\x1b[3;1H\x1b[118X\x1b_Ga=p,q=2,C=1,c=60,r=3,i=42\x1b\\"));
    assert.ok(!output.includes("\x1b[4;1H\x1b[118X"));
    assert.ok(!output.includes("\x1b[5;1H\x1b[118X"));
    assert.ok(output.includes("\x1b[6;1H\x1b[118XLine 6"));

    assert.equal(stats.framesPatched, 1);
    assert.equal(stats.imagesPatched, 2);
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

    assert.ok(!output.includes("\x1b[2K"), "Must never introduce full-line \\x1b[2K erase");
    const afterImg = output.slice(output.indexOf("IMG\x1b\\"));
    assert.ok(!afterImg.includes("\x1b[11;1H\x1b[118X"), "Row 11 erase must be stripped");
    assert.ok(!afterImg.includes("\x1b[12;1H\x1b[118X"), "Row 12 erase must be stripped");
    assert.ok(output.includes("\x1b[13;1H\x1b[118XAfter"));
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
