import type { ModelMessage } from 'ai';
import { findSafeCompactionSplitIndex } from '../contextCompaction';

interface CacheEntry {
  modelId: string;
  prefixLength: number;
  fingerprint: string;
  notePromise: Promise<string>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function fingerprintMessages(messages: ModelMessage[]): string {
  const value = JSON.stringify(canonicalize(messages));
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

const DEFAULT_MAX_SESSIONS = 32;

export class TwoPassCompactionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxSessions: number;

  constructor(maxSessions = DEFAULT_MAX_SESSIONS) {
    this.maxSessions = Math.max(1, Math.floor(maxSessions));
  }

  private touch(chatSessionId: string, entry: CacheEntry): void {
    this.entries.delete(chatSessionId);
    this.entries.set(chatSessionId, entry);
  }

  start(
    chatSessionId: string,
    modelId: string,
    messages: ModelMessage[],
    producer: (prefix: ModelMessage[]) => Promise<string>,
  ): boolean {
    const current = this.entries.get(chatSessionId);
    if (
      current
      && current.modelId === modelId
      && messages.length >= current.prefixLength
      && fingerprintMessages(messages.slice(0, current.prefixLength)) === current.fingerprint
    ) {
      this.touch(chatSessionId, current);
      return false;
    }
    const protectedTail = Math.max(10, Math.ceil(messages.length * 0.05));
    const prefixLength = findSafeCompactionSplitIndex(messages, protectedTail);
    if (prefixLength <= 0) return false;
    const prefix = messages.slice(0, prefixLength);
    const fingerprint = fingerprintMessages(prefix);
    if (
      current
      && current.modelId === modelId
      && current.prefixLength === prefixLength
      && current.fingerprint === fingerprint
    ) {
      this.touch(chatSessionId, current);
      return false;
    }
    this.entries.delete(chatSessionId);
    this.entries.set(chatSessionId, {
      modelId,
      prefixLength,
      fingerprint,
      notePromise: producer(prefix).then(note => note.slice(0, 12_000)).catch(() => ''),
    });
    while (this.entries.size > this.maxSessions) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
    return true;
  }

  async consume(
    chatSessionId: string,
    modelId: string,
    messages: ModelMessage[],
  ): Promise<{ note: string; prefixLength: number } | undefined> {
    const entry = this.entries.get(chatSessionId);
    if (!entry || entry.modelId !== modelId || messages.length < entry.prefixLength) {
      this.entries.delete(chatSessionId);
      return undefined;
    }
    const prefix = messages.slice(0, entry.prefixLength);
    if (fingerprintMessages(prefix) !== entry.fingerprint) {
      this.entries.delete(chatSessionId);
      return undefined;
    }
    const note = await entry.notePromise;
    // Only delete if this exact entry is still current; preserve any concurrent
    // re-prime that replaced the slot while awaiting notePromise.
    if (this.entries.get(chatSessionId) === entry) {
      this.entries.delete(chatSessionId);
    }
    return note ? { note, prefixLength: entry.prefixLength } : undefined;
  }

  clear(chatSessionId: string): void {
    this.entries.delete(chatSessionId);
  }
}

export const globalTwoPassCompactionCache = new TwoPassCompactionCache();
