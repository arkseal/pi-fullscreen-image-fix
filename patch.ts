/**
 * Pure buffer patching logic for Kitty graphics protocol in Pi fullscreen TUI.
 *
 * Problem:
 * In Pi's fullscreen TUI (TuiAltScreen), the Image component renders a Kitty image
 * on row N with r=<rows> and outputs empty strings on rows N+1..N+rows-1 as placeholders
 * to allocate layout height.
 *
 * During TuiAltScreen.doRender(), every row is drawn using:
 *   \x1b[${row + 1};1H\x1b[2K${line}
 *
 * When rows N+1..N+rows-1 are processed, \x1b[2K (Erase Line) or \x1b[<N>X (from
 * pi-sidebar-tui) is emitted on the empty placeholders. In terminals supporting
 * the Kitty graphics protocol (Ghostty, Kitty, WezTerm), clearing cells deletes
 * the graphic intersecting those cells. This wipes out rows 2..rows of the image,
 * leaving only the very first terminal row (about 2 pixel rows for a 64x64 image).
 *
 * Furthermore, when scrolling, Pi's prepareKittyScreen downgrades the image to an
 * a=p (placement-only) command without payload. Terminal emulators like WezTerm
 * do not reliably re-render placements after placement deletion (\x1b_Ga=d,d=a).
 *
 * Solution:
 * 1. Cache image payloads from a=T transmissions by image ID.
 * 2. When a=p placement is encountered on scroll, restore it to a=T so the terminal
 *    receives a direct, self-contained graphic command.
 * 3. Pre-clear all lines that the image will occupy before emitting the graphic.
 * 4. Suppress line erases (\x1b[2K and \x1b[<N>X) on placeholder rows N+1..N+rows-1,
 *    while preserving cursor coordinates, styling resets, and sync markers (\x1b[?2026l).
 */

import * as fs from "node:fs";

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
 * @param buffer Raw terminal escape sequences destined for terminal.write()
 * @param maxRows Maximum valid terminal row (to prevent out-of-bounds line clears)
 */
export function patchKittyBuffer(buffer: string, maxRows = 9999): string {
  stats.framesProcessed++;

  if (!buffer || !buffer.includes("\x1b_G")) {
    return buffer;
  }

  // Restore a=p placements to a=T using cached payloads
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

      // Case 1: Check if nextContent contains a Kitty image placement/transmission
      const rows = extractKittyRows(nextContent);
      if (rows > 1) {
        kittyEndRow = Math.max(kittyEndRow, rowNum + rows - 1);
        const clampedEnd = Math.min(kittyEndRow, maxRows);
        const eraseCmd = detectEraseCommand(nextContent);

        // Pre-clear all lines that the image will occupy
        const preClear: string[] = [];
        for (let r = rowNum; r <= clampedEnd; r++) {
          preClear.push(`\x1b[${r};1H${eraseCmd}`);
        }
        newParts.push(preClear.join(""));

        // Move cursor back to the start row for the image
        newParts.push(part);

        // Strip the redundant leading erase from nextContent
        const strippedContent = nextContent.replace(/^\x1b\[(?:[0-2]?K|\d+X)/, "");
        newParts.push(strippedContent);

        didPatch = true;
        stats.imagesPatched++;
        i++; // consumed nextContent
        continue;
      }

      // Case 2: We are on a row covered by an active Kitty graphic
      if (rowNum <= kittyEndRow) {
        // Strip the line-erase command so cells and image pixels are not destroyed,
        // while preserving any styling resets, cursor positioning, or end-of-frame markers.
        const strippedContent = nextContent.replace(/^\x1b\[(?:[0-2]?K|\d+X)/, "");
        newParts.push(part);
        newParts.push(strippedContent);
        didPatch = true;
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
