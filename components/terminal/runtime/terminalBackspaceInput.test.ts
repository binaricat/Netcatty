import assert from "node:assert/strict";
import test from "node:test";

import { mapTerminalBackspaceInput } from "./terminalBackspaceInput";

const applyNetworkDeviceInput = (initial: string, input: string): string => {
  let line = initial;
  for (const byte of input) {
    if (byte === "\x08") line = line.slice(0, -1);
    else if (byte.charCodeAt(0) >= 32) line += byte;
  }
  return line;
};

test("Ctrl-H mode makes Backspace delete on network-device serial consoles", () => {
  const sent = mapTerminalBackspaceInput("\x7f", "ctrl-h");

  assert.equal(sent, "\x08");
  assert.equal(applyNetworkDeviceInput("abc", sent), "ab");
});

test("default mode preserves xterm Backspace and ordinary input", () => {
  assert.equal(mapTerminalBackspaceInput("\x7f", undefined), "\x7f");
  assert.equal(mapTerminalBackspaceInput("\x7f", "default"), "\x7f");
  assert.equal(mapTerminalBackspaceInput("show version", "ctrl-h"), "show version");
});
