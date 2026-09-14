import { patchKittyBuffer } from "./patch.ts";

export const SYM_KITTY_FIX_INSTALLED = Symbol.for("pi_kitty_fullscreen_fix_installed");

/**
 * Installs the Kitty image protection hook onto a TuiAltScreen instance.
 * Intercepts terminal writes during doRender() to ensure Kitty images are pre-cleared
 * and placeholder lines underneath them do not overwrite the graphic.
 *
 * @param tui The TUI instance (typically from ctx.ui.setWidget)
 * @returns A cleanup/uninstall function
 */
export function installKittyImageFix(tui: any): () => void {
  if (!tui || typeof tui.doRender !== "function") {
    return () => {};
  }

  // Idempotency: avoid double-wrapping if already installed
  if (tui[SYM_KITTY_FIX_INSTALLED]) {
    return tui[SYM_KITTY_FIX_INSTALLED];
  }

  let disposed = false;
  const originalDoRender = tui.doRender;

  tui.doRender = function (...args: any[]) {
    if (disposed) {
      return originalDoRender.apply(this, args);
    }

    const terminal = this.terminal;
    if (!terminal || typeof terminal.write !== "function") {
      return originalDoRender.apply(this, args);
    }

    const maxRows = typeof terminal.rows === "number" ? terminal.rows : 9999;
    const originalWrite = terminal.write;

    // Wrap terminal.write only for the duration of this doRender() invocation
    terminal.write = function (data: string) {
      if (typeof data === "string") {
        data = patchKittyBuffer(data, maxRows);
      }
      return originalWrite.call(this, data);
    };

    try {
      return originalDoRender.apply(this, args);
    } finally {
      terminal.write = originalWrite;
    }
  };

  const uninstall = () => {
    if (disposed) return;
    disposed = true;
    if (tui.doRender === (installKittyImageFix as any)._wrapped) {
      tui.doRender = originalDoRender;
    }
    delete tui[SYM_KITTY_FIX_INSTALLED];
  };

  tui[SYM_KITTY_FIX_INSTALLED] = uninstall;
  return uninstall;
}
