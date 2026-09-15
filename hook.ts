import { patchKittyBuffer } from "./patch.ts";

const SYM_HOOKED = Symbol.for("pi.fullscreen-image-fix.hooked");
const SYM_ORIGINAL_WRITE = Symbol.for("pi.fullscreen-image-fix.original-write");

/**
 * Installs the global stdout write hook that intercepts terminal rendering chunks
 * and defers Kitty graphic placements to the end of each frame.
 *
 * Idempotent: safe to call multiple times without creating stacked wrappers.
 */
export function installGlobalStdoutHook(): void {
  const stdout = process.stdout as any;

  if (stdout[SYM_HOOKED]) {
    return;
  }

  // Resolve the underlying unhooked write implementation from Stream/Socket prototype
  const baseWrite = stdout[SYM_ORIGINAL_WRITE] || Object.getPrototypeOf(stdout).write;
  stdout[SYM_ORIGINAL_WRITE] = baseWrite;

  let inHook = false;

  stdout.write = function (
    chunk: any,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
  ): boolean {
    const isBuf = Buffer.isBuffer(chunk);
    const rawStr = typeof chunk === "string" ? chunk : isBuf ? chunk.toString("utf8") : "";

    if (!inHook && rawStr.includes("\x1b_G")) {
      inHook = true;
      try {
        const patched = patchKittyBuffer(rawStr);
        if (patched !== rawStr) {
          chunk = isBuf ? Buffer.from(patched, "utf8") : patched;
        }
      } finally {
        inHook = false;
      }
    }

    return baseWrite.call(this, chunk, encodingOrCallback, callback);
  };

  stdout[SYM_HOOKED] = true;
}

/**
 * Removes the stdout write hook and restores the original implementation.
 */
export function uninstallGlobalStdoutHook(): void {
  const stdout = process.stdout as any;
  if (!stdout[SYM_HOOKED]) return;

  const originalWrite = stdout[SYM_ORIGINAL_WRITE];
  if (originalWrite) {
    stdout.write = originalWrite;
    delete stdout[SYM_ORIGINAL_WRITE];
  }
  delete stdout[SYM_HOOKED];
}

/**
 * Checks if the stdout write hook is currently active.
 */
export function isStdoutHookInstalled(): boolean {
  return Boolean((process.stdout as any)[SYM_HOOKED]);
}

/**
 * Compatibility helper for existing TUI lifecycle attachments.
 */
export function installKittyImageFix(_tui?: unknown): () => void {
  installGlobalStdoutHook();
  return () => {
    uninstallGlobalStdoutHook();
  };
}
