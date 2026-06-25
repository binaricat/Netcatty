export interface ToolResultDedupEntry {
  fingerprint: string;
  toolName: string;
  turnNumber: number;
  preview: string;
}

export class ToolResultDedup {
  private turnNumber = 0;
  private readonly cache = new Map<string, ToolResultDedupEntry>();

  beginTurn(): void {
    this.turnNumber += 1;
  }

  reset(): void {
    this.cache.clear();
    this.turnNumber = 0;
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
      preview: preview.slice(0, 160),
    });
  }

  buildCachedNotice(entry: ToolResultDedupEntry): string {
    return `[cached] same as turn ${entry.turnNumber} for ${entry.toolName}`;
  }
}

export function hashScopeKey(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join('|');
}

export function previewToolResult(result: unknown): string {
  if (typeof result === 'string') return result.slice(0, 160);
  try {
    return JSON.stringify(result).slice(0, 160);
  } catch {
    return String(result).slice(0, 160);
  }
}
