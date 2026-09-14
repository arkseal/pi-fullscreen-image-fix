/**
 * Pure buffer patching logic for Kitty graphics protocol in Pi fullscreen TUI.
 *
 * The Problem:
 * In Pi's fullscreen TUI (TuiAltScreen), the Image component renders a Kitty image
 * on row N with r=<rows> and outputs empty strings on rows N+1..N+rows-1 as placeholders
 * to allocate layout height.
 *
 * During TuiAltScreen.doRender(), every row is drawn using:
 *   \x1b[${row + 1};1H\x1b[2K${line} (or \x1b[<mainWidth>X from pi-sidebar-tui)
 *
 * When rows N+1..N+rows-1 are processed, the erase command destroys the Kitty graphic
 * slice intersecting those cells in Kitty/Ghostty/WezTerm. This wipes out rows 2..rows
 * of the image, leaving only the very first terminal row (2-pixel slit-scan artifact).
 *
 * The Fix:
 * Whenever a write buffer contains a Kitty graphics sequence (\x1b_G), we detect
 * the number of rows reserved for the image (r=<rows>) from either transmission (a=T)
 * or placement (a=p) sequences.
 *
 * For all subsequent rows covered by the graphic (rows N+1..N+rows-1), we strip ONLY
 * the leading line-erase command (\x1b[2K or \x1b[<N>X).
 *
 * All cursor coordinates, styling resets, text lines, and sync markers are preserved intact.
 * No synthetic line erases or pre-clears are ever injected, ensuring total compatibility
 * with pi-sidebar-tui and native 60fps scrolling without GPU vertex flooding.
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

/**
 * Extract the number of terminal rows reserved for a Kitty image.
 * Returns 0 if not a Kitty sequence, or >= 1 if r parameter is found.
 */
export function extractKittyRows(content: string): number {
  if (!content || !content.includes("\x1b_G")) return 0;
  const match = /\x1b_G([^\x1b;]*)(?:;|\x1b\\)/.exec(content);
  if (!match) return 0;
  const rMatch = /(?:^|,)r=(\d+)(?:,|$)/.exec(match[1]);
  return rMatch ? parseInt(rMatch[1], 10) : 1;
}

/**
 * Patch a terminal write buffer to protect Kitty images from being cleared by
 * subsequent placeholder line erases.
 *
 * @param buffer Raw terminal escape sequences destined for stdout
 * @param maxRows Maximum valid terminal row
 */
export function patchKittyBuffer(buffer: string, maxRows = 9999): string {
  stats.framesProcessed++;

  // Fast path: if no Kitty graphics sequence exists in this buffer, do nothing
  if (!buffer || !buffer.includes("\x1b_G")) {
    return buffer;
  }

  // Split on row-positioning escape sequences: \x1b[<row>;1H
  const parts = buffer.split(/(\x1b\[\d+;1H)/);
  if (parts.length < 3) {
    return buffer;
  }

  let kittyEndRow = -1;
  let didPatch = false;
  const newParts: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (part.startsWith("\x1b[") && part.endsWith(";1H")) {
      const rowNum = parseInt(part.slice(2, -3), 10);
      const nextContent = parts[i + 1] || "";

      // Case 1: Start of a Kitty graphic placement or transmission
      if (nextContent.includes("\x1b_G")) {
        const rows = extractKittyRows(nextContent);
        if (rows > 1) {
          kittyEndRow = Math.max(kittyEndRow, rowNum + rows - 1);
          // Keep the image start row intact: it already has the appropriate line erase
          // (e.g. \x1b[118X from sidebar) followed by the image sequence.
          newParts.push(part);
          newParts.push(nextContent);
          i++; // consumed nextContent
          continue;
        }
      }

      // Case 2: Placeholder row covered by the active Kitty graphic
      if (rowNum <= kittyEndRow) {
        // Strip ONLY the leading line-erase command (\x1b[2K or \x1b[<N>X)
        // so that cell graphics are not wiped out.
        // Preserve all ANSI resets, cursor positions, and sync markers.
        const strippedContent = nextContent.replace(/^\x1b\[(?:[0-2]?K|\d+X)/, "");
        newParts.push(part);
        newParts.push(strippedContent);
        didPatch = true;
        stats.imagesPatched++;
        i++; // consumed nextContent
        continue;
      }
    }

    newParts.push(part);
  }

  if (didPatch) {
    stats.framesPatched++;
    return newParts.join("");
  }

  return buffer;
}
