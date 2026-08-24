"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  sanitizeNotificationText,
  showSystemNotification,
  registerSystemNotificationHandlers,
} = require("./systemNotification.cjs");

test("sanitizeNotificationText strips controls and truncates", () => {
  assert.equal(sanitizeNotificationText("hello\u0007world", 20), "helloworld");
  assert.equal(sanitizeNotificationText("abcdefghij", 6), "abcde…");
  assert.equal(sanitizeNotificationText(null, 10), "");
});

test("showSystemNotification focuses the sender window and session on click", () => {
  const sent = [];
  let clickHandler;
  function FakeNotification(payload) {
    this.payload = payload;
  }
  FakeNotification.isSupported = () => true;
  FakeNotification.prototype.on = function on(event, handler) {
    if (event === "click") clickHandler = handler;
  };
  FakeNotification.prototype.show = function show() {};

  const win = {
    destroyed: false,
    minimized: true,
    isDestroyed() { return this.destroyed; },
    isMinimized() { return this.minimized; },
    restore() { this.minimized = false; this.restored = true; },
    show() { this.shown = true; },
    focus() { this.focused = true; },
  };
  const sender = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    send(channel, sessionId) { sent.push([channel, sessionId]); },
  };

  const result = showSystemNotification({
    Notification: FakeNotification,
    BrowserWindow: { fromWebContents: () => win },
    sender,
    title: "Codex",
    body: "Turn complete",
    sessionId: "session-1",
  });

  assert.deepEqual(result, { shown: true });
  clickHandler();
  assert.equal(win.restored, true);
  assert.equal(win.shown, true);
  assert.equal(win.focused, true);
  assert.deepEqual(sent, [["netcatty:tray:focusSession", "session-1"]]);
});

test("showSystemNotification reports unsupported platforms", () => {
  function FakeNotification() {}
  FakeNotification.isSupported = () => false;
  assert.deepEqual(
    showSystemNotification({
      Notification: FakeNotification,
      title: "x",
      body: "y",
    }),
    { shown: false, reason: "unsupported" },
  );
});

test("registerSystemNotificationHandlers exposes the IPC channel", async () => {
  const handlers = new Map();
  const shown = [];
  function FakeNotification(payload) {
    shown.push(payload);
  }
  FakeNotification.isSupported = () => true;
  FakeNotification.prototype.on = () => {};
  FakeNotification.prototype.show = () => {};

  registerSystemNotificationHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, {
    electronModule: { Notification: FakeNotification },
    BrowserWindow: { fromWebContents: () => null },
  });

  const result = await handlers.get("netcatty:notification:show")(
    { sender: { isDestroyed: () => false, send() {} } },
    { title: "Codex", body: "Turn complete", sessionId: "s1" },
  );
  assert.deepEqual(result, { shown: true });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, "Codex");
  assert.equal(shown[0].body, "Turn complete");
});
