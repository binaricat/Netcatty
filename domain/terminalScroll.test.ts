import assert from "node:assert/strict";
import test from "node:test";

import {
  scrollTerminalToBottomAfterInputIfEnabled,
  scrollTerminalToBottomIfNeeded,
  shouldScrollOnTerminalInput,
} from "./terminalScroll.ts";

const createScrollTarget = (viewportY: number, baseY = 10_000) => {
  let scrollCalls = 0;
  return {
    terminal: {
      buffer: {
        active: {
          baseY,
          viewportY,
        },
      },
      scrollToBottom() {
        scrollCalls += 1;
      },
    },
    get scrollCalls() {
      return scrollCalls;
    },
  };
};

test("does not request another scroll when the terminal is already at the bottom", () => {
  const fixture = createScrollTarget(10_000);

  const didScroll = scrollTerminalToBottomIfNeeded(fixture.terminal);

  assert.equal(didScroll, false);
  assert.equal(fixture.scrollCalls, 0);
});

test("scrolls to the bottom when the user is viewing earlier output", () => {
  const fixture = createScrollTarget(9_900);

  const didScroll = scrollTerminalToBottomIfNeeded(fixture.terminal);

  assert.equal(didScroll, true);
  assert.equal(fixture.scrollCalls, 1);
});

test("printable input does not request another scroll when already at the bottom", () => {
  const fixture = createScrollTarget(10_000);

  const didScroll = scrollTerminalToBottomAfterInputIfEnabled(
    fixture.terminal,
    { scrollOnInput: true },
    "f",
  );

  assert.equal(didScroll, false);
  assert.equal(fixture.scrollCalls, 0);
});

test("printable input still scrolls when the user is viewing earlier output", () => {
  const fixture = createScrollTarget(9_900);

  const didScroll = scrollTerminalToBottomAfterInputIfEnabled(
    fixture.terminal,
    { scrollOnInput: true },
    "f",
  );

  assert.equal(didScroll, true);
  assert.equal(fixture.scrollCalls, 1);
});

test("Ctrl+C scrolls under scrollOnInput when viewing earlier output (#2287)", () => {
  const fixture = createScrollTarget(9_900);

  assert.equal(
    shouldScrollOnTerminalInput({ scrollOnInput: true, scrollOnKeyPress: false }, "\x03"),
    true,
  );

  const didScroll = scrollTerminalToBottomAfterInputIfEnabled(
    fixture.terminal,
    { scrollOnInput: true, scrollOnKeyPress: false },
    "\x03",
  );

  assert.equal(didScroll, true);
  assert.equal(fixture.scrollCalls, 1);
});

test("Ctrl+C still scrolls when only scrollOnKeyPress is enabled", () => {
  const fixture = createScrollTarget(9_900);

  const didScroll = scrollTerminalToBottomAfterInputIfEnabled(
    fixture.terminal,
    { scrollOnInput: false, scrollOnKeyPress: true },
    "\x03",
  );

  assert.equal(didScroll, true);
  assert.equal(fixture.scrollCalls, 1);
});

test("Ctrl+C does not scroll when both input scroll settings are off", () => {
  const fixture = createScrollTarget(9_900);

  assert.equal(
    shouldScrollOnTerminalInput({ scrollOnInput: false, scrollOnKeyPress: false }, "\x03"),
    false,
  );

  const didScroll = scrollTerminalToBottomAfterInputIfEnabled(
    fixture.terminal,
    { scrollOnInput: false, scrollOnKeyPress: false },
    "\x03",
  );

  assert.equal(didScroll, false);
  assert.equal(fixture.scrollCalls, 0);
});

test("non-printable keys still require scrollOnKeyPress", () => {
  assert.equal(
    shouldScrollOnTerminalInput({ scrollOnInput: true, scrollOnKeyPress: false }, "\r"),
    false,
  );
  assert.equal(
    shouldScrollOnTerminalInput({ scrollOnInput: true, scrollOnKeyPress: true }, "\r"),
    true,
  );
});
