import assert from "node:assert/strict";
import test from "node:test";

import {
  scrollTerminalToBottomAfterInputIfEnabled,
  scrollTerminalToBottomIfNeeded,
} from "./terminalScroll.ts";

test("does not request another scroll when the terminal is already at the bottom", () => {
  let scrollCalls = 0;
  const terminal = {
    buffer: {
      active: {
        baseY: 10_000,
        viewportY: 10_000,
      },
    },
    scrollToBottom() {
      scrollCalls += 1;
    },
  };

  const didScroll = scrollTerminalToBottomIfNeeded(terminal);

  assert.equal(didScroll, false);
  assert.equal(scrollCalls, 0);
});

test("scrolls to the bottom when the user is viewing earlier output", () => {
  let scrollCalls = 0;
  const terminal = {
    buffer: {
      active: {
        baseY: 10_000,
        viewportY: 9_900,
      },
    },
    scrollToBottom() {
      scrollCalls += 1;
    },
  };

  const didScroll = scrollTerminalToBottomIfNeeded(terminal);

  assert.equal(didScroll, true);
  assert.equal(scrollCalls, 1);
});

test("printable input does not request another scroll when already at the bottom", () => {
  let scrollCalls = 0;
  const terminal = {
    buffer: {
      active: {
        baseY: 10_000,
        viewportY: 10_000,
      },
    },
    scrollToBottom() {
      scrollCalls += 1;
    },
  };

  const didScroll = scrollTerminalToBottomAfterInputIfEnabled(
    terminal,
    { scrollOnInput: true },
    "f",
  );

  assert.equal(didScroll, false);
  assert.equal(scrollCalls, 0);
});

test("printable input still scrolls when the user is viewing earlier output", () => {
  let scrollCalls = 0;
  const terminal = {
    buffer: {
      active: {
        baseY: 10_000,
        viewportY: 9_900,
      },
    },
    scrollToBottom() {
      scrollCalls += 1;
    },
  };

  const didScroll = scrollTerminalToBottomAfterInputIfEnabled(
    terminal,
    { scrollOnInput: true },
    "f",
  );

  assert.equal(didScroll, true);
  assert.equal(scrollCalls, 1);
});
