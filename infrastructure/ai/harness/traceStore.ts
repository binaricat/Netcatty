import type { AgentEvent, CompactionTrace } from './types';

const DEFAULT_MAX_EVENTS = 2_000;
const DEFAULT_MAX_COMPACTIONS = 500;
const DEFAULT_MAX_SESSIONS = 16;

export interface TraceExport {
  sessionId: string;
  events: AgentEvent[];
  compactions: CompactionTrace[];
  exportedAt: number;
}

class RingBuffer<T> {
  private readonly items: T[] = [];
  private head = 0;
  private count = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(item: T): void {
    if (this.count < this.capacity) {
      this.items.push(item);
      this.count += 1;
      return;
    }
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
  }

  toArray(): T[] {
    if (this.count === 0) return [];
    if (this.head === 0) return this.items.slice(0, this.count);
    return [
      ...this.items.slice(this.head, this.count),
      ...this.items.slice(0, this.head),
    ];
  }
}

interface SessionTraceBucket {
  events: RingBuffer<AgentEvent>;
  compactions: RingBuffer<CompactionTrace>;
}

export class TraceStore {
  private readonly sessions = new Map<string, SessionTraceBucket>();
  private readonly maxEvents: number;
  private readonly maxCompactions: number;
  private readonly maxSessions: number;

  constructor(
    maxEvents = DEFAULT_MAX_EVENTS,
    maxCompactions = Math.min(DEFAULT_MAX_COMPACTIONS, maxEvents),
    maxSessions = DEFAULT_MAX_SESSIONS,
  ) {
    this.maxEvents = Math.max(1, Math.floor(maxEvents));
    this.maxCompactions = Math.max(1, Math.floor(maxCompactions));
    this.maxSessions = Math.max(1, Math.floor(maxSessions));
  }

  private touchSession(sessionId: string, bucket: SessionTraceBucket): void {
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, bucket);
  }

  private getOrCreateSession(sessionId: string): SessionTraceBucket {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.touchSession(sessionId, existing);
      return existing;
    }
    const bucket: SessionTraceBucket = {
      events: new RingBuffer<AgentEvent>(this.maxEvents),
      compactions: new RingBuffer<CompactionTrace>(this.maxCompactions),
    };
    this.sessions.set(sessionId, bucket);
    while (this.sessions.size > this.maxSessions) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey === undefined) break;
      this.sessions.delete(oldestKey);
    }
    return bucket;
  }

  append(event: AgentEvent): void {
    const bucket = this.getOrCreateSession(event.sessionId);
    bucket.events.push(event);
    if (event.type === 'compaction') {
      bucket.compactions.push(event.trace);
    }
  }

  getEvents(sessionId: string): readonly AgentEvent[] {
    const bucket = this.sessions.get(sessionId);
    if (!bucket) return [];
    this.touchSession(sessionId, bucket);
    return bucket.events.toArray();
  }

  getCompactions(sessionId: string): readonly CompactionTrace[] {
    const bucket = this.sessions.get(sessionId);
    if (!bucket) return [];
    this.touchSession(sessionId, bucket);
    return bucket.compactions.toArray();
  }

  exportTrace(sessionId: string): TraceExport {
    const bucket = this.sessions.get(sessionId);
    if (bucket) {
      this.touchSession(sessionId, bucket);
    }
    return {
      sessionId,
      events: bucket ? bucket.events.toArray() : [],
      compactions: bucket ? bucket.compactions.toArray() : [],
      exportedAt: Date.now(),
    };
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/** Process-wide trace store for harness debugging. */
export const globalTraceStore = new TraceStore();
