import test from "node:test";
import assert from "node:assert/strict";
import type React from "react";

import {
  MIDDLE_MOUSE_BUTTON,
  handleTabMiddleClickClose,
  handleTabMiddleMouseDown,
} from "./tabInteractions.ts";

interface FakeMouseEvent {
  button: number;
  preventDefault: () => void;
  stopPropagation: () => void;
}

const makeEvent = (button: number) => {
  const calls = { preventDefault: 0, stopPropagation: 0 };
  const event = {
    button,
    preventDefault: () => {
      calls.preventDefault++;
    },
    stopPropagation: () => {
      calls.stopPropagation++;
    },
  } satisfies FakeMouseEvent;
  return { event: event as unknown as React.MouseEvent, calls };
};

test("handleTabMiddleClickClose closes the tab on a middle click", () => {
  let closed = 0;
  const { event, calls } = makeEvent(MIDDLE_MOUSE_BUTTON);

  handleTabMiddleClickClose(event, () => {
    closed++;
  });

  assert.equal(closed, 1);
  assert.equal(calls.preventDefault, 1);
  assert.equal(calls.stopPropagation, 1);
});

test("handleTabMiddleClickClose ignores left and right clicks", () => {
  for (const button of [0, 2]) {
    let closed = 0;
    const { event, calls } = makeEvent(button);

    handleTabMiddleClickClose(event, () => {
      closed++;
    });

    assert.equal(closed, 0, `button ${button} must not close the tab`);
    assert.equal(calls.preventDefault, 0);
  }
});

test("handleTabMiddleMouseDown suppresses autoscroll only for the middle button", () => {
  const middle = makeEvent(MIDDLE_MOUSE_BUTTON);
  handleTabMiddleMouseDown(middle.event);
  assert.equal(middle.calls.preventDefault, 1);

  const left = makeEvent(0);
  handleTabMiddleMouseDown(left.event);
  assert.equal(left.calls.preventDefault, 0);
});
