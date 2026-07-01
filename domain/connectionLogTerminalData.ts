import type { ConnectionLog } from "./models.ts";

/** Max unsaved connection logs whose terminal replay data we persist separately. */
export const MAX_PERSISTED_UNSAVED_TERMINAL_DATA_ENTRIES = 50;

export type ConnectionLogTerminalDataMap = Record<string, string>;

export const readTerminalDataFromLog = (log: ConnectionLog): string | undefined =>
  log.terminalData;

export const mergeTerminalDataIntoLogs = (
  logs: ConnectionLog[],
  terminalDataMap: ConnectionLogTerminalDataMap,
): ConnectionLog[] => {
  if (logs.length === 0) return logs;

  let changed = false;
  const next = logs.map((log) => {
    if (log.terminalData) return log;
    const sideData = terminalDataMap[log.id];
    if (!sideData) return log;
    changed = true;
    return { ...log, terminalData: sideData };
  });
  return changed ? next : logs;
};

/**
 * When another window or a pruned localStorage write reloads connection logs,
 * keep in-memory / side-store terminal replay data instead of wiping it.
 */
export const mergeConnectionLogsFromStorage = (
  prev: ConnectionLog[],
  next: ConnectionLog[],
  terminalDataMap: ConnectionLogTerminalDataMap,
): ConnectionLog[] => {
  if (next.length === 0) return next;

  const prevById = new Map(prev.map((log) => [log.id, log]));
  let changed = false;
  const merged = next.map((log) => {
    const memoryData = readTerminalDataFromLog(prevById.get(log.id) ?? log);
    const sideData = terminalDataMap[log.id];
    const terminalData = memoryData ?? readTerminalDataFromLog(log) ?? sideData;
    if (!terminalData || log.terminalData === terminalData) return log;
    changed = true;
    return { ...log, terminalData };
  });
  return changed ? merged : next;
};

export const buildTerminalDataMapFromLogs = (
  logs: ConnectionLog[],
): ConnectionLogTerminalDataMap => {
  const map: ConnectionLogTerminalDataMap = {};
  for (const log of logs) {
    const data = readTerminalDataFromLog(log);
    if (data) map[log.id] = data;
  }
  return map;
};

/**
 * Keep only unsaved logs' terminal data, capped to the most recent entries.
 * Saved logs keep terminalData in the main connection log blob when bookmarked.
 */
export const pruneTerminalDataMapForStorage = (
  logs: ConnectionLog[],
  map: ConnectionLogTerminalDataMap,
): ConnectionLogTerminalDataMap => {
  const unsavedIds = logs
    .filter((log) => !log.saved)
    .sort((a, b) => b.startTime - a.startTime)
    .slice(0, MAX_PERSISTED_UNSAVED_TERMINAL_DATA_ENTRIES)
    .map((log) => log.id);

  const allowed = new Set(unsavedIds);
  for (const log of logs) {
    if (log.saved && map[log.id]) {
      allowed.add(log.id);
    }
  }

  const next: ConnectionLogTerminalDataMap = {};
  for (const id of allowed) {
    if (map[id]) next[id] = map[id];
  }
  return next;
};

/** Fold side-store maps together, then cap to the allowed unsaved/saved set. */
export const mergeTerminalDataMapsForStorage = (
  logs: ConnectionLog[],
  persistedSnapshot: ConnectionLogTerminalDataMap,
  localMaps: ConnectionLogTerminalDataMap[],
  persistedLogIds: ReadonlySet<string>,
): ConnectionLogTerminalDataMap => {
  const combined: ConnectionLogTerminalDataMap = { ...persistedSnapshot };
  for (const map of localMaps) {
    for (const [id, data] of Object.entries(map)) {
      if (data) combined[id] = data;
    }
  }
  const pruned = pruneTerminalDataMapForStorage(logs, combined);

  // Retain replay buffers only for log ids still present in the persisted
  // connection-log blob but not yet loaded into this window's React state.
  for (const id of persistedLogIds) {
    if (!logs.some((log) => log.id === id) && combined[id]) {
      pruned[id] = combined[id];
    }
  }

  return pruned;
};
