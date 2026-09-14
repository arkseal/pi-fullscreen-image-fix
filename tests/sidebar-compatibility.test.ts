import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { ScrollView } from "/home/aarush/.nvm/versions/node/v22.23.2/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/components/scroll-view.js";
import { Image } from "/home/aarush/.nvm/versions/node/v22.23.2/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/components/image.js";
import { setCapabilities } from "/home/aarush/.nvm/versions/node/v22.23.2/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/terminal-image.js";
import { SidebarCompositor } from "/home/aarush/code/pi_plugins/pi-sidebar-tui/compositor.ts";
import { generateTestPng } from "../index.ts";
import { patchKittyBuffer } from "../patch.ts";

describe("Sidebar Compatibility & Scrolling", () => {
  it("never emits \\x1b[2K and preserves sidebar columns when scrolling images", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });

    let stdoutWrites: string[] = [];
    const fakeTerm = {
      columns: 159,
      rows: 39,
      write: (data: string) => {
        // Simulate stdout hook: runs on final terminal output
        if (typeof data === "string" && data.includes("\x1b_G")) {
          data = patchKittyBuffer(data, 39);
        }
        stdoutWrites.push(data);
      },
    };

    const tui = new TuiAltScreen(fakeTerm, false, "/tmp");
    tui.imageProtocol = "kitty";
    tui.altScreenActive = true;

    // Install sidebar with 40 cols (main area = 118 cols)
    const sidebar = new SidebarCompositor(tui, () => ({ cwd: "/test" }), 40);
    sidebar.install();

    const png = generateTestPng(64, 64);
    const img = new Image(png.toString("base64"), "image/png", { fallbackColor: s => s }, { maxWidthCells: 60 });
    const doc = {
      render: (w: number) => [
        ...Array.from({ length: 5 }, (_, i) => `Line ${i}`),
        ...img.render(w),
        ...Array.from({ length: 20 }, (_, i) => `After ${i}`),
      ],
    };

    const sv = new ScrollView(doc, { follow: "none" });
    tui.setLayoutRoot(sv);

    // Initial render
    tui.doRender();

    // Scroll 1: Image moves up
    stdoutWrites = [];
    sv.scrollBy(2);
    tui.doRender();

    let combined = stdoutWrites.join("");
    assert.ok(!combined.includes("\x1b[2K"), "Must never emit \\x1b[2K across the screen");
    assert.ok(combined.includes("\x1b[118X"), "Must use width-limited erase \\x1b[118X for main area");
    assert.ok(combined.includes("a=p"), "Uses lightweight placement command on scroll");

    // Scroll 2: Image is partially cropped at top (scrollTop > image row)
    stdoutWrites = [];
    sv.scrollBy(10);
    tui.doRender();

    combined = stdoutWrites.join("");
    assert.ok(!combined.includes("\x1b[2K"), "Must never emit \\x1b[2K when cropped");
    assert.ok(combined.includes("\x1b[118X"), "Must keep width-limited erase when cropped");
  });
});
