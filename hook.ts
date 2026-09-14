import { patchKittyBuffer } from "./patch.ts";

export const SYM_KITTY_FIX_INSTALLED = Symbol.for("pi_kitty_fullscreen_fix_installed");

/**
 * Installs the Kitty image protection hook onto a TuiAltScreen instance.
 * Intercepts terminal writes to ensure Kitty images are pre-cleared
 * and placeholder lines underneath them do not overwrite the graphic.
 *
 * @param tui The TUI instance (from ctx.ui.setWidget)
 * @returns A cleanup/uninstall function
 */
export function installKittyImageFix(tui: any): () => void {
  if (!tui) {
    return () => {};
  }

  // Idempotency: avoid double-wrapping if already installed
  if (tui[SYM_KITTY_FIX_INSTALLED]) {
    return tui[SYM_KITTY_FIX_INSTALLED];
  }

  const terminal = tui.terminal;
  if (!terminal || typeof terminal.write !== "function") {
    return () => {};
  }

  let disposed = false;
  const originalWrite = terminal.write.bind(terminal);

  terminal.write = function (data: any) {
    if (!disposed && typeof data === "string" && data.includes("\x1b_G")) {
      const maxRows = typeof terminal.rows === "number" ? terminal.rows : 9999;
      data = patchKittyBuffer(data, maxRows);
    }
    return originalWrite(data);
  };

  const uninstall = () => {
    if (disposed) return;
    disposed = true;
    terminal.write = originalWrite;
    delete tui[SYM_KITTY_FIX_INSTALLED];
  };

  tui[SYM_KITTY_FIX_INSTALLED] = uninstall;
  return uninstall;
}
