import assert from "node:assert/strict";
import test from "node:test";

import {
  isMiddleClickContextMenuEvent,
  isShiftSelectionReplayMouseEvent,
  markMiddleClickContextMenuEvent,
  markShiftSelectionReplayMouseEvent,
  captureMiddleClickTerminalMouseEvent,
  resolveMiddleClickBehavior,
  shouldInterceptMouseTrackingContextMenu,
  shouldReplayShiftMouseSelectionAsMacOption,
  shouldStopShiftRightClickMouseTrackingMouseDown,
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

test("mouse-tracking context menu capture lets Shift-modified mouse events pass through", () => {
  assert.equal(
    shouldInterceptMouseTrackingContextMenu({
      event: { shiftKey: true } as MouseEvent,
      mouseTracking: true,
      status: "connected",
    }),
    false,
  );
});

test("Shift selection replay events are identifiable", () => {
  const event = {} as MouseEvent;

  assert.equal(isShiftSelectionReplayMouseEvent(event), false);
  assert.equal(isShiftSelectionReplayMouseEvent(markShiftSelectionReplayMouseEvent(event)), true);
});

test("macOS mouse tracking replays plain Shift left-click as xterm option selection", () => {
  const event = {
    button: 0,
    shiftKey: true,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  } as MouseEvent;

  assert.equal(
    shouldReplayShiftMouseSelectionAsMacOption({
      event,
      mouseTracking: true,
      status: "connected",
      isMacPlatform: true,
    }),
    true,
  );
});

test("Shift selection replay is limited to the macOS connected mouse-tracking case", () => {
  const baseEvent = {
    button: 0,
    shiftKey: true,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  } as MouseEvent;

  assert.equal(
    shouldReplayShiftMouseSelectionAsMacOption({
      event: baseEvent,
      mouseTracking: true,
      status: "connected",
      isMacPlatform: false,
    }),
    false,
  );
  assert.equal(
    shouldReplayShiftMouseSelectionAsMacOption({
      event: baseEvent,
      mouseTracking: false,
      status: "connected",
      isMacPlatform: true,
    }),
    false,
  );
  assert.equal(
    shouldReplayShiftMouseSelectionAsMacOption({
      event: baseEvent,
      mouseTracking: true,
      status: "disconnected",
      isMacPlatform: true,
    }),
    false,
  );
  assert.equal(
    shouldReplayShiftMouseSelectionAsMacOption({
      event: { ...baseEvent, button: 2 } as MouseEvent,
      mouseTracking: true,
      status: "connected",
      isMacPlatform: true,
    }),
    false,
  );
  assert.equal(
    shouldReplayShiftMouseSelectionAsMacOption({
      event: { ...baseEvent, shiftKey: false } as MouseEvent,
      mouseTracking: true,
      status: "connected",
      isMacPlatform: true,
    }),
    false,
  );
});

test("Shift selection replay ignores modified and already replayed mouse events", () => {
  const baseEvent = {
    button: 0,
    shiftKey: true,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  } as MouseEvent;

  for (const event of [
    { ...baseEvent, altKey: true },
    { ...baseEvent, ctrlKey: true },
    { ...baseEvent, metaKey: true },
    markShiftSelectionReplayMouseEvent({ ...baseEvent } as MouseEvent),
  ]) {
    assert.equal(
      shouldReplayShiftMouseSelectionAsMacOption({
        event: event as MouseEvent,
        mouseTracking: true,
        status: "connected",
        isMacPlatform: true,
      }),
      false,
    );
  }
});

test("Shift right-click mousedown is stopped while connected mouse tracking is active", () => {
  assert.equal(
    shouldStopShiftRightClickMouseTrackingMouseDown({
      event: {
        button: 2,
        shiftKey: true,
      } as MouseEvent,
      mouseTracking: true,
      status: "connected",
    }),
    true,
  );
});

test("Shift right-click mousedown capture is limited to connected mouse tracking", () => {
  const baseEvent = {
    button: 2,
    shiftKey: true,
  } as MouseEvent;

  assert.equal(
    shouldStopShiftRightClickMouseTrackingMouseDown({
      event: baseEvent,
      mouseTracking: false,
      status: "connected",
    }),
    false,
  );
  assert.equal(
    shouldStopShiftRightClickMouseTrackingMouseDown({
      event: baseEvent,
      mouseTracking: true,
      status: "disconnected",
    }),
    false,
  );
  assert.equal(
    shouldStopShiftRightClickMouseTrackingMouseDown({
      event: {
        button: 2,
        shiftKey: false,
      } as MouseEvent,
      mouseTracking: true,
      status: "connected",
    }),
    false,
  );
  assert.equal(
    shouldStopShiftRightClickMouseTrackingMouseDown({
      event: {
        button: 0,
        shiftKey: true,
      } as MouseEvent,
      mouseTracking: true,
      status: "connected",
    }),
    false,
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
