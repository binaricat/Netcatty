export const DEFAULT_DOOM_LOOP_THRESHOLD = 3;

export interface DoomLoopRecord {
  toolName: string;
  argsFingerprint: string;
  failureSignature: string;
}

export interface DoomLoopState {
  last: DoomLoopRecord | null;
  repeatCount: number;
  paused: boolean;
}

export interface DoomLoopDetection {
  triggered: boolean;
  record: DoomLoopRecord;
  repeatCount: number;
}

export function createDoomLoopState(): DoomLoopState {
  return { last: null, repeatCount: 0, paused: false };
}

export function stableStringify(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => typeof entryValue !== 'undefined')
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
}

export function normalizeFailureSignature(result: unknown): string {
  let raw = '';
  if (typeof result === 'string') {
    raw = result;
  } else if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (typeof record.error === 'string') raw = record.error;
    else if (typeof record.message === 'string') raw = record.message;
    else raw = stableStringify(record);
  } else {
    raw = String(result);
  }

  return raw
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\b\d{4,}\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

export function isToolResultFailure(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const record = result as Record<string, unknown>;
  return record.ok === false
    || record.isError === true
    || typeof record.error === 'string';
}

export function recordDoomLoopResult(
  state: DoomLoopState,
  toolName: string,
  args: unknown,
  failureResult: unknown,
  threshold = DEFAULT_DOOM_LOOP_THRESHOLD,
): DoomLoopDetection {
  const record: DoomLoopRecord = {
    toolName,
    argsFingerprint: stableStringify(args),
    failureSignature: normalizeFailureSignature(failureResult),
  };
  const previous = state.last;
  const isRepeat = previous?.toolName === record.toolName
    && previous.argsFingerprint === record.argsFingerprint
    && previous.failureSignature === record.failureSignature;

  state.last = record;
  state.repeatCount = isRepeat ? state.repeatCount + 1 : 1;

  return {
    triggered: state.repeatCount >= threshold,
    record,
    repeatCount: state.repeatCount,
  };
}

export function resetDoomLoopState(state: DoomLoopState): void {
  state.last = null;
  state.repeatCount = 0;
  state.paused = false;
}
