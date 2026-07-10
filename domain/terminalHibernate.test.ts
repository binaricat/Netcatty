import assert from "node:assert/strict";
import test from "node:test";

import {
  capHibernateBuffer,
  capHibernateBufferByLines,
  isTerminalFileTransferActive,
  normalizeHibernateHiddenTabsDelaySec,
  resolveTerminalHibernateDelayMs,
  resolveTerminalHibernateEnabled,
  TERMINAL_HIBERNATE_BUFFER_MAX_CHARS,
  TERMINAL_HIBERNATE_DELAY_SEC_DEFAULT,
  TERMINAL_HIBERNATE_DELAY_SEC_MAX,
  TERMINAL_HIBERNATE_DELAY_SEC_MIN,
} from "./terminalHibernate.ts";

test("capHibernateBuffer trims from the front when over the char limit", () => {
  const input = "a".repeat(TERMINAL_HIBERNATE_BUFFER_MAX_CHARS + 10);
  const capped = capHibernateBuffer(input);
  assert.equal(capped.length, TERMINAL_HIBERNATE_BUFFER_MAX_CHARS);
  assert.equal(capped, "a".repeat(TERMINAL_HIBERNATE_BUFFER_MAX_CHARS));
});

test("capHibernateBufferByLines keeps the most recent lines", () => {
  const input = ["line-1", "line-2", "line-3", "line-4"].join("\n");
  assert.equal(capHibernateBufferByLines(input, 2), "line-3\nline-4");
});

test("resolveTerminalHibernateEnabled defaults to disabled", () => {
  assert.equal(resolveTerminalHibernateEnabled(), false);
  assert.equal(resolveTerminalHibernateEnabled({ hibernateHiddenTabs: true }), true);
  assert.equal(resolveTerminalHibernateEnabled({ hibernateHiddenTabs: false }), false);
});

test("isTerminalFileTransferActive is true when any transfer signal is active", () => {
  assert.equal(
    isTerminalFileTransferActive({ zmodemActive: false, ymodemInProgress: false, isDraggingOver: false }),
    false,
  );
  assert.equal(
    isTerminalFileTransferActive({ zmodemActive: true, ymodemInProgress: false, isDraggingOver: false }),
    true,
  );
  assert.equal(
    isTerminalFileTransferActive({ zmodemActive: false, ymodemInProgress: true, isDraggingOver: false }),
    true,
  );
  assert.equal(
    isTerminalFileTransferActive({ zmodemActive: false, ymodemInProgress: false, isDraggingOver: true }),
    true,
  );
});

test("normalizeHibernateHiddenTabsDelaySec clamps to the allowed range", () => {
  assert.equal(normalizeHibernateHiddenTabsDelaySec(undefined), TERMINAL_HIBERNATE_DELAY_SEC_DEFAULT);
  assert.equal(normalizeHibernateHiddenTabsDelaySec(45), 45);
  assert.equal(normalizeHibernateHiddenTabsDelaySec(1), TERMINAL_HIBERNATE_DELAY_SEC_MIN);
  assert.equal(normalizeHibernateHiddenTabsDelaySec(9999), TERMINAL_HIBERNATE_DELAY_SEC_MAX);
});

test("resolveTerminalHibernateDelayMs converts seconds to milliseconds", () => {
  assert.equal(resolveTerminalHibernateDelayMs(), TERMINAL_HIBERNATE_DELAY_SEC_DEFAULT * 1000);
  assert.equal(resolveTerminalHibernateDelayMs({ hibernateHiddenTabsDelaySec: 10 }), 10_000);
});
