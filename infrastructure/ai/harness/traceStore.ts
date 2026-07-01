import type { AgentEvent, CompactionTrace } from './types';

const DEFAULT_MAX_EVENTS = 2_000;

export interface TraceExport {
  sessionId: string;
  events: AgentEvent[];
  compactions: CompactionTrace[];
  exportedAt: number;
}

export class TraceStore {
  private readonly events = new Map<string, AgentEvent[]>();
  private readonly compactions = new Map<string, CompactionTrace[]>();
  private readonly maxEvents: number;

  constructor(maxEvents = DEFAULT_MAX_EVENTS) {
    this.maxEvents = maxEvents;
  }

  append(event: AgentEvent): void {
    const list = this.events.get(event.sessionId) ?? [];
    list.push(event);
    if (list.length > this.maxEvents) {
      list.splice(0, list.length - this.maxEvents);
    }
    this.events.set(event.sessionId, list);

    if (event.type === 'compaction') {
      const traces = this.compactions.get(event.sessionId) ?? [];
      traces.push(event.trace);
      this.compactions.set(event.sessionId, traces);
    }
  }

  getEvents(sessionId: string): readonly AgentEvent[] {
    return this.events.get(sessionId) ?? [];
  }

  getCompactions(sessionId: string): readonly CompactionTrace[] {
    return this.compactions.get(sessionId) ?? [];
  }

  exportTrace(sessionId: string): TraceExport {
    return {
      sessionId,
      events: [...(this.events.get(sessionId) ?? [])],
      compactions: [...(this.compactions.get(sessionId) ?? [])],
      exportedAt: Date.now(),
    };
  }

  clear(sessionId: string): void {
    this.events.delete(sessionId);
    this.compactions.delete(sessionId);
  }
}

/** Process-wide trace store for harness debugging. */
export const globalTraceStore = new TraceStore();
