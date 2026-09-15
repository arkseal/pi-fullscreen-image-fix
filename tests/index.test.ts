import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fullscreenImageFixPlugin from "../index.ts";

describe("fullscreenImageFixPlugin", () => {
  it("registers image-fix command with options and handlers", () => {
    const registeredCommands = new Map<string, any>();

    const fakePi = {
      registerCommand(name: string, opts: any) {
        registeredCommands.set(name, opts);
      },
    } as any;

    fullscreenImageFixPlugin(fakePi);

    assert.ok(registeredCommands.has("image-fix"), "Should register image-fix command");
    const cmd = registeredCommands.get("image-fix");
    assert.equal(typeof cmd.handler, "function");
    assert.ok(cmd.description.includes("Kitty"));
  });
});
