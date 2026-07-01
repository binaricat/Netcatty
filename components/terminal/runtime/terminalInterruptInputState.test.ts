import assert from "node:assert/strict";
import test from "node:test";

import { clearTerminalInputStateForInterrupt } from "./terminalInterruptInputState";

test("interrupt input state clearing matches the normal Ctrl+C input bookkeeping", () => {
  const commandBufferRef = { current: "sudo apt" };
  const serialLineBufferRef = { current: "pending serial input" };
  const autocompleteInputs: string[] = [];

  clearTerminalInputStateForInterrupt({
    commandBufferRef,
    serialLineBufferRef,
    onAutocompleteInput: (data) => autocompleteInputs.push(data),
  });

  assert.equal(commandBufferRef.current, "");
  assert.equal(serialLineBufferRef.current, "");
  assert.deepEqual(autocompleteInputs, ["\x03"]);
});

test("interrupt input state clearing tolerates terminals without serial line mode", () => {
  const commandBufferRef = { current: "echo pending" };

  assert.doesNotThrow(() => {
    clearTerminalInputStateForInterrupt({ commandBufferRef });
  });
  assert.equal(commandBufferRef.current, "");
});
