import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { installGlobalStdoutHook } from "./hook.ts";
import { patchKittyBuffer, stats, resetStats } from "./patch.ts";
import { generateTestPng } from "./png.ts";

export { installGlobalStdoutHook, installKittyImageFix } from "./hook.ts";
export { patchKittyBuffer, stats, resetStats } from "./patch.ts";
export { generateTestPng } from "./png.ts";

// Immediately install hook on module load so output is protected as early as possible
installGlobalStdoutHook();

export default function fullscreenImageFixPlugin(pi: ExtensionAPI): void {
  installGlobalStdoutHook();

  pi.registerCommand("image-fix", {
    description: "Inspect status or generate test pattern for fullscreen Kitty image rendering fix",
    handler: async (args, ctx) => {
      const sub = (args || "").trim().toLowerCase();

      if (sub === "test" || sub === "generate-test") {
        const testFilePath = path.join(ctx.cwd, "test-pattern-64x64.png");
        const pngBuf = generateTestPng(64, 64);
        fs.writeFileSync(testFilePath, pngBuf);
        ctx.ui?.notify?.(`Generated test PNG at ${testFilePath}`, "info");
        return;
      }

      if (sub === "reset") {
        resetStats();
        ctx.ui?.notify?.("Fullscreen Kitty image fix stats have been reset.", "info");
        return;
      }

      const report = [
        "**Fullscreen Kitty Image Fix Status**",
        `- Active: true`,
        `- Frames Processed: ${stats.framesProcessed}`,
        `- Frames Patched: ${stats.framesPatched}`,
        `- Images Patched: ${stats.imagesPatched}`,
        "",
        "Usage:",
        "- `/image-fix` - Display current stats",
        "- `/image-fix test` - Generate test-pattern-64x64.png",
        "- `/image-fix reset` - Reset counter stats",
      ].join("\n");

      ctx.ui?.notify?.(report, "info");
    },
  });
}
