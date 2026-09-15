/**
 * Pure buffer patching logic for Kitty graphics protocol in Pi fullscreen TUI.
 *
 * Problem:
 * In Pi's fullscreen TUI (TuiAltScreen), the Image component renders a Kitty image
 * on row N with r=<rows>, c=<cols> and outputs empty strings on rows N+1..N+rows-1 as placeholders
 * to allocate layout height.
 *
 * During TuiAltScreen.doRender(), every row is drawn sequentially from top to bottom:
 *   Row N:   \x1b[${N};1H\x1b[118X\x1b_Ga=...
 *   Row N+1: \x1b[${N+1};1H\x1b[118X
 *   ...
 *   Row N+r: \x1b[${N+r};1H\x1b[118X
 *
 * In WezTerm (and Kitty/Ghostty):
 * - Because the image is placed on Row N, subsequent row erases (\x1b[118X or \x1b[2K) on rows
 *   N+1..N+r-1 erase the graphic cells on those rows, causing the 1-row slit-scan artifact.
 * - If placeholder row erases are suppressed or offset, leftover text from previous turns remains
 *   in those cells, which pokes holes through the graphic in WezTerm (the "notch" artifact).
 * - If line-erase uses \x1b[K, it extends past column 118 and wipes the right sidebar.
 *
 * The Ultimate Fix (End-of-Frame Deferred Placement):
 * Rather than attempting to micro-manage line erases across individual placeholder rows:
 * 1. We extract all Kitty image sequences from the row drawing commands in the buffer.
 * 2. Every row (including Row N and placeholder rows N+1..N+r-1) is erased and drawn normally.
 *    - All cells are wiped clean of stale text.
 *    - The sidebar columns are completely preserved.
 * 3. AT THE VERY END OF THE FRAME (after all text and line erases have finished):
 *    We place the Kitty image at its target row using DECSC (\x1b7) and DECRC (\x1b8)
 *    to preserve the cursor position.
 *
 * Result:
 * - The cells under the graphic are pristine and empty (no stale text holes / notch).
 * - No line erase ever runs after the graphic is placed (no slit-scan collapse).
 * - The sidebar is untouched.
 * - Smooth 60 FPS native scrolling.
 */

import * as fs from "node:fs";

function debugLog(msg: string): void {
  try {
    fs.appendFileSync("/tmp/kitty-fix-debug.log", `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

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

/**
 * Patch a terminal write buffer by deferring Kitty graphic placements to the end of the frame.
 */
export function patchKittyBuffer(buffer: string): string {
  stats.framesProcessed++;

  if (!buffer || !buffer.includes("\x1b_G")) {
    return buffer;
  }

  // Split by row positioning escape sequences (\x1b[<row>;<col>H)
  const parts = buffer.split(/(\x1b\[\d+;\d+H)/);
  if (parts.length < 3) {
    return buffer;
  }

  // Find the last row command index
  let lastRowIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].startsWith("\x1b[") && parts[i].endsWith("H")) {
      lastRowIdx = i;
      break;
    }
  }

  // Idempotency: if all Kitty sequences are already at or after the last row command,
  // this buffer was already patched.
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
        // Extract all Kitty sequences from nextContent
        const kittyRegex = /\x1b_G(?:[^\x1b;]*;[^\x1b]*|[^\x1b]*)\x1b\\/g;
        let m: RegExpExecArray | null;
        while ((m = kittyRegex.exec(nextContent)) !== null) {
          deferred.push({ pos: part, seq: m[0] });
        }
        const stripped = nextContent.replace(kittyRegex, "");
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

  debugLog(`patchKittyBuffer: deferred ${deferred.length} image(s) to end of frame`);

  // Build the deferred payload: save cursor (DECSC), place images, restore cursor (DECRC)
  let deferredPayload = "\x1b7";
  for (const item of deferred) {
    deferredPayload += `${item.pos}${item.seq}`;
  }
  deferredPayload += "\x1b8";

  let result = newParts.join("");

  // Insert right before \x1b[?2026l (end of synchronized output) if present,
  // otherwise append to the end of the buffer
  const syncEndIdx = result.lastIndexOf("\x1b[?2026l");
  if (syncEndIdx !== -1) {
    result = result.slice(0, syncEndIdx) + deferredPayload + result.slice(syncEndIdx);
  } else {
    result += deferredPayload;
  }

  return result;
}
