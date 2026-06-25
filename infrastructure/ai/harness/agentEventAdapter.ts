import type { AgentEvent, AgentEventListener } from './types';

let eventCounter = 0;

function nextEventId(prefix: string): string {
  eventCounter += 1;
  return `${prefix}-${Date.now()}-${eventCounter}`;
}

export interface StreamEventContext {
  sessionId: string;
  chatSessionId?: string;
  turnId?: string;
}

export interface CattyStreamChunk {
  type: string;
  text?: string;
  textDelta?: string;
  delta?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  args?: unknown;
  output?: unknown;
  result?: unknown;
  error?: unknown;
}

function isToolResultError(output: unknown): boolean {
  if (output == null) return false;
  if (typeof output === 'object') {
    const obj = output as Record<string, unknown>;
    if ('error' in obj && typeof obj.error === 'string') return true;
    if ('ok' in obj && obj.ok === false) return true;
  }
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      if ('error' in parsed && typeof parsed.error === 'string') return true;
      if ('ok' in parsed && parsed.ok === false) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function mapSdkStreamEventToAgentEvents(
  event: Record<string, unknown>,
  ctx: StreamEventContext,
): AgentEvent[] {
  const base = {
    sessionId: ctx.sessionId,
    chatSessionId: ctx.chatSessionId,
    backend: 'external-sdk' as const,
    timestamp: Date.now(),
    turnId: ctx.turnId,
  };

  switch (event.type) {
    case 'text-delta':
      return [{
        ...base,
        id: nextEventId('model-delta'),
        type: 'model_delta',
        text: String(event.text ?? event.textDelta ?? event.delta ?? ''),
      }];
    case 'thinking-delta':
    case 'reasoning-delta':
      return [{
        ...base,
        id: nextEventId('reasoning-delta'),
        type: 'reasoning_delta',
        text: String(event.text ?? event.textDelta ?? event.delta ?? ''),
      }];
    case 'tool-call':
      return [{
        ...base,
        id: nextEventId('tool-call'),
        type: 'tool_call',
        toolCallId: String(event.toolCallId ?? event.id ?? ''),
        toolName: String(event.toolName ?? event.name ?? 'unknown'),
        args: (event.args ?? event.input ?? {}) as Record<string, unknown>,
      }];
    case 'tool-result':
      return [{
        ...base,
        id: nextEventId('tool-result'),
        type: 'tool_result',
        toolCallId: String(event.toolCallId ?? ''),
        toolName: typeof event.toolName === 'string' ? event.toolName : undefined,
        result: String(event.result ?? event.output ?? ''),
        isError: Boolean(event.isError),
      }];
    case 'error':
      return [{
        ...base,
        id: nextEventId('error'),
        type: 'error',
        message: String(event.error ?? event.message ?? 'Unknown SDK error'),
        recoverable: false,
      }];
    default:
      return [];
  }
}

export function mapCattyStreamChunkToAgentEvents(
  chunk: CattyStreamChunk,
  ctx: StreamEventContext,
): AgentEvent[] {
  const base = {
    sessionId: ctx.sessionId,
    chatSessionId: ctx.chatSessionId,
    backend: 'catty' as const,
    timestamp: Date.now(),
    turnId: ctx.turnId,
  };

  if (chunk.type === 'text' || chunk.type === 'text-delta') {
    const text = chunk.text ?? chunk.textDelta ?? '';
    if (!text) return [];
    return [{ ...base, id: nextEventId('model-delta'), type: 'model_delta', text }];
  }

  if (chunk.type === 'reasoning' || chunk.type === 'reasoning-start' || chunk.type === 'reasoning-delta') {
    const text = chunk.text ?? chunk.textDelta ?? chunk.delta ?? '';
    if (!text) return [];
    return [{ ...base, id: nextEventId('reasoning-delta'), type: 'reasoning_delta', text }];
  }

  if (chunk.type === 'tool-call' && chunk.toolCallId && chunk.toolName) {
    return [{
      ...base,
      id: nextEventId('tool-call'),
      type: 'tool_call',
      toolCallId: chunk.toolCallId,
      toolName: chunk.toolName,
      args: (chunk.input ?? chunk.args ?? {}) as Record<string, unknown>,
    }];
  }

  if (chunk.type === 'tool-result' && chunk.toolCallId) {
    const output = chunk.output ?? chunk.result;
    const resultText = typeof output === 'string' ? output : JSON.stringify(output ?? '');
    return [{
      ...base,
      id: nextEventId('tool-result'),
      type: 'tool_result',
      toolCallId: chunk.toolCallId,
      result: resultText,
      isError: isToolResultError(output),
    }];
  }

  if (chunk.type === 'error') {
    const message = chunk.error instanceof Error
      ? chunk.error.message
      : String(chunk.error ?? 'Unknown stream error');
    return [{ ...base, id: nextEventId('error'), type: 'error', message }];
  }

  return [];
}

export function createHarnessEventSink(
  listener: AgentEventListener,
): AgentEventListener {
  return (event) => listener(event);
}
