import assert from "node:assert/strict";
import test from "node:test";

import {
  isMiddleClickContextMenuEvent,
  markMiddleClickContextMenuEvent,
  captureMiddleClickTerminalMouseEvent,
  resolveMiddleClickBehavior,
  shouldInterceptMouseTrackingContextMenu,
} from "./middleClickBehavior";

test("resolveMiddleClickBehavior uses the explicit middle-click behavior", () => {
  assert.equal(resolveMiddleClickBehavior({ middleClickBehavior: "context-menu" }), "context-menu");
  assert.equal(resolveMiddleClickBehavior({ middleClickBehavior: "disabled" }), "disabled");
});

test("resolveMiddleClickBehavior ignores unsupported middle-click behavior values", () => {
  assert.equal(
    resolveMiddleClickBehavior({ middleClickBehavior: "select-word" as never }),
    "paste",
  );
});

test("resolveMiddleClickBehavior falls back to the legacy middle-click paste flag", () => {
  assert.equal(resolveMiddleClickBehavior({ middleClickPaste: true }), "paste");
  assert.equal(resolveMiddleClickBehavior({ middleClickPaste: false }), "disabled");
  assert.equal(resolveMiddleClickBehavior(undefined), "paste");
});

test("middle-click context menu events are identifiable", () => {
  const event = {} as MouseEvent;

  assert.equal(isMiddleClickContextMenuEvent(event), false);
  assert.equal(isMiddleClickContextMenuEvent(markMiddleClickContextMenuEvent(event)), true);
});

test("mouse-tracking context menu capture lets middle-click menu events pass through", () => {
  assert.equal(
    shouldInterceptMouseTrackingContextMenu({
      event: markMiddleClickContextMenuEvent({} as MouseEvent),
      mouseTracking: true,
      status: "connected",
    }),
    false,
  );
  assert.equal(
    shouldInterceptMouseTrackingContextMenu({
      event: {} as MouseEvent,
      mouseTracking: true,
      status: "connected",
    }),
    true,
  );
});

test("middle-click terminal mouse down/up events are captured before xterm sees them", () => {
  const calls: string[] = [];
  const middleClickEvent = {
    button: 1,
    preventDefault: () => calls.push("preventDefault"),
    stopImmediatePropagation: () => calls.push("stopImmediatePropagation"),
  } as unknown as MouseEvent;

  assert.equal(captureMiddleClickTerminalMouseEvent(middleClickEvent), true);
  assert.deepEqual(calls, ["preventDefault", "stopImmediatePropagation"]);

  calls.length = 0;
  assert.equal(captureMiddleClickTerminalMouseEvent({
    button: 0,
    preventDefault: () => calls.push("preventDefault"),
    stopImmediatePropagation: () => calls.push("stopImmediatePropagation"),
  } as unknown as MouseEvent), false);
  assert.deepEqual(calls, []);
});
