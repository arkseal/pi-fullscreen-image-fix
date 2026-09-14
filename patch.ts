/**
 * Pure buffer patching logic for Kitty graphics protocol in Pi fullscreen TUI.
 *
 * Problem:
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
 * Furthermore, when scrolling:
 * 1. Pi converts the graphic to a placement-only sequence (a=p) without the image payload.
 *    WezTerm fails to resolve placements after placement deletion (a=d,d=a).
 * 2. If an extension or fix introduces full-line erases (\x1b[2K), it wipes out the sidebar
 *    columns (e.g. cols 119..159), breaking the sidebar layout.
 *
 * Solution:
 * 1. Cache image payloads from a=T transmissions by image ID.
 * 2. On scroll frames, rewrite a=p placements back to full a=T commands with the cached payload.
 * 3. On placeholder rows N+1..N+rows-1, strip ONLY the leading erase command (\x1b[2K or \x1b[<N>X),
 *    preserving all cursor coordinates, text, styling resets, and sync markers.
 * 4. Never inject \x1b[2K or pre-clear sequences, protecting the sidebar columns from erasure.
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

const kittyPayloadCache = new Map<number, string>();
const pendingPayloads = new Map<number, string>();

/**
 * Cache Kitty image payloads from a=T transmissions and rewrite a=p placements
 * back to full a=T commands to bypass terminal emulator placement lookup bugs on scroll.
 */
export function trackAndRewriteKittyPlacements(buffer: string): string {
  if (!buffer.includes("\x1b_G")) return buffer;

  // 1. Capture image transmissions (a=T or a=t)
  const regex = /\x1b_G([^\x1b;]+);([^\x1b]*)\x1b\\/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(buffer)) !== null) {
    const controls = match[1];
    const chunk = match[2];
    const idMatch = /(?:^|,)i=(\d+)(?:,|$)/.exec(controls);
    if (!idMatch) continue;
    const id = parseInt(idMatch[1], 10);

    const isChunked = /(?:^|,)m=1(?:,|$)/.test(controls);
    const isLastChunk = /(?:^|,)m=0(?:,|$)/.test(controls);

    if (isChunked) {
      const prev = pendingPayloads.get(id) || "";
      pendingPayloads.set(id, prev + chunk);
    } else if (isLastChunk) {
      const prev = pendingPayloads.get(id) || "";
      kittyPayloadCache.set(id, prev + chunk);
      pendingPayloads.delete(id);
    } else {
      kittyPayloadCache.set(id, chunk);
      pendingPayloads.delete(id);
    }
  }

  // 2. Rewrite a=p to a=T if we have the cached payload
  return buffer.replace(/\x1b_G([^\x1b;]*a=p[^\x1b;]*)\x1b\\/g, (fullMatch, controls) => {
    const idMatch = /(?:^|,)i=(\d+)(?:,|$)/.exec(controls);
    if (!idMatch) return fullMatch;
    const id = parseInt(idMatch[1], 10);
    const payload = kittyPayloadCache.get(id);
    if (!payload) return fullMatch;

    let newControls = controls.replace(/(?:^|,)a=p(?:,|$)/, (m) => m.replace("a=p", "a=T"));
    if (!/(?:^|,)f=\d+/.test(newControls)) {
      newControls += ",f=100";
    }

    if (payload.length <= 4096) {
      return `\x1b_G${newControls};${payload}\x1b\\`;
    }

    const CHUNK_SIZE = 4096;
    const chunks: string[] = [];
    for (let offset = 0; offset < payload.length; offset += CHUNK_SIZE) {
      const slice = payload.slice(offset, offset + CHUNK_SIZE);
      const isFirst = offset === 0;
      const isLast = offset + CHUNK_SIZE >= payload.length;
      if (isFirst) {
        chunks.push(`\x1b_G${newControls},m=1;${slice}\x1b\\`);
      } else if (isLast) {
        chunks.push(`\x1b_Gm=0;${slice}\x1b\\`);
      } else {
        chunks.push(`\x1b_Gm=1;${slice}\x1b\\`);
      }
    }
    return chunks.join("");
  });
}

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
 * Test whether a row content is purely an erase command, resets, and whitespace,
 * with no visible text content.
 */
export function isEraseOnly(content: string): boolean {
  if (!content) return true;
  return /^(?:\x1b\[(?:[0-2]?K|\d+X|\d+;\d+H|\?25[hl]|\?2026[hl])|\x1b\[0m|\x1b\]8;;(?:\x07|\x1b\\)|\s)*$/.test(content);
}

/**
 * Detect the erase command style used in this line (e.g. \x1b[2K or \x1b[45X from sidebar).
 */
export function detectEraseCommand(content: string): string {
  const match = content.match(/^\x1b\[(?:[0-2]?K|\d+X)/);
  return match ? match[0] : "\x1b[2K";
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

  if (!buffer || !buffer.includes("\x1b_G")) {
    return buffer;
  }

  // Restore a=p placements to full a=T transmissions using cached payloads
  buffer = trackAndRewriteKittyPlacements(buffer);

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

      // Case 1: Start of a Kitty graphic placement
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
