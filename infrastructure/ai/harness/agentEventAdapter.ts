import type { AgentEvent, AgentEventListener } from './types';
import { resolveStreamChunkToolCallId } from '../aiChatStreamingSupport';

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
  approved?: boolean;
  stepNumber?: number;
}

const STEP_HANDLE_NOTICE_RE = /^(?:\[step \d+\] Tool output handles available:|\[Tool output handles available:)/;

function isStepHandleNoticeMessage(content: unknown): boolean {
  return typeof content === 'string' && STEP_HANDLE_NOTICE_RE.test(content);
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
      {
        const output = event.result ?? event.output ?? '';
      return [{
        ...base,
        id: nextEventId('tool-result'),
        type: 'tool_result',
        toolCallId: String(event.toolCallId ?? ''),
        toolName: typeof event.toolName === 'string' ? event.toolName : undefined,
        result: typeof output === 'string' ? output : JSON.stringify(output),
        isError: Boolean(event.isError) || isToolResultError(output),
      }];
      }
    case 'file-change':
      return [{
        ...base,
        id: nextEventId('file-change'),
        type: 'file_change',
        itemId: String(event.itemId ?? ''),
        status: event.status === 'failed' ? 'failed' : 'completed',
        changes: Array.isArray(event.changes)
          ? event.changes as Array<{ path: string; kind: 'add' | 'delete' | 'update' }>
          : [],
      }];
    case 'web-search':
      return [{
        ...base,
        id: nextEventId('web-search'),
        type: 'web_search',
        itemId: String(event.itemId ?? ''),
        query: String(event.query ?? ''),
        status: event.status === 'completed' ? 'completed' : 'running',
      }];
    case 'plan-update':
      return [{
        ...base,
        id: nextEventId('plan-update'),
        type: 'plan_update',
        itemId: String(event.itemId ?? ''),
        status: event.status === 'completed' ? 'completed' : 'running',
        items: Array.isArray(event.items)
          ? event.items as Array<{ text: string; completed: boolean }>
          : [],
      }];
    case 'warning':
      return [{
        ...base,
        id: nextEventId('warning'),
        type: 'error',
        message: String(event.message ?? 'Unknown SDK warning'),
        recoverable: true,
      }];
    case 'usage': {
      const promptTokens = Number(event.inputTokens) || 0;
      const completionTokens = Number(event.outputTokens) || 0;
      return [{
        ...base,
        id: nextEventId('usage'),
        type: 'usage',
        promptTokens,
        cachedPromptTokens: Number(event.cachedInputTokens) || 0,
        completionTokens,
        reasoningTokens: Number(event.reasoningTokens) || 0,
        totalTokens: Number(event.totalTokens) || promptTokens + completionTokens,
        estimated: false,
      }];
    }
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
      toolName: typeof chunk.toolName === 'string' ? chunk.toolName : undefined,
      result: resultText,
      isError: isToolResultError(output),
    }];
  }

  if (chunk.type === 'tool-error' && chunk.toolCallId) {
    const resultText = chunk.error instanceof Error
      ? JSON.stringify({ error: chunk.error.message })
      : typeof chunk.error === 'string'
        ? JSON.stringify({ error: chunk.error })
        : JSON.stringify({ error: String(chunk.error ?? 'Tool execution failed.') });
    return [{
      ...base,
      id: nextEventId('tool-result'),
      type: 'tool_result',
      toolCallId: chunk.toolCallId,
      toolName: typeof chunk.toolName === 'string' ? chunk.toolName : undefined,
      result: resultText,
      isError: true,
    }];
  }

  if (chunk.type === 'error') {
    const message = chunk.error instanceof Error
      ? chunk.error.message
      : String(chunk.error ?? 'Unknown stream error');
    return [{ ...base, id: nextEventId('error'), type: 'error', message }];
  }

  if (chunk.type === 'tool-approval-request') {
    const toolCallId = resolveStreamChunkToolCallId(chunk);
    const toolName = chunk.toolName ?? chunk.toolCall?.toolName;
    if (!toolCallId || !toolName) return [];
    return [{
      ...base,
      id: nextEventId('approval-requested'),
      type: 'approval_requested',
      toolCallId,
      toolName,
      args: (chunk.input ?? chunk.args ?? chunk.toolCall?.input ?? {}) as Record<string, unknown>,
    }];
  }

  if (chunk.type === 'tool-approval-response') {
    const toolCallId = resolveStreamChunkToolCallId(chunk);
    if (!toolCallId) return [];
    const approved = chunk.approved === true;
    const events: AgentEvent[] = [{
      ...base,
      id: nextEventId('approval-resolved'),
      type: 'approval_resolved',
      toolCallId,
      toolName: String(chunk.toolName ?? chunk.toolCall?.toolName ?? 'unknown'),
      outcome: approved ? 'approved' : 'denied',
    }];
    if (!approved) {
      events.push({
        ...base,
        id: nextEventId('tool-result'),
        type: 'tool_result',
        toolCallId,
        result: JSON.stringify({ error: chunk.reason ?? 'Tool execution denied.' }),
        isError: true,
      });
    }
    return events;
  }

  if (chunk.type === 'tool-output-denied' && chunk.toolCallId) {
    return [
      {
        ...base,
        id: nextEventId('approval-resolved'),
        type: 'approval_resolved',
        toolCallId: chunk.toolCallId,
        toolName: String(chunk.toolName ?? 'unknown'),
        outcome: 'denied',
      },
      {
        ...base,
        id: nextEventId('tool-result'),
        type: 'tool_result',
        toolCallId: chunk.toolCallId,
        result: JSON.stringify({ error: 'Tool execution denied.' }),
        isError: true,
      },
    ];
  }

  return [];
}

export { isStepHandleNoticeMessage };

export function createHarnessEventSink(
  listener: AgentEventListener,
): AgentEventListener {
  return (event) => listener(event);
}
