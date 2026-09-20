type Listener = () => void;

export type TerminalCwdSource = "osc7" | "prompt" | "inferred" | "backend-strict" | "backend" | "snapshot" | "stale" | "unknown";

/**
 * Live terminal CWD map + version token.
 * OSC 7 / cwd probes update this store without setState on TerminalLayer,
 * so only subscribers (side-panel live snapshot bridge) re-render.
 */
class TerminalCwdStore {
  private cwdBySession = new Map<string, string>();
  private sourceBySession = new Map<string, TerminalCwdSource>();
  private liveCwdReaders = new Map<string, () => string | null>();
  private version = 0;
  private listeners = new Set<Listener>();

  getVersion = (): number => this.version;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getCwd = (sessionId: string | null | undefined): string | null => {
    if (!sessionId) return null;
    return this.cwdBySession.get(sessionId) ?? null;
  };

  getSource = (sessionId: string | null | undefined): TerminalCwdSource | undefined => {
    if (!sessionId) return undefined;
    return this.sourceBySession.get(sessionId);
  };

  registerLiveCwdReader = (sessionId: string, reader: () => string | null): (() => void) => {
    this.liveCwdReaders.set(sessionId, reader);
    return () => {
      if (this.liveCwdReaders.get(sessionId) === reader) {
        this.liveCwdReaders.delete(sessionId);
      }
    };
  };

  readLiveCwd = (sessionId: string | null | undefined): string | null => {
    if (!sessionId) return null;
    try {
      const cwd = this.liveCwdReaders.get(sessionId)?.() ?? null;
      return cwd && cwd.trim().length > 0 ? cwd : null;
    } catch {
      return null;
    }
  };

  waitForCwd = (
    sessionId: string,
    options?: {
      timeoutMs?: number;
      minVersion?: number;
      accept?: (cwd: string, source?: TerminalCwdSource) => boolean;
    },
  ): Promise<string | null> => {
    const timeoutMs = options?.timeoutMs ?? 1500;
    const minVersion = options?.minVersion ?? this.version;
    const accept = options?.accept ?? ((cwd) => Boolean(cwd));
    const current = this.getCwd(sessionId);
    const currentSource = this.getSource(sessionId);
    if (this.version > minVersion && current && accept(current, currentSource)) {
      return Promise.resolve(current);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe();
        resolve(null);
      }, timeoutMs);
      const unsubscribe = this.subscribe(() => {
        if (this.version <= minVersion) return;
        const cwd = this.getCwd(sessionId);
        const source = this.getSource(sessionId);
        if (!cwd || !accept(cwd, source)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(cwd);
      });
    });
  };

  setCwd(sessionId: string, cwd: string | null, source?: TerminalCwdSource): boolean {
    const current = this.cwdBySession.get(sessionId) ?? null;
    const currentSource = this.sourceBySession.get(sessionId);
    const next = cwd && cwd.trim().length > 0 ? cwd : null;
    const nextSource = next
      ? (source ?? (current === next ? currentSource : undefined) ?? "unknown")
      : undefined;
    if (current === next && currentSource === nextSource) return false;

    if (next) {
      this.cwdBySession.set(sessionId, next);
      this.sourceBySession.set(sessionId, nextSource!);
    } else {
      this.cwdBySession.delete(sessionId);
      this.sourceBySession.delete(sessionId);
    }
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
        this.liveCwdReaders.delete(sessionId);
        changed = true;
      }
    }
    for (const sessionId of [...this.liveCwdReaders.keys()]) {
      if (!validSessionIds.has(sessionId)) {
        this.liveCwdReaders.delete(sessionId);
        changed = true;
      }
    }
    if (!changed) return;
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const terminalCwdStore = new TerminalCwdStore();
