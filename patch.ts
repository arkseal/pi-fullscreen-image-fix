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
 * 1. For any multi-row Kitty image, we identify its exact row coverage [startRow..endRow]
 *    and column width (cols).
 * 2. For all placeholder rows (startRow+1..endRow):
 *    - Image cells (columns 1..cols) are NEVER erased.
 *    - The leading line-erase is rewritten to start at column cols+1:
 *      `\x1b[${row};${cols + 1}H\x1b[${rem}X` where rem = mainWidth - cols.
 *    - This cleanly wipes stale text to the right of the image without touching the graphic
 *      and without touching the sidebar (columns mainWidth+1..termWidth).
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
 * Discover image regions from a rendered screen line array.
 */
export function discoverImageRegionsFromScreen(
  screen: readonly string[],
  termRows = 39,
  mainWidth = 118
): ImageRegion[] {
  const regions: ImageRegion[] = [];
  for (let r = 0; r < screen.length; r++) {
    const line = screen[r] || "";
    if (line.includes("\x1b_G")) {
      const dims = extractKittyDims(line);
      if (dims) {
        regions.push({
          startRow: r + 1, // 1-indexed terminal row
          endRow: Math.min(r + dims.rows, termRows),
          cols: Math.min(dims.cols, mainWidth),
        });
      }
    }
  }
  return regions;
}

/**
 * Patch a terminal write buffer using known image regions.
 *
 * @param buffer Raw terminal escape sequences
 * @param imageRegions Active image regions on the screen
 * @param defaultMainWidth Width of the main area (e.g. 118)
 */
export function patchBufferWithRegions(
  buffer: string,
  imageRegions: ImageRegion[],
  defaultMainWidth = 118
): string {
  if (imageRegions.length === 0 || !buffer) {
    return buffer;
  }

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

      const covering = imageRegions.find(
        (img) => rowNum > img.startRow && rowNum <= img.endRow
      );

      if (covering) {
        const match = nextContent.match(/^\x1b\[(?:[0-2]?K|(\d+)X)/);
        if (match) {
          const totalWidth = match[1] ? parseInt(match[1], 10) : defaultMainWidth;
          const rem = Math.max(0, totalWidth - covering.cols);
          const eraseCmd = `\x1b[${rem}X`;
          const rest = nextContent.slice(match[0].length);
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

/**
 * Fallback buffer patcher that self-discovers image regions from Kitty sequences
 * within the buffer itself (used for stdout writes).
 */
export function patchKittyBuffer(buffer: string, maxRows = 9999): string {
  stats.framesProcessed++;

  if (!buffer || !buffer.includes("\x1b_G")) {
    return buffer;
  }

  const parts = buffer.split(/(\x1b\[\d+;1H)/);
  if (parts.length < 3) {
    return buffer;
  }

  // Discover all image regions defined in THIS frame
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

  if (imageRegions.length === 0) {
    return buffer;
  }

  return patchBufferWithRegions(buffer, imageRegions);
}
