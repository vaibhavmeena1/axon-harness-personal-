import { test } from "bun:test";
import assert from "node:assert/strict";
import { detectTerminalType, TERMINAL_TYPES } from "../src/terminal.ts";

test("classifies editors, emulators, and multiplexers into bounded values", () => {
  assert.equal(detectTerminalType({ TERM_PROGRAM: "vscode" }, true), "vscode");
  assert.equal(
    detectTerminalType({ TERM_PROGRAM: "vscode", CURSOR_TRACE_ID: "abc" }, true),
    "cursor",
  );
  assert.equal(
    detectTerminalType(
      { TERM_PROGRAM: "vscode", VSCODE_GIT_ASKPASS_MAIN: "/Applications/Windsurf.app/x" },
      true,
    ),
    "windsurf",
  );
  assert.equal(detectTerminalType({ TERMINAL_EMULATOR: "JetBrains-JediTerm" }, true), "jetbrains");
  assert.equal(detectTerminalType({ TERM_PROGRAM: "iTerm.app" }, true), "iterm");
  assert.equal(detectTerminalType({ TERM_PROGRAM: "Apple_Terminal" }, true), "apple_terminal");
  assert.equal(detectTerminalType({ TERM_PROGRAM: "ghostty" }, true), "ghostty");
  assert.equal(detectTerminalType({ TERM_PROGRAM: "WarpTerminal" }, true), "warp");
  assert.equal(detectTerminalType({ WT_SESSION: "1" }, true), "windows_terminal");
  assert.equal(detectTerminalType({ KITTY_WINDOW_ID: "1" }, true), "kitty");
});

test("prefers a recognizable outer terminal over tmux, then falls back", () => {
  assert.equal(
    detectTerminalType({ TERM_PROGRAM: "tmux", TMUX: "/tmp/x", KITTY_WINDOW_ID: "1" }, true),
    "kitty",
  );
  assert.equal(detectTerminalType({ TERM_PROGRAM: "tmux", TMUX: "/tmp/x" }, true), "tmux");
  assert.equal(detectTerminalType({ SSH_CONNECTION: "a b c d" }, true), "ssh");
  assert.equal(detectTerminalType({ TERM_PROGRAM: "SomethingNew" }, true), "other");
  assert.equal(detectTerminalType({}, false), "none");
});

test("never exports a value outside the allowlist", () => {
  const value = detectTerminalType({ TERM_PROGRAM: "evil\nvalue" }, true);
  assert.ok((TERMINAL_TYPES as readonly string[]).includes(value));
});
