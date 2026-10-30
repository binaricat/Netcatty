type Listener = () => void;

export type TerminalCwdSource = "osc7" | "inferred" | "backend-strict" | "backend" | "snapshot" | "stale" | "unknown";

/**
 * Live terminal CWD map + version token.
 * OSC 7 / cwd probes update this store without setState on TerminalLayer,
 * so only subscribers (side-panel live snapshot bridge) re-render.
 */
class TerminalCwdStore {
  private cwdBySession = new Map<string, string>();
  private sourceBySession = new Map<string, TerminalCwdSource>();
  private revisionBySession = new Map<string, number>();
  private revision = 0;
  private version = 0;
  private listeners = new Set<Listener>();

  getVersion = (): number => this.version;

  /** Tracks reports for one session, including unchanged authoritative OSC 7. */
  getSessionRevision = (sessionId: string): number => this.revisionBySession.get(sessionId) ?? 0;

  getCwd = (sessionId: string | null | undefined): string | null => {
    if (!sessionId) return null;
    return this.cwdBySession.get(sessionId) ?? null;
  };

  getSource = (sessionId: string | null | undefined): TerminalCwdSource | undefined => {
    if (!sessionId) return undefined;
    return this.sourceBySession.get(sessionId);
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setCwd(sessionId: string, cwd: string | null, source?: TerminalCwdSource): boolean {
    const current = this.cwdBySession.get(sessionId) ?? null;
    const currentSource = this.sourceBySession.get(sessionId);
    const next = cwd && cwd.trim().length > 0 ? cwd : null;
    const nextSource = next
      ? (source ?? (current === next ? currentSource : undefined) ?? "unknown")
      : undefined;
    if (current === next && currentSource === nextSource) {
      if (nextSource === 'osc7') this.revisionBySession.set(sessionId, ++this.revision);
      return false;
    }

    if (next) {
      this.cwdBySession.set(sessionId, next);
      this.sourceBySession.set(sessionId, nextSource!);
    } else {
      this.cwdBySession.delete(sessionId);
      this.sourceBySession.delete(sessionId);
    }
    this.revisionBySession.set(sessionId, ++this.revision);
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
    return true;
  }

  prune(validSessionIds: ReadonlySet<string>): void {
    let changed = false;
    for (const sessionId of this.cwdBySession.keys()) {
      if (!validSessionIds.has(sessionId)) {
        this.cwdBySession.delete(sessionId);
        this.sourceBySession.delete(sessionId);
        this.revisionBySession.delete(sessionId);
        changed = true;
      }
    }
    for (const id of this.revisionBySession.keys()) {
      if (!validSessionIds.has(id)) this.revisionBySession.delete(id);
    }
    if (!changed) return;
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const terminalCwdStore = new TerminalCwdStore();
