"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const windowManager = require("../windowManager.cjs");

function windowStub(id) {
  return {
    id,
    isDestroyed: () => false,
    webContents: {
      id,
      isCrashed: () => false,
      isDestroyed: () => false,
    },
  };
}

test("lifecycle-only app windows are excluded from dirty-editor queries", (context) => {
  const editorWindow = windowStub(101);
  const terminalPopup = windowStub(102);
  context.after(() => {
    windowManager.unregisterAppContentWindow(editorWindow);
    windowManager.unregisterAppContentWindow(terminalPopup);
  });

  windowManager.registerAppContentWindow(editorWindow, { queryDirtyEditors: true });
  windowManager.registerAppContentWindow(terminalPopup);

  assert.deepEqual(windowManager.getAppContentWindows(), [editorWindow, terminalPopup]);
  assert.deepEqual(windowManager.getDirtyEditorWindows(), [editorWindow]);
  windowManager.unregisterAppContentWindow(editorWindow);
  assert.deepEqual(windowManager.getAppContentWindows(), [terminalPopup]);
  assert.deepEqual(windowManager.getDirtyEditorWindows(), []);
});

test("opacity applies and synchronizes to detached content windows without broadening other settings", (context) => {
  const main = windowStub(201);
  const detached = windowStub(202);
  const mainOpacity = [];
  const detachedOpacity = [];
  const mainMessages = [];
  const detachedMessages = [];
  main.setOpacity = (value) => mainOpacity.push(value);
  detached.setOpacity = (value) => detachedOpacity.push(value);
  main.webContents.send = (...args) => mainMessages.push(args);
  detached.webContents.send = (...args) => detachedMessages.push(args);
  windowManager.registerMainWindow(main);
  windowManager.registerAppContentWindow(detached);
  context.after(() => {
    windowManager.unregisterMainWindow(main);
    windowManager.unregisterAppContentWindow(detached);
    windowManager.applyWindowOpacity(1);
  });
  const handlers = new Map();
  windowManager.registerWindowHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, handler) => handlers.set(channel, handler),
  }, {});

  handlers.get("netcatty:setWindowOpacity")({ sender: detached.webContents }, 0.6);
  assert.deepEqual(mainOpacity, [0.6]);
  assert.deepEqual(detachedOpacity, [0.6]);
  const opacity = {
    key: "netcatty_window_opacity_v1",
    value: { opacity: 1, version: 2, preferredOpacity: 0.6 },
  };
  const broadcast = handlers.get("netcatty:settings:changed");
  broadcast({ sender: detached.webContents }, opacity);
  assert.deepEqual(mainMessages, [["netcatty:settings:changed", opacity]]);
  assert.deepEqual(detachedMessages, []);
  broadcast({ sender: main.webContents }, opacity);
  assert.deepEqual(detachedMessages, [["netcatty:settings:changed", opacity]]);
  broadcast({ sender: main.webContents }, { key: "netcatty_show_tray_icon_v1", value: true });
  assert.equal(detachedMessages.length, 1);
});

test("a closing settings recipient does not interrupt delivery to later windows", (context) => {
  delete require.cache[require.resolve("../windowManager.cjs")];
  const windowManager = require("../windowManager.cjs");
  const closing = windowStub(301);
  const main = windowStub(302);
  const detached = windowStub(303);
  const mainMessages = [];
  const detachedMessages = [];
  closing.webContents.send = () => { throw new Error("renderer closed during send"); };
  main.webContents.send = (...args) => mainMessages.push(args);
  detached.webContents.send = (...args) => detachedMessages.push(args);
  windowManager.registerMainWindow(closing);
  windowManager.registerMainWindow(main);
  windowManager.registerAppContentWindow(detached);
  context.after(() => {
    windowManager.unregisterMainWindow(closing);
    windowManager.unregisterMainWindow(main);
    windowManager.unregisterAppContentWindow(detached);
  });
  const handlers = new Map();
  windowManager.registerWindowHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, handler) => handlers.set(channel, handler),
  }, {});
  const broadcast = handlers.get("netcatty:settings:changed");
  const opacity = { key: "netcatty_window_opacity_v1", value: { opacity: 0.6, version: 1 } };
  const recording = { key: "netcatty_hotkey_recording_v1", value: true };
  broadcast({ sender: { id: 0 } }, opacity);
  broadcast({ sender: { id: 0 } }, recording);
  assert.deepEqual(mainMessages, [
    ["netcatty:settings:changed", opacity],
    ["netcatty:settings:changed", recording],
  ]);
  assert.deepEqual(detachedMessages, [
    ["netcatty:settings:changed", opacity],
    ["netcatty:settings:changed", recording],
  ]);
});

test("detached windows receive live hotkey scheme and binding changes", (context) => {
  delete require.cache[require.resolve("../windowManager.cjs")];
  const windowManager = require("../windowManager.cjs");
  const detached = windowStub(401);
  const messages = [];
  detached.webContents.send = (...args) => messages.push(args);
  windowManager.registerAppContentWindow(detached);
  context.after(() => windowManager.unregisterAppContentWindow(detached));
  const handlers = new Map();
  windowManager.registerWindowHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, handler) => handlers.set(channel, handler),
  }, {});
  const payloads = [
    { key: "netcatty_hotkey_scheme_v1", value: "disabled" },
    { key: "netcatty_custom_key_bindings_v1", value: { bindings: { "toggle-opacity": { mac: "Cmd + Shift + U" } }, version: 1, origin: "settings" } },
  ];
  for (const payload of payloads) {
    handlers.get("netcatty:settings:changed")({ sender: { id: 0 } }, payload);
  }
  assert.deepEqual(messages, payloads.map((payload) => ["netcatty:settings:changed", payload]));
});
