import type { TerminalContextReader } from "../../domain/terminalContextRead";

export type ScreenSnapshotProvider = () => {
  rows: number;
  cols: number;
  currentRow: number;
  lines: string[];
  /** Optional origin marker (e.g. hibernate-viewport). */
  source?: string;
};

const providers = new Map<string, { snapshot: ScreenSnapshotProvider; readContext?: TerminalContextReader }>();

export function registerScreenSnapshotProvider(
  sessionId: string,
  provider: ScreenSnapshotProvider,
  readContext?: TerminalContextReader,
): () => void {
  const entry = { snapshot: provider, readContext };
  providers.set(sessionId, entry);
  return () => {
    if (providers.get(sessionId) === entry) {
      providers.delete(sessionId);
    }
  };
}

export function captureScreenSnapshot(sessionId: string) {
  const provider = providers.get(sessionId);
  if (!provider) {
    return {
      rows: 24,
      cols: 80,
      currentRow: 0,
      lines: [] as string[],
    };
  }
  return provider.snapshot();
}

/** Uses the same bounded reader as the sidebar, including hibernated terminals. */
export const readScreenContext: TerminalContextReader = async (request) => {
  const reader = providers.get(request.sessionId)?.readContext;
  if (!reader) return { ok: false, error: "Terminal context reader is unavailable for this session." };
  return reader(request);
};
