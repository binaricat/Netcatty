/**
 * SFTP Focused Pane Store
 *
 * Tracks which SFTP pane (left or right) is currently focused.
 * This is used to determine which pane should receive keyboard shortcut actions.
 */

import { createExternalStore } from "../createExternalStore";

export type SftpFocusedSide = "left" | "right";

const store = createExternalStore<SftpFocusedSide>("left");

export const sftpFocusStore = {
  getSnapshot: store.getSnapshot,
  subscribe: store.subscribe,
  setFocusedSide: store.setSnapshot,
  getFocusedSide: store.getSnapshot,
};

/**
 * React hook to subscribe to focused side changes
 */
export const useSftpFocusedSide = (): SftpFocusedSide => store.useStore();
