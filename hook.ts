import {
  patchKittyBuffer,
  discoverImageRegionsFromScreen,
  patchBufferWithRegions,
} from "./patch.ts";
import * as fs from "node:fs";

function debugLog(msg: string): void {
  try {
    fs.appendFileSync("/tmp/kitty-fix-debug.log", `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

const SYM_RENDER_HOOKED = Symbol.for("pi_kitty_dorender_hooked");

/**
 * Installs the Kitty image protection fix onto a TuiAltScreen instance.
 *
 * It wraps `tui.doRender()` so that for every render cycle (initial render, active scroll,
 * or stopped scroll):
 * 1. It inspects the rendered layout screen lines to find all active Kitty images and their
 *    exact row extents and column widths.
 * 2. It wraps `terminal.write` for that single render cycle, rewriting placeholder line erases
 *    to preserve columns 1..cols while erasing cols+1..mainWidth.
 * 3. Restores `terminal.write` immediately in a finally block.
 */
export function installKittyImageFix(tui: any): () => void {
  installGlobalStdoutHook();

  if (!tui || typeof tui.doRender !== "function") {
    return () => {};
  }

  if (tui[SYM_RENDER_HOOKED]) {
    return () => {};
  }
  tui[SYM_RENDER_HOOKED] = true;

  debugLog("installKittyImageFix: wrapping tui.doRender");

  const originalDoRender = tui.doRender;
  tui.doRender = function (...args: any[]) {
    const term = this.terminal;
    const termCols = term?.columns || 118;
    const termRows = term?.rows || 39;

    let imageRegions: any[] = [];
    try {
      if (typeof this.render === "function") {
        const screen = this.render(termCols, termRows);
        if (Array.isArray(screen)) {
          imageRegions = discoverImageRegionsFromScreen(screen, termRows, termCols);
        }
      }
    } catch {}

    const originalTermWrite = term?.write;
    if (term && typeof originalTermWrite === "function" && imageRegions.length > 0) {
      term.write = function (data: any) {
        if (typeof data === "string") {
          data = patchBufferWithRegions(data, imageRegions, termCols);
        }
        return originalTermWrite.call(this, data);
      };
    }

    try {
      return originalDoRender.apply(this, args);
    } finally {
      if (term && typeof originalTermWrite === "function") {
        term.write = originalTermWrite;
      }
    }
  };

  return () => {};
}

/**
 * Fallback stdout hook to catch any stray unintercepted writes containing \x1b_G.
 */
export function installGlobalStdoutHook(): void {
  const realStdoutWrite = Object.getPrototypeOf(process.stdout).write;

  let inHook = false;
  process.stdout.write = function (
    chunk: any,
    encodingOrCallback?: any,
    callback?: any
  ) {
    const str = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";

    if (!inHook && str.includes("\x1b_G")) {
      inHook = true;
      try {
        const maxRows = process.stdout.rows || 9999;
        const patched = patchKittyBuffer(str, maxRows);
        if (patched !== str) {
          chunk = Buffer.isBuffer(chunk) ? Buffer.from(patched, "utf8") : patched;
        }
      } catch (e: any) {
        debugLog(`patchKittyBuffer error: ${e?.message}`);
      } finally {
        inHook = false;
      }
    }
    return realStdoutWrite.call(process.stdout, chunk, encodingOrCallback, callback);
  };
}
