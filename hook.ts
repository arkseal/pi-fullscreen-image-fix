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
  process.stdout.write = function (
    chunk: any,
    encodingOrCallback?: any,
    callback?: any
  ) {
    if (!inHook && typeof chunk === "string" && chunk.includes("\x1b_G")) {
      inHook = true;
      try {
        const maxRows = process.stdout.rows || 9999;
        chunk = patchKittyBuffer(chunk, maxRows);
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
