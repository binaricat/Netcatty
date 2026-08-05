import type { Terminal as XTerm } from "@xterm/xterm";

import {
  createSyncBlockFilterState,
  filterSyncBlockClearsWithMeta,
  type SyncBlockFilterState,
} from "./filterSyncBlockClears.ts";

/** Matches @xterm/xterm RenderService SYNCHRONIZED_OUTPUT_TIMEOUT_MS. */
export const SYNC_BLOCK_TIMEOUT_MS = 1000;

const syncBlockFilterStates = new WeakMap<XTerm, SyncBlockFilterState>();
const syncBlockTimers = new WeakMap<XTerm, ReturnType<typeof setTimeout>>();

const clearSyncBlockTimer = (term: XTerm): void => {
  const timer = syncBlockTimers.get(term);
  if (timer === undefined) {
    return;
  }
  clearTimeout(timer);
  syncBlockTimers.delete(term);
};

const expireSyncBlock = (term: XTerm, state: SyncBlockFilterState): void => {
  state.inSyncBlock = false;
  state.pendingCursorHome = null;
  state.fullRedrawBlock = null;
  clearSyncBlockTimer(term);
};

export const resetTerminalSyncBlockFilter = (term: XTerm): void => {
  clearSyncBlockTimer(term);
  syncBlockFilterStates.set(term, createSyncBlockFilterState());
};

const getSyncBlockFilterState = (term: XTerm): SyncBlockFilterState => {
  let state = syncBlockFilterStates.get(term);
  if (!state) {
    state = createSyncBlockFilterState();
    syncBlockFilterStates.set(term, state);
  }
  return state;
};

/** True when a prior chunk opened DEC 2026 and has not closed or expired it. */
export const isTerminalSyncBlockOpen = (term: XTerm): boolean =>
  getSyncBlockFilterState(term).inSyncBlock;

const scheduleSyncBlockTimeout = (term: XTerm, state: SyncBlockFilterState): void => {
  if (!state.inSyncBlock) {
    return;
  }

  syncBlockTimers.set(
    term,
    setTimeout(() => {
      syncBlockTimers.delete(term);
      expireSyncBlock(term, state);
    }, SYNC_BLOCK_TIMEOUT_MS),
  );
};

export const filterTerminalSessionData = (term: XTerm, data: string): string => {
  const state = getSyncBlockFilterState(term);
  const { output, startedSyncBlock } = filterSyncBlockClearsWithMeta(data, state, term);

  if (startedSyncBlock) {
    clearSyncBlockTimer(term);
    scheduleSyncBlockTimeout(term, state);
  } else if (!state.inSyncBlock) {
    clearSyncBlockTimer(term);
  }

  return output;
};

/**
 * Force-release pending filter held bytes (split ESC sequences / cursor-home)
 * so hibernate/snapshot drains do not lose output that was retained in filter
 * state after the frame-gate buffer was written (Codex P2 on 741a911e).
 */
export const flushTerminalSyncBlockFilterPending = (term: XTerm): string => {
  const state = getSyncBlockFilterState(term);
  let released = "";
  if (state.pending) {
    released += state.pending;
    state.pending = "";
  }
  if (state.pendingCursorHome) {
    released += state.pendingCursorHome;
    state.pendingCursorHome = null;
  }
  return released;
};
