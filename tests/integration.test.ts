import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { patchKittyBuffer } from "../patch.ts";
import { installKittyImageFix } from "../hook.ts";

describe("TuiAltScreen Integration", () => {
  it("patches TuiAltScreen write during doRender to prevent image erasing", () => {
    let written = "";
    const fakeTerm = {
      columns: 80,
      rows: 24,
      write: (data: string) => {
        written += data;
      },
    };

    const tui = new (TuiAltScreen as any)(fakeTerm, false, "/tmp");
    tui.imageProtocol = "kitty";
    tui.altScreenActive = true;

    // Dummy multi-row Kitty graphic (occupies 4 rows)
    const dummyKitty = "\x1b_Ga=T,f=100,r=4,c=20;AAAA\x1b\\";

    tui.layoutRoot = {
      render: () => [
        "Header",
        dummyKitty,
        "", "", "", // 3 empty placeholder rows
        "Footer",
      ],
    };

    // Install the fix
    const uninstall = installKittyImageFix(tui);

    tui.doRender();

    // Verify written contains the image
    assert.ok(written.includes("AAAA\x1b\\"), "Must contain image data");

    // Verify lines 3, 4, 5 were pre-cleared before the image was drawn
    const preClear = "\x1b[2;1H\x1b[2K\x1b[3;1H\x1b[2K\x1b[4;1H\x1b[2K\x1b[5;1H\x1b[2K";
    assert.ok(written.includes(preClear), "Must pre-clear rows 2, 3, 4, 5");

    // Verify that AFTER the image, rows 3, 4, 5 are NOT erased
    const afterImage = written.slice(written.indexOf("AAAA\x1b\\"));
    assert.ok(!afterImage.includes("\x1b[3;1H\x1b[2K"), "Row 3 must not be erased after image");
    assert.ok(!afterImage.includes("\x1b[4;1H\x1b[2K"), "Row 4 must not be erased after image");
    assert.ok(!afterImage.includes("\x1b[5;1H\x1b[2K"), "Row 5 must not be erased after image");
    assert.ok(afterImage.includes("Footer"), "Footer must be rendered");

    // Clean up
    uninstall();
  });
});
