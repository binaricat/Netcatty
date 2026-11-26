export const DEFAULT_SFTP_NAV_HISTORY_MAX_ENTRIES = 50;

export interface SftpNavHistory {
  readonly entries: readonly string[];
  /** Current position in `entries`, or -1 when `entries` is empty. */
  readonly index: number;
  readonly maxEntries: number;
}

export interface SftpNavHistoryStep {
  readonly history: SftpNavHistory;
  readonly path: string | null;
}

export type SftpNavHistoryTransitionMode = "push" | "back" | "forward" | "none";

export interface PendingSftpNavHistoryTransition {
  readonly connectionId: string;
  readonly path: string;
  readonly mode: SftpNavHistoryTransitionMode;
}

export type SftpNavPathComparator = (a: string, b: string) => boolean;

const defaultIsSamePath: SftpNavPathComparator = (a, b) => a === b;

function normalizeMaxEntries(maxEntries?: number): number {
  if (typeof maxEntries !== "number" || !Number.isFinite(maxEntries) || maxEntries < 1) {
    return DEFAULT_SFTP_NAV_HISTORY_MAX_ENTRIES;
  }
  return Math.floor(maxEntries);
}

export function createNavHistory(
  initialPath?: string | null,
  maxEntries: number = DEFAULT_SFTP_NAV_HISTORY_MAX_ENTRIES,
): SftpNavHistory {
  const limit = normalizeMaxEntries(maxEntries);
  if (typeof initialPath === "string" && initialPath.length > 0) {
    return {
      entries: [initialPath],
      index: 0,
      maxEntries: limit,
    };
  }
  return {
    entries: [],
    index: -1,
    maxEntries: limit,
  };
}

export function resetNavHistory(
  path?: string | null,
  maxEntries: number = DEFAULT_SFTP_NAV_HISTORY_MAX_ENTRIES,
): SftpNavHistory {
  return createNavHistory(path, maxEntries);
}

export function getCurrentNavPath(history: SftpNavHistory): string | null {
  if (history.index < 0 || history.index >= history.entries.length) {
    return null;
  }
  return history.entries[history.index] ?? null;
}

export function canGoBack(history: SftpNavHistory): boolean {
  return history.index > 0 && history.entries.length > 1;
}

export function canGoForward(history: SftpNavHistory): boolean {
  return history.index >= 0 && history.index < history.entries.length - 1;
}

export function peekBackPath(history: SftpNavHistory): string | null {
  if (!canGoBack(history)) {
    return null;
  }
  return history.entries[history.index - 1] ?? null;
}

export function peekForwardPath(history: SftpNavHistory): string | null {
  if (!canGoForward(history)) {
    return null;
  }
  return history.entries[history.index + 1] ?? null;
}

export function pushNavHistory(
  history: SftpNavHistory,
  path: string,
  isSamePath: SftpNavPathComparator = defaultIsSamePath,
): SftpNavHistory {
  if (!path) {
    return history;
  }
  const current = getCurrentNavPath(history);
  if (current !== null && isSamePath(current, path)) {
    return history;
  }

  const limit = normalizeMaxEntries(history.maxEntries);
  const base = history.index >= 0
    ? history.entries.slice(0, history.index + 1)
    : [];
  let nextEntries = [...base, path];
  if (nextEntries.length > limit) {
    nextEntries = nextEntries.slice(nextEntries.length - limit);
  }
  return {
    entries: nextEntries,
    index: nextEntries.length - 1,
    maxEntries: limit,
  };
}

export function goBack(history: SftpNavHistory): SftpNavHistoryStep {
  const path = peekBackPath(history);
  if (path === null) {
    return { history, path: null };
  }
  return {
    history: {
      ...history,
      index: history.index - 1,
    },
    path,
  };
}

export function goForward(history: SftpNavHistory): SftpNavHistoryStep {
  const path = peekForwardPath(history);
  if (path === null) {
    return { history, path: null };
  }
  return {
    history: {
      ...history,
      index: history.index + 1,
    },
    path,
  };
}

export function applySftpNavHistoryTransition(params: {
  history?: SftpNavHistory;
  currentPath?: string | null;
  targetPath: string;
  mode: SftpNavHistoryTransitionMode;
  isSamePath?: SftpNavPathComparator;
}): SftpNavHistory {
  const compare = params.isSamePath ?? defaultIsSamePath;
  const base = params.history && params.history.entries.length > 0
    ? params.history
    : createNavHistory(params.currentPath);

  if (params.mode === "none") {
    if (base.entries.length === 0 && params.targetPath) {
      return createNavHistory(params.targetPath, base.maxEntries);
    }
    return base;
  }

  if (params.mode === "back") {
    const step = goBack(base);
    if (step.path !== null && compare(step.path, params.targetPath)) {
      return step.history;
    }
    const current = getCurrentNavPath(base);
    if (current !== null && compare(current, params.targetPath)) {
      return base;
    }
    return pushNavHistory(base, params.targetPath, compare);
  }

  if (params.mode === "forward") {
    const step = goForward(base);
    if (step.path !== null && compare(step.path, params.targetPath)) {
      return step.history;
    }
    const current = getCurrentNavPath(base);
    if (current !== null && compare(current, params.targetPath)) {
      return base;
    }
    return pushNavHistory(base, params.targetPath, compare);
  }

  return pushNavHistory(base, params.targetPath, compare);
}

export function resolveSftpEffectiveNavHistoryMode(params: {
  requestedMode: SftpNavHistoryTransitionMode;
  pending?: PendingSftpNavHistoryTransition;
  connectionId: string;
  targetPath: string;
  isSamePath?: SftpNavPathComparator;
}): SftpNavHistoryTransitionMode {
  if (params.requestedMode !== "none") {
    return params.requestedMode;
  }
  const compare = params.isSamePath ?? defaultIsSamePath;
  if (
    params.pending
    && params.pending.connectionId === params.connectionId
    && compare(params.pending.path, params.targetPath)
  ) {
    return params.pending.mode;
  }
  return "none";
}

export function resolveSftpConnectNavHistory(params: {
  sameEndpointReconnect: boolean;
  previousHistory?: SftpNavHistory;
  startPath: string;
  isSamePath?: SftpNavPathComparator;
}): SftpNavHistory {
  const compare = params.isSamePath ?? defaultIsSamePath;
  if (
    params.sameEndpointReconnect
    && params.previousHistory
    && params.previousHistory.entries.length > 0
  ) {
    const current = getCurrentNavPath(params.previousHistory);
    if (current !== null && compare(current, params.startPath)) {
      return params.previousHistory;
    }
    return pushNavHistory(params.previousHistory, params.startPath, compare);
  }
  return resetNavHistory(params.startPath);
}
