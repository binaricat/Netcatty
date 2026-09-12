import { appendComposeBarHistory } from '../../domain/composeBarHistory';

// Session-only memory: survives closing the bar and moving a terminal into a
// workspace, but is discarded when that terminal session is removed.
const histories = new Map<string, { entries: readonly string[] }>();

export function getComposeBarHistory(sessionId: string): readonly string[] {
  return histories.get(sessionId)?.entries ?? [];
}

export function createComposeBarHistoryRecorder(sessionId: string): (command: string) => void {
  let history = histories.get(sessionId);
  if (!history) {
    history = { entries: [] };
    histories.set(sessionId, history);
  }
  const target = history;
  // Capture the session's object before an async send. A late completion after
  // session removal cannot recreate that session's history in the map.
  return (command) => {
    target.entries = appendComposeBarHistory(target.entries, command);
  };
}

export function recordComposeBarHistory(sessionId: string, command: string): void {
  createComposeBarHistoryRecorder(sessionId)(command);
}

export function pruneComposeBarHistory(sessionIds: readonly string[]): void {
  const active = new Set(sessionIds);
  for (const id of histories.keys()) {
    if (!active.has(id)) histories.delete(id);
  }
}
