import type { ShellHistoryEntry } from './models';
import {
  isNetcattyAiHistoryCommand,
  isNetcattyManagedStartupHistoryCommand,
} from './remoteHistory';

const makeId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `gh-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

/** True when a typed command should be stored in global (local) shell history. */
export function shouldRecordGlobalHistoryCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  if (isNetcattyAiHistoryCommand(cmd)) return false;
  if (isNetcattyManagedStartupHistoryCommand(cmd)) return false;
  return true;
}

export function sanitizeGlobalHistoryEntries(
  entries: ShellHistoryEntry[],
): ShellHistoryEntry[] {
  return entries.filter((entry) => shouldRecordGlobalHistoryCommand(entry.command));
}

/**
 * Append one command to global history: trim, drop noise, and de-dupe the most
 * recent identical command by bumping its timestamp instead of adding a row.
 */
export function mergeGlobalHistoryOnAppend(
  prev: ShellHistoryEntry[],
  entry: Omit<ShellHistoryEntry, 'id' | 'timestamp'>,
  max = 1000,
): ShellHistoryEntry[] {
  const cmd = entry.command.trim();
  if (!shouldRecordGlobalHistoryCommand(cmd)) return prev;

  const normalized = { ...entry, command: cmd };
  if (prev[0]?.command === cmd) {
    return [
      {
        ...prev[0],
        timestamp: Date.now(),
        hostId: normalized.hostId,
        hostLabel: normalized.hostLabel,
        sessionId: normalized.sessionId,
      },
      ...prev.slice(1),
    ].slice(0, max);
  }

  const newEntry: ShellHistoryEntry = {
    ...normalized,
    id: makeId(),
    timestamp: Date.now(),
  };
  return [newEntry, ...prev].slice(0, max);
}

export interface GlobalHistoryDisplayEntry {
  id: string;
  command: string;
  timestamp: number;
  hostLabel?: string;
}

/** Map persisted shell history rows into a panel-friendly list (newest first). */
export function toGlobalHistoryDisplayEntries(
  entries: ShellHistoryEntry[],
): GlobalHistoryDisplayEntry[] {
  return sanitizeGlobalHistoryEntries(entries).map((entry) => ({
    id: entry.id,
    command: entry.command,
    timestamp: entry.timestamp,
    hostLabel: entry.hostLabel,
  }));
}
