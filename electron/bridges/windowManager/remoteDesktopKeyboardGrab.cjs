"use strict";

const REMOTE_DESKTOP_KEYBOARD_GRAB = Symbol("netcattyRemoteDesktopKeyboardGrab");
const REMOTE_DESKTOP_KEYBOARD_GRAB_DETACH = Symbol("netcattyRemoteDesktopKeyboardGrabDetach");

function hasRemoteDesktopKeyboardGrab(win) {
  return win?.[REMOTE_DESKTOP_KEYBOARD_GRAB] === true;
}

function setRemoteDesktopKeyboardGrabForWindow(win, active) {
  if (!win || win.isDestroyed?.() || !win.webContents || win.webContents.isDestroyed?.()) {
    return false;
  }
  const enabled = active === true;
  try {
    win[REMOTE_DESKTOP_KEYBOARD_GRAB] = enabled;
    win.webContents.setIgnoreMenuShortcuts?.(enabled);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attach per-window remote desktop keyboard-grab lifecycle guards to any
 * BrowserWindow (both mainWindow and terminalPopupWindow).
 *
 * When grab is active:
 * - `before-input-event` (registered via `prependListener` so it runs before
 *   Cmd+W / Zoom interception in mainWindow.cjs) keeps
 *   `setIgnoreMenuShortcuts(true)`.
 * - On `blur`, `hide`, `minimize`, `render-process-gone`, or
 *   `did-start-navigation`, grab is automatically cleared and
 *   `setIgnoreMenuShortcuts(false)` is restored so host shortcuts never get
 *   stuck.
 */
function attachRemoteDesktopKeyboardGrab(win) {
  if (!win || win.isDestroyed?.() || !win.webContents) {
    return () => {};
  }
  if (typeof win[REMOTE_DESKTOP_KEYBOARD_GRAB_DETACH] === "function") {
    return win[REMOTE_DESKTOP_KEYBOARD_GRAB_DETACH];
  }

  const wc = win.webContents;

  const resetGrab = () => {
    const wasActive = hasRemoteDesktopKeyboardGrab(win);
    win[REMOTE_DESKTOP_KEYBOARD_GRAB] = false;
    try {
      if (!win.isDestroyed?.() && wc && !wc.isDestroyed?.()) {
        wc.setIgnoreMenuShortcuts?.(false);
        if (wasActive) {
          wc.send?.("netcatty:remote-desktop:keyboard-grab-changed", { active: false });
        }
      }
    } catch {
      // Ignore teardown races
    }
  };

  const onDidStartNavigation = (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame === false || isInPlace === true) return;
    resetGrab();
  };

  const onBeforeInputEvent = () => {
    if (!hasRemoteDesktopKeyboardGrab(win)) return;
    try {
      wc.setIgnoreMenuShortcuts?.(true);
    } catch {
      // ignore
    }
  };

  win.on?.("blur", resetGrab);
  win.on?.("hide", resetGrab);
  win.on?.("minimize", resetGrab);
  wc.on?.("render-process-gone", resetGrab);
  wc.on?.("did-start-navigation", onDidStartNavigation);
  if (typeof wc.prependListener === "function") {
    wc.prependListener("before-input-event", onBeforeInputEvent);
  } else {
    wc.on?.("before-input-event", onBeforeInputEvent);
  }

  let detached = false;
  const detach = () => {
    if (detached) return;
    detached = true;
    win[REMOTE_DESKTOP_KEYBOARD_GRAB] = false;
    delete win[REMOTE_DESKTOP_KEYBOARD_GRAB_DETACH];
    try { win.removeListener?.("blur", resetGrab); } catch { /* ignore */ }
    try { win.removeListener?.("hide", resetGrab); } catch { /* ignore */ }
    try { win.removeListener?.("minimize", resetGrab); } catch { /* ignore */ }
    try { wc.removeListener?.("render-process-gone", resetGrab); } catch { /* ignore */ }
    try { wc.removeListener?.("did-start-navigation", onDidStartNavigation); } catch { /* ignore */ }
    try { wc.removeListener?.("before-input-event", onBeforeInputEvent); } catch { /* ignore */ }
  };

  win.once?.("closed", detach);
  win[REMOTE_DESKTOP_KEYBOARD_GRAB_DETACH] = detach;
  return detach;
}

module.exports = {
  attachRemoteDesktopKeyboardGrab,
  hasRemoteDesktopKeyboardGrab,
  setRemoteDesktopKeyboardGrabForWindow,
};
