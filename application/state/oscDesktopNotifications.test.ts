import assert from "node:assert/strict";
import test from "node:test";

import {
  handleTerminalOscNotification,
  showOscDesktopNotification,
} from "./oscDesktopNotifications.ts";

const installNotificationBridge = () => {
  const calls: Array<{ title: string; body: string; sessionId?: string }> = [];
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousDocument = (globalThis as { document?: { hasFocus: () => boolean } }).document;

  (globalThis as { document: { hasFocus: () => boolean } }).document = { hasFocus: () => true };
  (globalThis as { window: { netcatty: { showSystemNotification: (payload: { title: string; body: string; sessionId?: string }) => Promise<{ shown: boolean }> } } }).window = {
    netcatty: {
      showSystemNotification: async (payload) => {
        calls.push(payload);
        return { shown: true };
      },
    },
  };

  return {
    calls,
    restore() {
      if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window: unknown }).window = previousWindow;
      if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
      else (globalThis as { document: typeof previousDocument }).document = previousDocument;
    },
  };
};

test("showOscDesktopNotification skips disabled and focused-unfocused modes", () => {
  const fixture = installNotificationBridge();
  try {
    showOscDesktopNotification({
      notification: { title: "", body: "hidden", protocol: "osc9" },
      mode: "off",
      sessionFocused: false,
      sessionId: "s1",
      fallbackTitle: "host",
    });
    showOscDesktopNotification({
      notification: { title: "", body: "quiet", protocol: "osc9" },
      mode: "unfocused",
      sessionFocused: true,
      sessionId: "s1",
      fallbackTitle: "host",
    });
    showOscDesktopNotification({
      notification: { title: "Codex", body: "Turn complete", protocol: "osc9" },
      mode: "always",
      sessionFocused: true,
      sessionId: "s1",
      fallbackTitle: "host",
    });
    assert.deepEqual(fixture.calls, [{
      title: "Codex",
      body: "Turn complete",
      sessionId: "s1",
    }]);
  } finally {
    fixture.restore();
  }
});

test("handleTerminalOscNotification does not mark activity when notifications are off", () => {
  const fixture = installNotificationBridge();
  let activity = 0;
  try {
    assert.equal(handleTerminalOscNotification({
      notification: { title: "", body: "hidden", protocol: "osc9" },
      mode: "off",
      sessionFocused: false,
      sessionId: "s-off",
      fallbackTitle: "host",
      onSessionActivity: () => { activity += 1; },
    }), false);
    assert.equal(activity, 0);
    assert.equal(fixture.calls.length, 0);

    assert.equal(handleTerminalOscNotification({
      notification: { title: "Codex", body: "Turn complete", protocol: "osc9" },
      mode: "always",
      sessionFocused: false,
      sessionId: "s-on",
      fallbackTitle: "host",
      onSessionActivity: () => { activity += 1; },
    }), true);
    assert.equal(activity, 1);
    assert.equal(fixture.calls.length, 1);
  } finally {
    fixture.restore();
  }
});
