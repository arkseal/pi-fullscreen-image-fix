import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installKittyImageFix, SYM_KITTY_FIX_INSTALLED } from "./hook.ts";
import { stats } from "./patch.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

function crc32(buf: Buffer): number {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function makeChunk(type: string, data: Buffer): Buffer {
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
 * Generate a standalone 64x64 RGBA test PNG with a color checkerboard pattern.
 */
export function generateTestPng(width = 64, height = 64): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = makeChunk("IHDR", ihdr);

  // Raw image scanlines
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

  const compressed = zlib.deflateSync(rawData);
  const idatChunk = makeChunk("IDAT", compressed);
  const iendChunk = makeChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

export default function fullscreenImageFixPlugin(pi: ExtensionAPI) {
  let activeUninstall: (() => void) | undefined;
  let isInstalled = false;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    // Use setWidget belowEditor to receive the interactive TUI instance
    ctx.ui.setWidget(
      "pi-fullscreen-image-fix",
      (tui: any) => {
        if (tui && tui.mode === "fullscreen") {
          activeUninstall = installKittyImageFix(tui);
          isInstalled = true;
        }

        return {
          dispose() {
            activeUninstall?.();
            activeUninstall = undefined;
            isInstalled = false;
          },
          invalidate() {},
          render(_width: number): string[] {
            return [];
          },
        };
      },
      { placement: "belowEditor" }
    );
  });

  // Diagnostic command
  pi.registerCommand("image-fix", {
    description: "Check status of the fullscreen Kitty image rendering fix",
    handler: async (args, ctx) => {
      const sub = (args || "").trim().toLowerCase();

      if (sub === "test" || sub === "generate-test") {
        const testFilePath = path.join(ctx.cwd, "test-pattern-64x64.png");
        const pngBuf = generateTestPng(64, 64);
        fs.writeFileSync(testFilePath, pngBuf);
        ctx.ui.notify(`Created 64x64 test image at ${testFilePath}. Use 'read test-pattern-64x64.png' to test rendering.`, "info");
        return;
      }

      const statusMsg = [
        "=== Fullscreen Image Fix Status ===",
        `Installed: ${isInstalled ? "YES (active)" : "INACTIVE"}`,
        `TUI Mode: ${ctx.mode}`,
        `Frames Processed: ${stats.framesProcessed}`,
        `Frames Patched: ${stats.framesPatched}`,
        `Images Protected: ${stats.imagesPatched}`,
        "",
        "Usage:",
        "  /image-fix              Show this status",
        "  /image-fix test         Generate 64x64 test image in current directory",
      ].join("\n");

      ctx.ui.notify(statusMsg, "info");
    },
  });
}
