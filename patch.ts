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
 * The Fix (Purely Local Two-Pass Architecture):
 * 1. Pass 1: Scan the incoming write buffer for all Kitty graphic transmissions (a=T)
 *    and placements (a=p) to find their exact row extent [startRow..endRow] and column width (cols).
 * 2. Pass 2: For each row in the buffer:
 *    - If the row is covered as a placeholder under an image, rewrite the leading line-erase
 *      to start AFTER the image columns: `\x1b[${row};${cols + 1}H\x1b[${rem}X`.
 *      Columns 1..cols (the image graphic) are NEVER erased.
 *      Columns cols+1..mainWidth (stale text area) are cleanly erased.
 *      Columns mainWidth+1..termWidth (the sidebar) are untouched.
 *    - If the row is not covered by an image, it is preserved completely unmodified.
 * 3. Fully stateless: No module-level state leaks between frames, ensuring 100% accuracy
 *    during scrolling, fast viewport jumps, and multiple simultaneous images.
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

export interface ImageRegion {
  startRow: number;
  endRow: number;
  cols: number;
}

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
 * Patch a terminal write buffer to protect Kitty images from being cleared by
 * subsequent placeholder line erases, while wiping stale text to the right of the image.
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

  // Pass 1: Discover all image regions defined in THIS frame
  const imageRegions: ImageRegion[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith("\x1b[") && part.endsWith(";1H")) {
      const rowNum = parseInt(part.slice(2, -3), 10);
      const nextContent = parts[i + 1] || "";
      const dims = extractKittyDims(nextContent);
      if (dims) {
        imageRegions.push({
          startRow: rowNum,
          endRow: Math.min(rowNum + dims.rows - 1, maxRows),
          cols: dims.cols,
        });
      }
    }
  }

  // If no multi-row image was found in this buffer, return unmodified
  if (imageRegions.length === 0) {
    return buffer;
  }

  // Pass 2: Rewrite erases for rows covered by active images in this frame
  let didPatch = false;
  const newParts: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (part.startsWith("\x1b[") && part.endsWith(";1H")) {
      const rowNum = parseInt(part.slice(2, -3), 10);
      const nextContent = parts[i + 1] || "";

      // Find if this row is covered as a placeholder by ANY image in this frame
      const covering = imageRegions.find(
        (img) => rowNum > img.startRow && rowNum <= img.endRow
      );

      if (covering) {
        const match = nextContent.match(/^\x1b\[(?:[0-2]?K|(\d+)X)/);
        if (match) {
          const totalWidth = match[1] ? parseInt(match[1], 10) : 118;
          const rem = Math.max(0, totalWidth - covering.cols);
          const eraseCmd = match[1] ? `\x1b[${rem}X` : "\x1b[K";
          const rest = nextContent.slice(match[0].length);
          // Position cursor to start after the image (cols + 1) and erase the rest of main area
          const rewritten = `\x1b[${rowNum};${covering.cols + 1}H${eraseCmd}${rest}`;
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
