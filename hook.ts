import { patchKittyBuffer } from "./patch.ts";
import * as fs from "node:fs";

export const SYM_KITTY_FIX_INSTALLED = Symbol.for("pi_kitty_fullscreen_fix_installed");
export const SYM_STDOUT_HOOKED = Symbol.for("pi_kitty_stdout_hooked");

function debugLog(msg: string): void {
  try {
    fs.appendFileSync("/tmp/kitty-fix-debug.log", `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

/**
 * Installs a global process.stdout.write hook that intercepts any terminal
 * output containing Kitty graphics sequences (\x1b_G).
 *
 * This is immune to extensions (like pi-sidebar-tui) dynamically defining
 * and deleting own properties on `terminal.write`, and works immediately
 * without waiting for session_start events.
 */
export function installGlobalStdoutHook(): void {
  if ((process.stdout as any)[SYM_STDOUT_HOOKED]) {
    return;
  }
  (process.stdout as any)[SYM_STDOUT_HOOKED] = true;

  debugLog("installGlobalStdoutHook: attaching to process.stdout.write");

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
        const maxRows = process.stdout.rows || 9999;
        debugLog(`stdout.write intercepted \x1b_G, len=${chunk.length}, maxRows=${maxRows}`);
        chunk = patchKittyBuffer(chunk, maxRows);
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
 * Installs the Kitty image protection hook onto a TuiAltScreen instance.
 * Intercepts terminal writes to ensure Kitty images are pre-cleared
 * and placeholder lines underneath them do not overwrite the graphic.
 *
 * @param tui The TUI instance (from ctx.ui.setWidget)
 * @returns A cleanup/uninstall function
 */
export function installKittyImageFix(tui: any): () => void {
  installGlobalStdoutHook();

  if (!tui) {
    return () => {};
  }

  if (tui[SYM_KITTY_FIX_INSTALLED]) {
    return tui[SYM_KITTY_FIX_INSTALLED];
  }

  debugLog(`installKittyImageFix: tui.mode=${tui.mode}`);

  const terminal = tui.terminal;
  if (!terminal) {
    return () => {};
  }

  // Hook terminal instance write
  const origTerminalWrite = terminal.write;
  if (typeof origTerminalWrite === "function") {
    terminal.write = function (data: any) {
      if (typeof data === "string" && data.includes("\x1b_G")) {
        const maxRows = typeof terminal.rows === "number" ? terminal.rows : (process.stdout.rows || 9999);
        data = patchKittyBuffer(data, maxRows);
      }
      return origTerminalWrite.call(this, data);
    };
  }

  // Also hook the prototype of terminal so that even if an own property
  // on terminal is deleted (e.g. by pi-sidebar-tui), the prototype hook survives.
  const proto = Object.getPrototypeOf(terminal);
  if (proto && proto !== Object.prototype && typeof proto.write === "function" && !(proto as any)[SYM_KITTY_FIX_INSTALLED]) {
    (proto as any)[SYM_KITTY_FIX_INSTALLED] = true;
    const origProtoWrite = proto.write;
    proto.write = function (data: any) {
      if (typeof data === "string" && data.includes("\x1b_G")) {
        const maxRows = typeof this.rows === "number" ? this.rows : (process.stdout.rows || 9999);
        debugLog(`proto.write intercepted \x1b_G, len=${data.length}, maxRows=${maxRows}`);
        data = patchKittyBuffer(data, maxRows);
      }
      return origProtoWrite.call(this, data);
    };
  }

  const uninstall = () => {
    delete tui[SYM_KITTY_FIX_INSTALLED];
  };

  tui[SYM_KITTY_FIX_INSTALLED] = uninstall;
  return uninstall;
}
