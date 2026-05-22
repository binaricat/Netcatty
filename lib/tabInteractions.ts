import type React from "react";

/**
 * The DOM `MouseEvent.button` value for the middle mouse button (wheel click).
 * 0 = left/primary, 1 = middle, 2 = right/secondary.
 */
export const MIDDLE_MOUSE_BUTTON = 1;

/**
 * Suppress the Chromium/Electron middle-click autoscroll affordance on a tab.
 * Wire to `onMouseDown`: autoscroll is armed on mousedown, so preventing the
 * default there stops the panning-cursor overlay from appearing when a user
 * middle-clicks a tab to close it (#1044).
 */
export const handleTabMiddleMouseDown = (e: React.MouseEvent): void => {
  if (e.button === MIDDLE_MOUSE_BUTTON) {
    e.preventDefault();
  }
};

/**
 * Close a tab when it is middle-clicked. Wire to `onAuxClick`, which fires for
 * a completed non-primary click. Left clicks (tab activation) and right clicks
 * (context menu) are ignored so existing behavior is untouched.
 */
export const handleTabMiddleClickClose = (
  e: React.MouseEvent,
  close: () => void,
): void => {
  if (e.button !== MIDDLE_MOUSE_BUTTON) return;
  e.preventDefault();
  e.stopPropagation();
  close();
};
