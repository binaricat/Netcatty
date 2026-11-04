import type { AISession } from '../../infrastructure/ai/types';

/**
 * Renderer-side logic for the AI session durability layer (issue #4015 R2
 * follow-up): a disk mirror of the localStorage session store plus a
 * restore-on-empty-store boot path. The IPC plumbing lives in
 * `electron/bridges/aiSessionsBackupBridge.cjs`; this module keeps the
 * decisions pure so they can be tested without Electron.
 */

/** Debounce window: at most one backup write per mutation burst (~2s). */
export const AI_SESSIONS_BACKUP_DEBOUNCE_MS = 2000;

export interface AiSessionsBackupBridge {
  aiSessionsBackupWrite?: (payload: { json: string }) => Promise<{ ok: boolean }>;
  aiSessionsBackupReadLatest?: () => Promise<{ ok: boolean; json?: string }>;
  aiSessionsBackupExport?: (payload: { json: string }) => Promise<{ success: boolean; filePath?: string }>;
  aiSessionsBackupImport?: () => Promise<{ success: boolean; json?: string }>;
}

/**
 * Parse the live sessions store once, returning both whether it is usable and
 * its sessions. The history is often several MB; the helpers below used to
 * parse it twice per call, and mount ran them back to back (five parses).
 */
export function parseSessionsStore(raw: string | null | undefined): { valid: boolean; sessions: AISession[] } {
  if (raw == null || raw === '') return { valid: false, sessions: [] };
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? { valid: true, sessions: parsed as AISession[] }
      : { valid: false, sessions: [] };
  } catch {
    return { valid: false, sessions: [] };
  }
}

/** Restore only when the live store is missing or malformed. A valid empty
 * array represents an intentional deletion and must remain authoritative. */
export function isMissingOrCorruptSessionsStore(raw: string | null | undefined): boolean {
  return !parseSessionsStore(raw).valid;
}

/** Read the live sessions array from a raw localStorage string. Returns [] when
 * missing/corrupt (including parseable non-arrays such as `{}`), so callers never
 * treat a non-array as AISession[]. */
export function readLiveSessionsArray(raw: string | null | undefined): AISession[] {
  return parseSessionsStore(raw).sessions;
}

/**
 * Parse a backup payload into sessions. Returns null when the payload is
 * corrupt or malformed (ignored gracefully); also drops entries without a
 * usable required fields. Backup generations are written by the same serializer as the
 * live store, so entries are expected to be full AISession objects.
 */

export function parseBackupSessions(json: string | null | undefined): AISession[] | null {
  if (typeof json !== 'string' || json === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const sessions = parsed.filter(
    (entry): entry is AISession => (
      typeof entry === 'object' && entry !== null
      && typeof (entry as AISession).id === 'string'
      && typeof (entry as AISession).title === 'string'
      && typeof (entry as AISession).agentId === 'string'
      && typeof (entry as AISession).scope === 'object'
      && (entry as AISession).scope !== null
      && typeof (entry as AISession).scope.type === 'string'
      && Array.isArray((entry as AISession).messages)
      && (entry as AISession).messages.every(message => (
        typeof message === 'object' && message !== null
        && typeof message.id === 'string'
        && typeof message.role === 'string'
        && typeof message.content === 'string'
        && typeof message.timestamp === 'number'
        && Number.isFinite(message.timestamp)
      ))
      && typeof (entry as AISession).updatedAt === 'number'
      && Number.isFinite((entry as AISession).updatedAt)
    ),
  );
  return sessions.length > 0 ? sessions : null;
}

/**
 * Decide whether to restore on boot: only when the live store is missing or corrupt AND
 * the backup actually contains at least one session.
 */
export function shouldRestoreFromBackup(
  liveRaw: string | null | undefined,
  backupJson: string | null | undefined,
): boolean {
  if (!isMissingOrCorruptSessionsStore(liveRaw)) return false;
  const sessions = parseBackupSessions(backupJson);
  return sessions != null && sessions.length > 0;
}

/**
 * Merge an imported backup into the current store: entries are keyed by id
 * and the newer `updatedAt` wins. Explicit user action, so it may overwrite
 * the live store (unlike the boot restore, which is empty-only).
 */
export function mergeImportedSessions(current: AISession[], imported: AISession[]): AISession[] {
  const byId = new Map<string, AISession>();
  for (const session of current) byId.set(session.id, session);
  for (const session of imported) {
    const existing = byId.get(session.id);
    if (!existing || (session.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
      byId.set(session.id, session);
    }
  }
  return Array.from(byId.values()).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/**
 * Debounced mirror scheduler. One rolling timer per process: the last
 * mutation batch wins, and the write happens `debounceMs` after the batch
 * settles (at most once per batch, per the durability spec).
 */
export class DebouncedBackupMirror {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingJson: string | null = null;

  constructor(
    private readonly write: (json: string) => void,
    private readonly debounceMs: number = AI_SESSIONS_BACKUP_DEBOUNCE_MS,
  ) {}

  schedule(json: string) {
    this.pendingJson = json;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const json = this.pendingJson;
      this.pendingJson = null;
      if (json != null) this.write(json);
    }, this.debounceMs);
  }

  flushNow() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const json = this.pendingJson;
    this.pendingJson = null;
    if (json != null) this.write(json);
  }

  reset() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pendingJson = null;
  }
}
