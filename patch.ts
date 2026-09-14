/**
 * Pure buffer patching logic for Kitty graphics protocol in Pi fullscreen TUI.
 *
 * Problem:
 * In Pi's fullscreen TUI (TuiAltScreen), the Image component renders a Kitty image
 * on row N with r=<rows>, c=<cols> and outputs empty strings on rows N+1..N+rows-1 as placeholders
 * to allocate layout height.
 *
 * During TuiAltScreen.doRender(), every row is drawn using:
 *   \x1b[${row + 1};1H\x1b[2K${line} (or \x1b[<mainWidth>X from pi-sidebar-tui)
 *
 * When rows N+1..N+rows-1 are processed, the erase command destroys the Kitty graphic
 * slice intersecting those cells in WezTerm/Kitty/Ghostty. This wipes out rows 2..rows
 * of the image, leaving only the very first terminal row (the 1-row slit-scan artifact).
 *
 * Furthermore, completely removing the erase command leaves stale text from previous turns
 * visible to the right of the image (columns c+1..mainWidth).
 *
 * The Fix:
 * Whenever a write buffer contains a Kitty graphics sequence (\x1b_G), we detect
 * the number of rows (r) and columns (c) reserved for the image.
 *
 * On rows covered by the graphic (rows N+1..N+rows-1):
 * - We preserve columns 1..c so image graphic pixels are NEVER erased.
 * - We reposition the cursor to column c+1 and erase columns c+1..mainWidth (\x1b[<mainWidth-c>X
 *   or \x1b[K), cleanly wiping stale text to the right of the image without touching the sidebar.
 * - All cursor coordinates, styling resets, text lines, and sync markers are preserved.
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

export interface ActiveKitty {
  startRow: number;
  endRow: number;
  cols: number;
}

let activeKitty: ActiveKitty | null = null;

/**
 * Extract dimensions (rows, cols) from a Kitty graphics sequence.
 */
export function extractKittyDims(content: string): { rows: number; cols: number } | null {
  if (!content || !content.includes("\x1b_G")) return null;
  const regex = /\x1b_G([^\x1b;]*)(?:;|\x1b\\)/g;
  let m: RegExpExecArray | null;
  let maxRows = 0;
  let maxCols = 0;
  while ((m = regex.exec(content)) !== null) {
    const rM = /(?:^|,)r=(\d+)(?:,|$)/.exec(m[1]);
    const cM = /(?:^|,)c=(\d+)(?:,|$)/.exec(m[1]);
    if (rM) maxRows = Math.max(maxRows, parseInt(rM[1], 10));
    if (cM) maxCols = Math.max(maxCols, parseInt(cM[1], 10));
  }
  if (maxRows > 1) {
    return { rows: maxRows, cols: maxCols || 60 };
  }
  return null;
}

/**
 * Reset tracked active Kitty graphic state (useful in tests or when screen clears).
 */
export function resetActiveKitty(): void {
  activeKitty = null;
}

/**
 * Patch a terminal write buffer to protect Kitty images from being cleared by
 * subsequent placeholder line erases, while wiping stale text to the right of the image.
 *
 * @param buffer Raw terminal escape sequences destined for stdout
 * @param maxRows Maximum valid terminal row
 */
export function patchKittyBuffer(buffer: string, maxRows = 9999): string {
  stats.framesProcessed++;

  if (!buffer) {
    return buffer;
  }

  // If buffer deletes all placements or clears full screen, reset active image state
  if (buffer.includes("\x1b_Ga=d,d=a") || buffer.includes("\x1b_Ga=d,d=A") || buffer.includes("\x1b[2J")) {
    activeKitty = null;
  }

  // Fast path: if no Kitty graphics sequence exists and no active image, do nothing
  if (!buffer.includes("\x1b_G") && !activeKitty) {
    return buffer;
  }

  // Split on row-positioning escape sequences: \x1b[<row>;1H
  const parts = buffer.split(/(\x1b\[\d+;1H)/);
  if (parts.length < 3) {
    return buffer;
  }

  let didPatch = false;
  const newParts: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (part.startsWith("\x1b[") && part.endsWith(";1H")) {
      const rowNum = parseInt(part.slice(2, -3), 10);
      const nextContent = parts[i + 1] || "";

      // Case 1: Start of a multi-row Kitty graphic placement or transmission
      const dims = extractKittyDims(nextContent);
      if (dims) {
        activeKitty = {
          startRow: rowNum,
          endRow: Math.min(rowNum + dims.rows - 1, maxRows),
          cols: dims.cols,
        };
        newParts.push(part);
        newParts.push(nextContent);
        i++; // consumed nextContent
        continue;
      }

      // Case 2: Row covered by the active Kitty graphic
      if (activeKitty && rowNum > activeKitty.startRow && rowNum <= activeKitty.endRow) {
        // Rewrite the leading erase to start AFTER the image columns (cols + 1)
        // so image cells 1..cols are NOT erased, but stale text on cols+1..mainWidth IS erased.
        const match = nextContent.match(/^\x1b\[(?:[0-2]?K|(\d+)X)/);
        if (match) {
          const totalWidth = match[1] ? parseInt(match[1], 10) : 118;
          const rem = Math.max(0, totalWidth - activeKitty.cols);
          const eraseCmd = match[1] ? `\x1b[${rem}X` : "\x1b[K";
          const rest = nextContent.slice(match[0].length);
          const rewritten = `\x1b[${rowNum};${activeKitty.cols + 1}H${eraseCmd}${rest}`;
          newParts.push(rewritten);
          didPatch = true;
          stats.imagesPatched++;
          i++; // consumed nextContent
          continue;
        }
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
