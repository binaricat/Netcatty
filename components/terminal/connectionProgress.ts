export const CONNECTION_PROGRESS_START = 5;
export const CONNECTION_PROGRESS_CAP = 95;

export const advanceIndeterminateConnectionProgress = (prev: number): number => {
  if (prev >= CONNECTION_PROGRESS_CAP) return prev;
  const remaining = CONNECTION_PROGRESS_CAP - prev;
  const increment = Math.max(1, remaining * 0.15);
  return Math.min(CONNECTION_PROGRESS_CAP, prev + increment);
};

export const resolveHopConnectionProgress = (hop: number, total: number): number => {
  const safeTotal = Math.max(1, total);
  const safeHop = Math.max(0, hop);
  return Math.min(CONNECTION_PROGRESS_CAP, (safeHop / safeTotal) * 80 + 10);
};

export const advanceMonotonicConnectionProgress = (prev: number, next: number): number =>
  Math.max(prev, next);

/** Connection progress lines kept per terminal (newest win). */
export const MAX_CONNECTION_PROGRESS_LOGS = 300;

export const capConnectionProgressLogs = (logs: string[]): string[] =>
  logs.length > MAX_CONNECTION_PROGRESS_LOGS ? logs.slice(-MAX_CONNECTION_PROGRESS_LOGS) : logs;
