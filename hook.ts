import { patchKittyBuffer } from "./patch.ts";
import * as fs from "node:fs";

function debugLog(msg: string): void {
  try {
    fs.appendFileSync("/tmp/kitty-fix-debug.log", `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

/**
 * Installs a single global process.stdout.write hook that intercepts all terminal
 * output containing Kitty graphics sequences (\x1b_G).
 *
 * To prevent stale closures and multiple stacked wrappers across `/reload`:
 * 1. Resolves `realStdoutWrite` directly from `Object.getPrototypeOf(process.stdout).write`.
 * 2. Overwrites `process.stdout.write` directly with the fresh module implementation.
 * 3. Bypasses any previous wrappers so old closures cannot execute.
 */
export function installGlobalStdoutHook(): void {
  const realStdoutWrite = Object.getPrototypeOf(process.stdout).write;

  debugLog("installGlobalStdoutHook: attaching fresh hook to process.stdout.write");

  let inHook = false;
  let writeCount = 0;
  process.stdout.write = function (
    chunk: any,
    encodingOrCallback?: any,
    callback?: any
  ) {
    writeCount++;
    const str = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
    if (writeCount <= 20) {
      debugLog(`write #${writeCount}: len=${chunk?.length ?? 0} isStr=${typeof chunk === "string"} isBuf=${Buffer.isBuffer(chunk)} preview=${JSON.stringify(str.slice(0, 40))}`);
    }

    if (!inHook && str.includes("\x1b_G")) {
      inHook = true;
      try {
        debugLog(`stdout.write intercepted _G, len=${str.length}`);
        const maxRows = process.stdout.rows || 9999;
        const patched = patchKittyBuffer(str, maxRows);
        chunk = Buffer.isBuffer(chunk) ? Buffer.from(patched, "utf8") : patched;
      } catch (e: any) {
        debugLog(`patchKittyBuffer error: ${e?.message}`);
      } finally {
        inHook = false;
      }
    }
    return realStdoutWrite.call(process.stdout, chunk, encodingOrCallback, callback);
  };
}

/**
 * Installs the Kitty image protection hook.
 *
 * Ensures the single stdout hook is registered.
 *
 * @param tui The TUI instance
 * @returns A cleanup function
 */
export function installKittyImageFix(_tui?: any): () => void {
  installGlobalStdoutHook();
  return () => {};
}
