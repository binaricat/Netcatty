import { sliceHead } from '../textBoundaries';

export interface ToolResultDedupEntry {
  fingerprint: string;
  toolName: string;
  turnNumber: number;
  preview: string;
}

export class ToolResultDedup {
  private turnNumber = 0;
  private readonly cache = new Map<string, ToolResultDedupEntry>();
  private readonly consumedBudgets = new Map<string, number>();
  private readonly completedWrites = new Map<string, unknown[]>();
  private replayableWrites = new Map<string, unknown[]>();
  private readonly terminalJobSessions = new Map<string, string>();
  private writeReplayEnabled = false;

  beginTurn(): void {
    this.turnNumber += 1;
    this.consumedBudgets.clear();
    this.completedWrites.clear();
    this.replayableWrites.clear();
    this.writeReplayEnabled = false;
  }

  reset(): void {
    this.cache.clear();
    this.turnNumber = 0;
    this.consumedBudgets.clear();
    this.completedWrites.clear();
    this.replayableWrites.clear();
    this.terminalJobSessions.clear();
    this.writeReplayEnabled = false;
  }

  rememberCompletedWrite(fingerprint: string, result: unknown): void {
    const results = this.completedWrites.get(fingerprint) ?? [];
    results.push(result);
    this.completedWrites.set(fingerprint, results);
  }

  rememberTerminalJobSession(jobId: string, sessionId: string): void {
    this.terminalJobSessions.set(jobId, sessionId);
  }

  terminalSessionForJob(jobId: string): string | undefined {
    return this.terminalJobSessions.get(jobId);
  }

  enableWriteReplay(preservedFingerprints: Iterable<string> = []): void {
    this.replayableWrites = new Map(
      Array.from(this.completedWrites, ([fingerprint, results]) => [fingerprint, [...results]]),
    );
    this.writeReplayEnabled = true;
    for (const fingerprint of preservedFingerprints) {
      this.consumeReplay(fingerprint);
    }
  }

  replayCompletedWrite(fingerprint: string): unknown | undefined {
    if (!this.writeReplayEnabled) return undefined;
    return this.consumeReplay(fingerprint);
  }

  private consumeReplay(fingerprint: string): unknown | undefined {
    const results = this.replayableWrites.get(fingerprint);
    const result = results?.shift();
    if (results?.length === 0) this.replayableWrites.delete(fingerprint);
    return result;
  }

  takeBudget(key: string, requested: number, limit: number): number {
    const consumed = this.consumedBudgets.get(key) ?? 0;
    const granted = Math.max(0, Math.min(requested, limit - consumed));
    this.consumedBudgets.set(key, consumed + granted);
    return granted;
  }

  fingerprintFor(toolName: string, key: string): string {
    return `${toolName}:${key}`;
  }

  check(fingerprint: string): ToolResultDedupEntry | undefined {
    return this.cache.get(fingerprint);
  }

  remember(toolName: string, fingerprint: string, preview: string): void {
    this.cache.set(fingerprint, {
      fingerprint,
      toolName,
      turnNumber: this.turnNumber,
      preview: sliceHead(preview, 160),
    });
  }

  buildCachedNotice(entry: ToolResultDedupEntry): string {
    return `[cached] same as turn ${entry.turnNumber} for ${entry.toolName}`;
  }
}

export function hashScopeKey(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join('|');
}

export function buildTerminalWriteFingerprint(
  toolName: 'terminal_execute' | 'terminal_start',
  chatSessionId: string | undefined,
  args: { sessionId?: unknown; command?: unknown },
): string | undefined {
  if (typeof args.sessionId !== 'string' || typeof args.command !== 'string') return undefined;
  const fingerprintToolName = toolName === 'terminal_start' ? 'terminal.start:write' : toolName;
  return `${fingerprintToolName}:${hashScopeKey([chatSessionId, args.sessionId, args.command])}`;
}

export function previewToolResult(result: unknown): string {
  if (typeof result === 'string') return sliceHead(result, 160);
  try {
    return sliceHead(JSON.stringify(result), 160);
  } catch {
    return sliceHead(String(result), 160);
  }
}

export function hashToolResult(result: unknown): string {
  let value: string;
  try {
    value = typeof result === 'string' ? result : JSON.stringify(result);
  } catch {
    value = String(result);
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
