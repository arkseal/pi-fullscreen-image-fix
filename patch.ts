/**
 * Pure buffer patching logic for Kitty graphics protocol in Pi fullscreen TUI.
 *
 * ## Problem:
 * In Pi's fullscreen TUI (`TuiAltScreen`), images are rendered across multiple rows.
 * The Image component outputs Kitty graphics escape sequences (`\x1b_Ga=...`) on row N,
 * and empty strings on placeholder rows N+1..N+r-1 to allocate layout space.
 *
 * When Pi renders a frame sequentially from top to bottom:
 *   Row N:   \x1b[N;1H\x1b[118X\x1b_Ga=...
 *   Row N+1: \x1b[N+1;1H\x1b[118X
 *   ...
 *   Row N+r: \x1b[N+r;1H\x1b[118X
 *
 * In terminals supporting cell-anchored Kitty graphics (WezTerm, Kitty, Ghostty):
 * - Erasing rows N+1..N+r-1 deletes the intersecting graphic slices (1-2 row slit-scan artifact).
 * - Leaving rows un-erased leaves stale characters in the cell grid, which poke holes through the
 *   texture in WezTerm (the upper-left notch artifact).
 * - Full-width erases (\x1b[2K or \x1b[K) destroy right-docked sidebars like pi-sidebar-tui.
 *
 * ## Solution: End-of-Frame Deferred Placement
 * 1. Let Pi and sidebar compositors draw and erase all terminal rows (1..rows) normally with
 *    width-bounded erases (\x1b[118X). This wipes all cells clean of stale text and renders sidebar
 *    areas without conflict.
 * 2. Extract any Kitty graphic sequences from the row rendering commands.
 * 3. Defer image placements to the very end of the synchronized output block (\x1b[?2026l) or buffer,
 *    wrapping them in VT100 save cursor (\x1b7 DECSC) and restore cursor (\x1b8 DECRC).
 *
 * Result:
 * - Graphic slices are never erased because no row erase executes after image placement.
 * - Underneath cells are freshly blanked, eliminating hole-punching / notch artifacts.
 * - Sidebars remain completely untouched.
 * - Native 60 FPS scrolling functions without heavy payload retransmission.
 */

export interface PatchStats {
  framesProcessed: number;
  framesPatched: number;
  imagesPatched: number;
}

export const stats: PatchStats = {
  framesProcessed: 0,
  framesPatched: 0,
  imagesPatched: 0,
};

export function resetStats(): void {
  stats.framesProcessed = 0;
  stats.framesPatched = 0;
  stats.imagesPatched = 0;
}

/** Matches ECMA-48 APC sequences used by the Kitty Graphics Protocol terminated by ST (\x1b\) or BEL (\x07). */
const KITTY_APC_REGEX = /\x1b_G[\s\S]*?(?:\x1b\\|\x07)/g;

/** Matches standard ANSI/VT cursor row-column positioning commands: \x1b[<row>;<col>H */
const CURSOR_POS_REGEX = /(\x1b\[\d+;\d+H)/;

/**
 * Transforms a terminal write buffer by deferring Kitty graphic placements to the end of the frame.
 * If the buffer contains no Kitty sequences or is already patched, returns the input unchanged.
 */
export function patchKittyBuffer(buffer: string): string {
  stats.framesProcessed++;

  if (!buffer || !buffer.includes("\x1b_G")) {
    return buffer;
  }

  // Split by cursor positioning commands: \x1b[<row>;<col>H
  const parts = buffer.split(CURSOR_POS_REGEX);
  if (parts.length < 3) {
    return buffer;
  }

  // Find the index of the last cursor row command
  let lastRowIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].startsWith("\x1b[") && parts[i].endsWith("H")) {
      lastRowIdx = i;
      break;
    }
  }

  // Idempotency check: if all Kitty sequences already reside at or after the last row command,
  // this buffer was already patched and must not be wrapped again.
  let hasKittyBeforeLastRow = false;
  for (let i = 0; i < lastRowIdx; i++) {
    if (parts[i].includes("\x1b_G")) {
      hasKittyBeforeLastRow = true;
      break;
    }
  }

  if (!hasKittyBeforeLastRow) {
    return buffer;
  }

  const deferred: { pos: string; seq: string }[] = [];
  const newParts: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith("\x1b[") && part.endsWith("H")) {
      const nextContent = parts[i + 1] || "";
      if (nextContent.includes("\x1b_G")) {
        let match: RegExpExecArray | null;
        KITTY_APC_REGEX.lastIndex = 0;
        while ((match = KITTY_APC_REGEX.exec(nextContent)) !== null) {
          deferred.push({ pos: part, seq: match[0] });
        }
        const stripped = nextContent.replace(KITTY_APC_REGEX, "");
        newParts.push(part);
        newParts.push(stripped);
        i++; // consumed nextContent
        continue;
      }
    }
    newParts.push(part);
  }

  if (deferred.length === 0) {
    return buffer;
  }

  stats.framesPatched++;
  stats.imagesPatched += deferred.length;

  // Build the deferred payload: save cursor (DECSC), emit each image at its target coordinate, restore cursor (DECRC)
  let deferredPayload = "\x1b7";
  for (const item of deferred) {
    deferredPayload += `${item.pos}${item.seq}`;
  }
  deferredPayload += "\x1b8";

  let result = newParts.join("");

  // Place immediately before synchronized output termination (\x1b[?2026l) if present,
  // otherwise append to the end of the frame buffer.
  const syncEndIdx = result.lastIndexOf("\x1b[?2026l");
  if (syncEndIdx !== -1) {
    result = result.slice(0, syncEndIdx) + deferredPayload + result.slice(syncEndIdx);
  } else {
    result += deferredPayload;
  }

  return result;
}
