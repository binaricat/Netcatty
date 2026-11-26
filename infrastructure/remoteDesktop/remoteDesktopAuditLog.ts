import {
  sanitizeRemoteDesktopActionsForAudit,
  type RemoteDesktopAction,
} from '../../domain/remoteDesktopActionCodec';
import { STORAGE_KEY_REMOTE_DESKTOP_AI_AUDIT } from '../config/storageKeys';
import { localStorageAdapter } from '../persistence/localStorageAdapter';

export const MAX_REMOTE_DESKTOP_AUDIT_ENTRIES = 500;

export type RemoteDesktopAuditOutcome =
  | 'ok'
  | 'error'
  | 'preempted'
  | 'denied'
  | 'blocked';

export interface RemoteDesktopAuditEntry {
  id: string;
  timestamp: number;
  sessionId: string;
  chatSessionId?: string;
  protocol?: 'vnc' | 'rdp';
  hostLabel?: string;
  hostname?: string;
  actionCount: number;
  completedActions: number;
  summary: string;
  actions: RemoteDesktopAction[];
  highRiskChords?: string[];
  outcome: RemoteDesktopAuditOutcome;
  errorCode?: string;
  error?: string;
  durationMs?: number;
  captureId?: string;
}

export type AppendRemoteDesktopAuditEntryInput = Omit<
  RemoteDesktopAuditEntry,
  'id' | 'timestamp'
> & {
  id?: string;
  timestamp?: number;
};

let auditEntries: RemoteDesktopAuditEntry[] | null = null;
let auditSeq = 0;
const listeners = new Set<() => void>();

function hasLocalStorage(): boolean {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return Boolean(storage && typeof storage.getItem === 'function');
  } catch {
    return false;
  }
}

function nextAuditId(): string {
  auditSeq += 1;
  return `rdaudit-${Date.now().toString(36)}-${auditSeq}`;
}

function isValidStoredEntry(value: unknown): value is RemoteDesktopAuditEntry {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.id === 'string'
    && typeof rec.timestamp === 'number'
    && Number.isFinite(rec.timestamp)
    && typeof rec.sessionId === 'string'
    && typeof rec.summary === 'string'
    && typeof rec.actionCount === 'number'
    && typeof rec.completedActions === 'number'
    && typeof rec.outcome === 'string'
    && Array.isArray(rec.actions)
  );
}

function loadEntries(): RemoteDesktopAuditEntry[] {
  if (auditEntries !== null) return auditEntries;
  if (!hasLocalStorage()) {
    auditEntries = [];
    return auditEntries;
  }
  const raw = localStorageAdapter.read<unknown>(STORAGE_KEY_REMOTE_DESKTOP_AI_AUDIT);
  if (!Array.isArray(raw)) {
    auditEntries = [];
    return auditEntries;
  }
  const valid = raw.filter(isValidStoredEntry);
  auditEntries = valid.slice(-MAX_REMOTE_DESKTOP_AUDIT_ENTRIES);
  return auditEntries;
}

function persistEntries(entries: RemoteDesktopAuditEntry[]): void {
  if (!hasLocalStorage()) return;
  try {
    localStorageAdapter.write(STORAGE_KEY_REMOTE_DESKTOP_AI_AUDIT, entries);
  } catch {
    // Never let storage errors disrupt remote desktop control.
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Ignore UI subscriber errors.
    }
  }
}

/**
 * Append a Computer Use action batch audit entry into the bounded 500-entry
 * ring buffer and persist to localStorage.
 */
export function appendRemoteDesktopAuditEntry(
  input: AppendRemoteDesktopAuditEntryInput,
): RemoteDesktopAuditEntry {
  const entries = loadEntries();
  const entry: RemoteDesktopAuditEntry = {
    id: input.id || nextAuditId(),
    timestamp: typeof input.timestamp === 'number' && Number.isFinite(input.timestamp)
      ? input.timestamp
      : Date.now(),
    sessionId: input.sessionId,
    ...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
    ...(input.protocol ? { protocol: input.protocol } : {}),
    ...(input.hostLabel ? { hostLabel: input.hostLabel } : {}),
    ...(input.hostname ? { hostname: input.hostname } : {}),
    actionCount: Math.max(0, Math.round(input.actionCount)),
    completedActions: Math.max(0, Math.round(input.completedActions)),
    summary: input.summary,
    actions: sanitizeRemoteDesktopActionsForAudit(input.actions),
    ...(input.highRiskChords && input.highRiskChords.length > 0
      ? { highRiskChords: [...input.highRiskChords] }
      : {}),
    outcome: input.outcome,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
      ? { durationMs: Math.max(0, Math.round(input.durationMs)) }
      : {}),
    ...(input.captureId ? { captureId: input.captureId } : {}),
  };

  entries.push(entry);
  if (entries.length > MAX_REMOTE_DESKTOP_AUDIT_ENTRIES) {
    entries.splice(0, entries.length - MAX_REMOTE_DESKTOP_AUDIT_ENTRIES);
  }
  persistEntries(entries);
  notifyListeners();
  return entry;
}

/**
 * List audit entries (newest first), optionally filtered to a single remote desktop session.
 */
export function listRemoteDesktopAuditEntries(sessionId?: string): RemoteDesktopAuditEntry[] {
  const entries = loadEntries();
  const filtered = sessionId
    ? entries.filter((entry) => entry.sessionId === sessionId)
    : entries;
  return [...filtered].reverse();
}

/**
 * Clear audit entries (for one session if `sessionId` is provided, or all entries).
 * Returns the number of entries removed.
 */
export function clearRemoteDesktopAuditEntries(sessionId?: string): number {
  const entries = loadEntries();
  if (!sessionId) {
    const removed = entries.length;
    if (removed === 0) return 0;
    auditEntries = [];
    if (hasLocalStorage()) {
      try {
        localStorageAdapter.remove(STORAGE_KEY_REMOTE_DESKTOP_AI_AUDIT);
      } catch {
        // Ignore storage removal errors.
      }
    }
    notifyListeners();
    return removed;
  }

  const next = entries.filter((entry) => entry.sessionId !== sessionId);
  const removed = entries.length - next.length;
  if (removed === 0) return 0;
  auditEntries = next;
  persistEntries(next);
  notifyListeners();
  return removed;
}

/**
 * Export audit entries (newest first) as formatted JSON.
 */
export function exportRemoteDesktopAuditJson(sessionId?: string): string {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    ...(sessionId ? { sessionId } : {}),
    entries: listRemoteDesktopAuditEntries(sessionId),
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Subscribe to audit log updates (append / clear).
 */
export function subscribeRemoteDesktopAuditLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetRemoteDesktopAuditLogForTests(): void {
  auditEntries = null;
  listeners.clear();
  if (hasLocalStorage()) {
    try {
      localStorageAdapter.remove(STORAGE_KEY_REMOTE_DESKTOP_AI_AUDIT);
    } catch {
      // Ignore storage cleanup errors.
    }
  }
}
