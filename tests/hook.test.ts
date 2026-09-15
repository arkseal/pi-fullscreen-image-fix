import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  installGlobalStdoutHook,
  uninstallGlobalStdoutHook,
  isStdoutHookInstalled,
} from "../hook.ts";

describe("hook", () => {
  beforeEach(() => {
    uninstallGlobalStdoutHook();
  });

  afterEach(() => {
    uninstallGlobalStdoutHook();
  });

  it("installs and uninstalls cleanly", () => {
    assert.equal(isStdoutHookInstalled(), false);
    installGlobalStdoutHook();
    assert.equal(isStdoutHookInstalled(), true);
    uninstallGlobalStdoutHook();
    assert.equal(isStdoutHookInstalled(), false);
  });

  it("is idempotent on repeated install calls", () => {
    installGlobalStdoutHook();
    installGlobalStdoutHook();
    assert.equal(isStdoutHookInstalled(), true);
    uninstallGlobalStdoutHook();
    assert.equal(isStdoutHookInstalled(), false);
  });

  it("intercepts and transforms stdout writes containing Kitty graphics", () => {
    let captured = "";
    const proto = Object.getPrototypeOf(process.stdout);
    const origProtoWrite = proto.write;

    proto.write = function (data: any) {
      captured += typeof data === "string" ? data : data.toString("utf8");
      return true;
    };

    try {
      installGlobalStdoutHook();

      const input = "\x1b[?2026h\x1b[1;1H\x1b[118X\x1b_Ga=p,c=20,r=5,i=1\x1b\\\x1b[2;1H\x1b[118X\x1b[?2026l";
      process.stdout.write(input);

      // Verify Kitty placement was deferred before sync end
      assert.ok(captured.includes("\x1b7\x1b[1;1H\x1b_Ga=p,c=20,r=5,i=1\x1b\\\x1b8\x1b[?2026l"));
    } finally {
      uninstallGlobalStdoutHook();
      proto.write = origProtoWrite;
    }
  });
});
