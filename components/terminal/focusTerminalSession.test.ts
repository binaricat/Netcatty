import test from "node:test";
import assert from "node:assert/strict";

import { focusTerminalSessionInput } from "./focusTerminalSession";

test("focusTerminalSessionInput focuses the xterm helper textarea immediately and after scheduled retries", () => {
  const focusCalls: string[] = [];
  const textarea = {
    focus: () => focusCalls.push("focus"),
  };
  const pane = {
    querySelector: (selector: string) => {
      assert.equal(selector, "textarea.xterm-helper-textarea");
      return textarea;
    },
  };
  const queriedSelectors: string[] = [];
  const doc = {
    querySelector: (selector: string) => {
      queriedSelectors.push(selector);
      return pane;
    },
  };
  const timeouts: number[] = [];

  focusTerminalSessionInput("session-1", {
    document: doc,
    requestAnimationFrame: (callback) => {
      callback();
      return 1;
    },
    setTimeout: (callback, delay) => {
      timeouts.push(delay);
      callback();
      return delay;
    },
  });

  assert.deepEqual(queriedSelectors, [
    '[data-session-id="session-1"]',
    '[data-session-id="session-1"]',
  ]);
  assert.deepEqual(timeouts, [50]);
  assert.deepEqual(focusCalls, ["focus", "focus"]);
});

test("focusTerminalSessionInput ignores empty or unavailable targets", () => {
  assert.doesNotThrow(() => {
    focusTerminalSessionInput(null, {
      document: undefined,
      requestAnimationFrame: (callback) => {
        callback();
        return 1;
      },
      setTimeout: (callback, delay) => {
        callback();
        return delay;
      },
    });
  });
});
