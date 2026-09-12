import { appendComposeBarHistory } from '../../domain/composeBarHistory';

// Session-only memory: survives closing the bar and moving a terminal into a
// workspace, but is discarded when that terminal session is removed.
const histories = new Map<string, readonly string[]>();

export function getComposeBarHistory(sessionId: string): readonly string[] {
  return histories.get(sessionId) ?? [];
}

export function recordComposeBarHistory(sessionId: string, command: string): void {
  histories.set(sessionId, appendComposeBarHistory(getComposeBarHistory(sessionId), command));
}

export function pruneComposeBarHistory(sessionIds: readonly string[]): void {
  const active = new Set(sessionIds);
  for (const id of histories.keys()) {
    if (!active.has(id)) histories.delete(id);
  }
}
