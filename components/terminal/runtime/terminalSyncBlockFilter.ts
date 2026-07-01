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
