import assert from "node:assert/strict";
import test from "node:test";
import type { Terminal as XTerm } from "@xterm/xterm";

import {
  XTERM_WRITE_CALLBACK_BATCH_BYTES,
  XTERM_WRITE_CALLBACK_FAST_PATH_MAX_BYTES,
} from "./terminalFlowConstants.ts";
import {
  accumulateDeferredTerminalWriteAck,
  clearDeferredTerminalWriteAck,
  shouldDeferTerminalWriteCallback,
} from "./terminalWriteAckDeferral.ts";

const createTerm = (): XTerm => ({}) as XTerm;

test("shouldDeferTerminalWriteCallback allows small writes under the batch ceiling", () => {
  assert.equal(
    shouldDeferTerminalWriteCallback(
      XTERM_WRITE_CALLBACK_FAST_PATH_MAX_BYTES,
      0,
      100,
      XTERM_WRITE_CALLBACK_FAST_PATH_MAX_BYTES,
      XTERM_WRITE_CALLBACK_BATCH_BYTES,
    ),
    true,
  );
});

test("shouldDeferTerminalWriteCallback rejects writes that would cross the batch ceiling", () => {
  assert.equal(
    shouldDeferTerminalWriteCallback(
      100,
      XTERM_WRITE_CALLBACK_BATCH_BYTES - 50,
      100,
      XTERM_WRITE_CALLBACK_FAST_PATH_MAX_BYTES,
      XTERM_WRITE_CALLBACK_BATCH_BYTES,
    ),
    false,
  );
});

test("accumulateDeferredTerminalWriteAck tracks ingress bytes per terminal", () => {
  const term = createTerm();
  assert.equal(accumulateDeferredTerminalWriteAck(term, 10), 10);
  assert.equal(accumulateDeferredTerminalWriteAck(term, 5), 15);
  assert.equal(clearDeferredTerminalWriteAck(term), 15);
  assert.equal(clearDeferredTerminalWriteAck(term), 0);
});