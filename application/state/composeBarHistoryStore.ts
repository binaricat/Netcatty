import { appendComposeBarHistory } from '../../domain/composeBarHistory';

// Session-only memory: survives closing the bar and moving a terminal into a
// workspace, but is discarded when that terminal session is removed.
type PendingSend = { settled: boolean; command?: string };
const histories = new Map<string, { entries: readonly string[]; pending: PendingSend[] }>();

export function getComposeBarHistory(sessionId: string): readonly string[] {
  return histories.get(sessionId)?.entries ?? [];
}

export function createComposeBarHistoryRecorder(sessionId: string): (command?: string) => void {
  let history = histories.get(sessionId);
  if (!history) {
    history = { entries: [], pending: [] };
    histories.set(sessionId, history);
  }
  const target = history;
  const submission: PendingSend = { settled: false };
  target.pending.push(submission);
  // Capture the session's object before an async send. A late completion after
  // session removal cannot recreate that session's history in the map.
  return (command) => {
    if (submission.settled) return;
    submission.settled = true;
    submission.command = command;
    // Settle failures too, so they cannot block later successful submissions.
    while (target.pending[0]?.settled) {
      const next = target.pending.shift()!;
      if (next.command !== undefined) {
        target.entries = appendComposeBarHistory(target.entries, next.command);
      }
    }
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
