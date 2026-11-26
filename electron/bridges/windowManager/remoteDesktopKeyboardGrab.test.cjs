"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  attachRemoteDesktopKeyboardGrab,
  hasRemoteDesktopKeyboardGrab,
  setRemoteDesktopKeyboardGrabForWindow,
} = require("./remoteDesktopKeyboardGrab.cjs");

function createFakeWindow() {
  const win = new EventEmitter();
  const wc = new EventEmitter();
  const ignoreCalls = [];
  const sentEvents = [];
  wc.isDestroyed = () => false;
  wc.setIgnoreMenuShortcuts = (flag) => ignoreCalls.push(flag);
  wc.send = (channel, payload) => sentEvents.push({ channel, payload });
  win.webContents = wc;
  win.isDestroyed = () => false;
  return { win, wc, ignoreCalls, sentEvents };
}

describe("attachRemoteDesktopKeyboardGrab", () => {
  it("keeps menu shortcuts ignored on before-input-event while active and auto-resets on lifecycle events", () => {
    const resetEvents = [
      ["window", "blur"],
      ["window", "hide"],
      ["window", "minimize"],
      ["wc", "render-process-gone"],
    ];

    for (const [target, eventName] of resetEvents) {
      const { win, wc, ignoreCalls, sentEvents } = createFakeWindow();
      attachRemoteDesktopKeyboardGrab(win);

      assert.equal(hasRemoteDesktopKeyboardGrab(win), false);
      assert.equal(setRemoteDesktopKeyboardGrabForWindow(win, true), true);
      assert.equal(hasRemoteDesktopKeyboardGrab(win), true);
      assert.equal(ignoreCalls.at(-1), true);

      wc.emit("before-input-event", {}, { type: "keyDown", key: "w", meta: true });
      assert.equal(ignoreCalls.at(-1), true);

      if (target === "window") {
        win.emit(eventName);
      } else {
        wc.emit(eventName, {}, { reason: "crashed" });
      }

      assert.equal(hasRemoteDesktopKeyboardGrab(win), false, `grab must reset on ${eventName}`);
      assert.equal(ignoreCalls.at(-1), false, `setIgnoreMenuShortcuts(false) must run on ${eventName}`);
      assert.deepEqual(sentEvents.at(-1), {
        channel: "netcatty:remote-desktop:keyboard-grab-changed",
        payload: { active: false },
      });
    }
  });

  it("resets on top-level non-in-place did-start-navigation but preserves grab on hash/subframe navigation", () => {
    const { win, wc, ignoreCalls } = createFakeWindow();
    attachRemoteDesktopKeyboardGrab(win);
    setRemoteDesktopKeyboardGrabForWindow(win, true);

    // In-place hash change should NOT clear grab
    wc.emit("did-start-navigation", {}, "app://netcatty/index.html#/terminal-popup", true, true);
    assert.equal(hasRemoteDesktopKeyboardGrab(win), true);

    // Subframe navigation should NOT clear grab
    wc.emit("did-start-navigation", {}, "app://netcatty/sub", false, false);
    assert.equal(hasRemoteDesktopKeyboardGrab(win), true);

    // Main-frame navigation MUST clear grab
    wc.emit("did-start-navigation", {}, "app://netcatty/index.html", false, true);
    assert.equal(hasRemoteDesktopKeyboardGrab(win), false);
    assert.equal(ignoreCalls.at(-1), false);
  });

  it("isolates grab state per window (mainWindow vs terminalPopupWindow)", () => {
    const main = createFakeWindow();
    const popup = createFakeWindow();
    attachRemoteDesktopKeyboardGrab(main.win);
    attachRemoteDesktopKeyboardGrab(popup.win);

    setRemoteDesktopKeyboardGrabForWindow(popup.win, true);
    assert.equal(hasRemoteDesktopKeyboardGrab(main.win), false);
    assert.equal(hasRemoteDesktopKeyboardGrab(popup.win), true);

    main.win.emit("blur");
    assert.equal(hasRemoteDesktopKeyboardGrab(popup.win), true);

    popup.win.emit("blur");
    assert.equal(hasRemoteDesktopKeyboardGrab(popup.win), false);
  });
});
