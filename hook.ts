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

const SYM_ORIG_DORENDER = Symbol.for("pi_kitty_orig_dorender");

/**
 * Installs the Kitty image protection fix onto a TuiAltScreen instance.
 *
 * It wraps `tui.doRender()` so that for every render cycle (initial render, active scroll,
 * or stopped scroll):
 * 1. It inspects the rendered layout screen lines to find all active Kitty images and their
 *    exact row extents and column widths.
 * 2. It wraps `terminal.write` for that single render cycle:
 *    - Pre-clears placeholder rows before the image is placed (eliminating stale text holes in WezTerm).
 *    - Rewrites placeholder line-erases to preserve columns 1..cols while erasing cols+1..mainWidth.
 *    - Preserves sidebar columns (columns mainWidth+1..termWidth) by never using \x1b[2K or \x1b[K.
 * 3. Restores `terminal.write` immediately in a finally block.
 */
export function installKittyImageFix(tui: any): () => void {
  installGlobalStdoutHook();

  if (!tui || typeof tui.doRender !== "function") {
    return () => {};
  }

  if (!tui[SYM_ORIG_DORENDER]) {
    tui[SYM_ORIG_DORENDER] = tui.doRender;
  }
  const originalDoRender = tui[SYM_ORIG_DORENDER];

  debugLog("installKittyImageFix: attaching doRender wrapper");

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
    if (term && typeof originalTermWrite === "function") {
      term.write = function (data: any) {
        if (typeof data === "string") {
          data = patchBufferWithRegions(data, imageRegions, termCols, termRows);
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

  return () => {
    if (tui && tui[SYM_ORIG_DORENDER]) {
      tui.doRender = tui[SYM_ORIG_DORENDER];
      delete tui[SYM_ORIG_DORENDER];
    }
  };
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
        const maxRows = process.stdout.rows || 39;
        const mainWidth = (process.stdout.columns && process.stdout.columns > 40)
          ? process.stdout.columns - 41
          : (process.stdout.columns || 118);
        const patched = patchKittyBuffer(str, maxRows, mainWidth);
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
