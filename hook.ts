import { patchKittyBuffer } from "./patch.ts";
import * as fs from "node:fs";

function debugLog(msg: string): void {
  try {
    fs.appendFileSync("/tmp/kitty-fix-debug.log", `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

/**
 * Installs the global stdout write hook that intercepts terminal rendering chunks
 * and defers Kitty graphic placements to the very end of each frame.
 */
export function installGlobalStdoutHook(): void {
  const realStdoutWrite = Object.getPrototypeOf(process.stdout).write;

  debugLog("installGlobalStdoutHook: attaching stdout hook");

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
        const patched = patchKittyBuffer(str);
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

export function installKittyImageFix(_tui?: any): () => void {
  installGlobalStdoutHook();
  return () => {};
}
