import type { AIProviderId, ChatMessageAttachment } from './types';

export type AgentEventType =
  | 'turn_start'
  | 'model_delta'
  | 'reasoning_delta'
  | 'tool_call'
  | 'tool_result'
  | 'approval_requested'
  | 'approval_resolved'
  | 'compaction'
  | 'usage'
  | 'error'
  | 'turn_end';

export type AgentEventSource = 'catty' | 'external_sdk' | 'mcp' | 'skills' | 'system';

export interface AgentEventBase {
  id: string;
  type: AgentEventType;
  sessionId: string;
  turnId?: string;
  timestamp: number;
  source: AgentEventSource;
  requestId?: string;
  backend?: string;
  model?: string;
  providerId?: AIProviderId | string;
  metadata?: Record<string, unknown>;
}

export interface TurnStartAgentEvent extends AgentEventBase {
  type: 'turn_start';
  agentId: string;
  prompt: string;
  attachments?: Array<Pick<ChatMessageAttachment, 'filename' | 'mediaType' | 'terminalSelection' | 'lineCount'>>;
  scope?: {
    type: 'terminal' | 'workspace' | 'global';
    targetId?: string;
    label?: string;
  };
}

export interface ModelDeltaAgentEvent extends AgentEventBase {
  type: 'model_delta';
  delta: string;
  messageId?: string;
}

export interface ReasoningDeltaAgentEvent extends AgentEventBase {
  type: 'reasoning_delta';
  delta: string;
  phase?: 'start' | 'delta' | 'end';
  messageId?: string;
}

export interface ToolCallAgentEvent extends AgentEventBase {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  messageId?: string;
}

export interface ToolResultAgentEvent extends AgentEventBase {
  type: 'tool_result';
  toolCallId: string;
  toolName?: string;
  output: string;
  isError?: boolean;
}

export interface ApprovalRequestedAgentEvent extends AgentEventBase {
  type: 'approval_requested';
  approvalId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ApprovalResolvedAgentEvent extends AgentEventBase {
  type: 'approval_resolved';
  approvalId: string;
  toolCallId: string;
  approved: boolean;
  resolution: 'approved' | 'denied' | 'timeout' | 'cleared' | 'cancelled';
}

export interface CompactionAgentEvent extends AgentEventBase {
  type: 'compaction';
  phase: 'start' | 'end' | 'error';
  reason: 'threshold' | 'request_too_large' | 'fallback' | 'manual';
  messagesBefore?: number;
  messagesAfter?: number;
  estimatedTokensBefore?: number;
  estimatedTokensAfter?: number;
  didCompact?: boolean;
  summary?: string;
  error?: string;
}

export interface UsageAgentEvent extends AgentEventBase {
  type: 'usage';
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  raw?: unknown;
}

export interface ErrorAgentEvent extends AgentEventBase {
  type: 'error';
  error: string;
  retryable?: boolean;
  errorKind?: string;
}

export interface TurnEndAgentEvent extends AgentEventBase {
  type: 'turn_end';
  status: 'completed' | 'error' | 'aborted' | 'cancelled';
  durationMs?: number;
}

export type AgentEvent =
  | TurnStartAgentEvent
  | ModelDeltaAgentEvent
  | ReasoningDeltaAgentEvent
  | ToolCallAgentEvent
  | ToolResultAgentEvent
  | ApprovalRequestedAgentEvent
  | ApprovalResolvedAgentEvent
  | CompactionAgentEvent
  | UsageAgentEvent
  | ErrorAgentEvent
  | TurnEndAgentEvent;

export type NewAgentEvent<T extends AgentEventType = AgentEventType> =
  Omit<Extract<AgentEvent, { type: T }>, 'id' | 'timestamp'> & {
    id?: string;
    timestamp?: number;
  };

export interface AgentEventContext {
  sessionId: string;
  turnId?: string;
  source: AgentEventSource;
  requestId?: string;
  backend?: string;
  model?: string;
  providerId?: AIProviderId | string;
  metadata?: Record<string, unknown>;
}

export interface SdkStreamEvent {
  type: string;
  [key: string]: unknown;
}

export function createAgentEvent<T extends AgentEventType>(
  event: NewAgentEvent<T>,
): Extract<AgentEvent, { type: T }> {
  return {
    ...event,
    id: event.id ?? `agent-event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: event.timestamp ?? Date.now(),
  } as Extract<AgentEvent, { type: T }>;
}

export function createAgentEventFromContext<T extends AgentEventType>(
  context: AgentEventContext,
  event: Omit<NewAgentEvent<T>, keyof AgentEventContext>,
): Extract<AgentEvent, { type: T }> {
  return createAgentEvent({
    ...context,
    ...event,
  } as NewAgentEvent<T>);
}

function stringifySdkOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output == null) return '';
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

export function normalizeSdkStreamEventToAgentEvents(
  event: SdkStreamEvent,
  context: AgentEventContext,
): AgentEvent[] {
  switch (event.type) {
    case 'text-delta': {
      const delta = (event.textDelta as string) || (event.delta as string) || '';
      return delta
        ? [createAgentEventFromContext(context, { type: 'model_delta', delta })]
        : [];
    }
    case 'reasoning-start':
      return [createAgentEventFromContext(context, { type: 'reasoning_delta', delta: '', phase: 'start' })];
    case 'reasoning-delta': {
      const delta = (event.delta as string) || '';
      return delta
        ? [createAgentEventFromContext(context, { type: 'reasoning_delta', delta, phase: 'delta' })]
        : [];
    }
    case 'reasoning-end':
      return [createAgentEventFromContext(context, { type: 'reasoning_delta', delta: '', phase: 'end' })];
    case 'tool-call': {
      const toolName = (event.toolName as string) || 'unknown';
      const args =
        (event.input as Record<string, unknown>) ||
        (event.args as Record<string, unknown>) ||
        {};
      const toolCallId = (event.toolCallId as string) || `sdk-tool-${Date.now()}`;
      return [createAgentEventFromContext(context, {
        type: 'tool_call',
        toolCallId,
        toolName,
        args,
      })];
    }
    case 'tool-result': {
      const output = event.output ?? event.result;
      const toolCallId = (event.toolCallId as string) || '';
      return [createAgentEventFromContext(context, {
        type: 'tool_result',
        toolCallId,
        toolName: (event.toolName as string) || undefined,
        output: stringifySdkOutput(output),
      })];
    }
    case 'usage': {
      const promptTokens = typeof event.promptTokens === 'number' ? event.promptTokens : undefined;
      const completionTokens = typeof event.completionTokens === 'number' ? event.completionTokens : undefined;
      const totalTokens = typeof event.totalTokens === 'number'
        ? event.totalTokens
        : promptTokens != null && completionTokens != null
          ? promptTokens + completionTokens
          : undefined;
      return [createAgentEventFromContext(context, {
        type: 'usage',
        promptTokens,
        completionTokens,
        totalTokens,
        raw: event,
      })];
    }
    case 'error':
      return [createAgentEventFromContext(context, {
        type: 'error',
        error: stringifySdkOutput(event.error) || 'Unknown error',
      })];
    default:
      return [];
  }
}
