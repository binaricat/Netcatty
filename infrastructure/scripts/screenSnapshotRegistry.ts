export type ScreenSnapshotProvider = () => {
  rows: number;
  cols: number;
  currentRow: number;
  lines: string[];
  /** Optional origin marker (e.g. hibernate-viewport). */
  source?: string;
};

const providers = new Map<string, ScreenSnapshotProvider>();

export function registerScreenSnapshotProvider(
  sessionId: string,
  provider: ScreenSnapshotProvider,
): () => void {
  providers.set(sessionId, provider);
  return () => {
    if (providers.get(sessionId) === provider) {
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
  return provider();
}
