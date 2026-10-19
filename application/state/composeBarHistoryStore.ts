import { appendComposeBarHistory } from '../../domain/composeBarHistory';
import { subscribeCommandHistoryCleared } from './commandHistoryStore';

// Session-only memory: survives closing the bar and moving a terminal into a
// workspace, but is discarded when that terminal session is removed.
type PendingSend = { settled: boolean; command?: string };
const histories = new Map<string, { entries: readonly string[]; pending: PendingSend[] }>();

type Listener = () => void;
const clearedListeners = new Set<Listener>();

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

/**
 * Subscribe to full compose-bar history clears. A live compose bar uses this to
 * drop the history walk it cached, so ArrowUp cannot recall deleted commands.
 */
export function subscribeComposeBarHistoryCleared(listener: Listener): () => void {
  clearedListeners.add(listener);
  return () => {
    clearedListeners.delete(listener);
  };
}

/**
 * Clear the in-memory compose-bar history for every session.
 *
 * This store is session-only (never persisted), so the "clear all command
 * history" action must clear it explicitly. Otherwise a command sent through
 * the compose bar stays recallable, and resending it would re-record it into
 * shell history and autocomplete after the user deleted it.
 */
export function clearComposeBarHistory(): void {
  histories.clear();
  // Always notify: a live compose bar can still hold a cached walk even when
  // the map is already empty (for example after its session was pruned).
  for (const listener of [...clearedListeners]) listener();
}

// The compose bar holds the most recent commands sent through it, so clearing
// command history must drop it too. Subscribing to the command-history clear
// event covers every renderer: a detached terminal popup renders its own
// TerminalComposeBar and learns about a main-window clear through the shared
// clear generation, while the main window is notified synchronously.
subscribeCommandHistoryCleared(clearComposeBarHistory);
