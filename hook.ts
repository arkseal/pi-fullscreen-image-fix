import { patchKittyBuffer } from "./patch.ts";
import * as fs from "node:fs";

export const SYM_STDOUT_HOOKED = Symbol.for("pi_kitty_stdout_hooked_v2");
export const SYM_PATCH_FN = Symbol.for("pi_kitty_patch_fn_v2");

function debugLog(msg: string): void {
  try {
    fs.appendFileSync("/tmp/kitty-fix-debug.log", `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

/**
 * Installs a single global process.stdout.write hook that intercepts all terminal
 * output containing Kitty graphics sequences (\x1b_G).
 *
 * Why hook process.stdout.write exclusively?
 * 1. It is the final chokepoint before bytes hit the terminal emulator.
 * 2. It runs AFTER any extensions (like pi-sidebar-tui) have formatted their erases
 *    and composited their layouts, preventing duplicate patching.
 * 3. It cannot be deleted or bypassed by extensions overriding terminal.write.
 * 4. Using Symbol.for guarantees that subsequent reloads (/reload) seamlessly update
 *    the patching function in-place without stacking multiple hooks.
 */
export function installGlobalStdoutHook(): void {
  // Always update the active patch function so the latest version runs after /reload
  (process.stdout as any)[SYM_PATCH_FN] = patchKittyBuffer;

  if ((process.stdout as any)[SYM_STDOUT_HOOKED]) {
    return;
  }
  (process.stdout as any)[SYM_STDOUT_HOOKED] = true;

  debugLog("installGlobalStdoutHook: attaching single hook to process.stdout.write");

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  let inHook = false;

  (process.stdout as any).write = function (
    chunk: any,
    encodingOrCallback?: any,
    callback?: any
  ) {
    if (!inHook && typeof chunk === "string" && chunk.includes("\x1b_G")) {
      inHook = true;
      try {
        const patchFn = (process.stdout as any)[SYM_PATCH_FN] || patchKittyBuffer;
        const maxRows = process.stdout.rows || 9999;
        chunk = patchFn(chunk, maxRows);
      } catch (e: any) {
        debugLog(`patchKittyBuffer error: ${e?.message}`);
      } finally {
        inHook = false;
      }
    }
    return originalStdoutWrite(chunk, encodingOrCallback, callback);
  };
}

/**
 * Installs the Kitty image protection hook.
 *
 * 1. Overrides `prepareKittyScreen` so Pi does not strip the base64 payload into
 *    a placement-only (a=p) sequence on scroll, preventing WezTerm placement lookup bugs.
 * 2. Ensures the single stdout hook is registered.
 *
 * @param tui The TUI instance
 * @returns A cleanup function
 */
export function installKittyImageFix(tui: any): () => void {
  installGlobalStdoutHook();

  if (!tui) {
    return () => {};
  }

  // Override prepareKittyScreen so Pi retains the full image payload instead
  // of converting to placement-only (a=p) commands on scroll.
  if (typeof tui.prepareKittyScreen === "function") {
    tui.prepareKittyScreen = function (screen: string[]) {
      return { lines: screen, evictedImageDeletion: "" };
    };
  }

  return () => {};
}
