import type {
  AISession,
  AISessionContextCompaction,
  AISessionScope,
  ChatMessage,
  ToolCall,
  ToolResult,
} from '../infrastructure/ai/types';
import { hasUnresolvedToolCalls } from './aiUndoLastTurn';

/**
 * "Fork from here": copy a conversation up to a completed assistant response
 * into an independent session. The source conversation stays in history
 * untouched and keeps running whatever it was doing.
 *
 * A fork replays the retained transcript with a fresh chat identity, so it
 * keeps every per-message replay field as-is — message ids, tool-call ids and
 * the reasoning/options carried on `providerContinuation` — while dropping
 * state that belongs to the source chat: `externalSessionId` (a provider-side
 * session cannot be resumed by two chats) and stored tool-output handles
 * (handles live in a per-chat-session store that the fork does not own).
 */

const OUTPUT_HANDLE_ID = 'tool-output-[A-Za-z0-9-]+';
const OUTPUT_HANDLE_ASSIGNMENT_RE = new RegExp(`\\bhandleId\\s*=\\s*${OUTPUT_HANDLE_ID}`, 'g');
const OUTPUT_HANDLE_ID_RE = new RegExp(OUTPUT_HANDLE_ID, 'g');
const OUTPUT_HANDLE_ID_TEST_RE = new RegExp(OUTPUT_HANDLE_ID);
const REMOVED_OUTPUT_HANDLE_NOTICE = '[output handle removed for forked session]';

export interface ForkedSessionOptions {
  newId: string;
  now: number;
  /** Scope of the panel the fork was requested from; the fork continues there. */
  scope: AISessionScope;
}

/**
 * Resolve "fork after this response" to the exclusive message boundary, or null
 * when the response cannot anchor a fork: not a completed turn-ending response,
 * a retained prefix that leaves a tool call without its result, or a boundary
 * that would drop messages the stored compaction summary already covers.
 */
export function resolveForkBoundary(
  session: AISession,
  assistantMessageId: string,
): number | null {
  const index = session.messages.findIndex(
    message => message.id === assistantMessageId && message.role === 'assistant',
  );
  if (index < 0) return null;

  const boundary = index + 1;
  return isRetainedPrefixSafe(session, boundary) ? boundary : null;
}

/**
 * Build the forked copy of `source`: the messages up to `boundary`, the scope
 * the fork was requested from, and a fresh chat identity. Returns null for a
 * boundary that `resolveForkBoundary` would not have produced.
 */
export function buildForkedSession(
  source: AISession,
  boundary: number,
  options: ForkedSessionOptions,
): AISession | null {
  if (!isRetainedPrefixSafe(source, boundary)) return null;

  return {
    ...source,
    id: options.newId,
    scope: options.scope,
    messages: source.messages.slice(0, boundary).map(cloneForkMessage),
    ...(source.contextCompaction
      ? { contextCompaction: cloneForkCompaction(source.contextCompaction) }
      : {}),
    externalSessionId: undefined,
    createdAt: options.now,
    updatedAt: options.now,
  };
}

function isCompletedAssistantResponse(message: ChatMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  if (message.errorInfo || message.statusText || message.pendingApproval?.status === 'pending') {
    return false;
  }
  if (
    message.executionStatus !== undefined
    && message.executionStatus !== 'completed'
  ) {
    return false;
  }

  return Boolean(
    message.content.trim()
    || message.thinking?.trim()
    || message.agentActivities?.length
    || message.usage
    || message.executionStatus === 'completed'
  );
}

function isTurnEndingAssistant(messages: readonly ChatMessage[], index: number): boolean {
  if (!isCompletedAssistantResponse(messages[index])) return false;
  const next = messages[index + 1];
  return next === undefined || next.role === 'user';
}

function isRetainedPrefixSafe(session: AISession, boundary: number): boolean {
  if (!Number.isInteger(boundary) || boundary <= 0 || boundary > session.messages.length) {
    return false;
  }
  if (!isTurnEndingAssistant(session.messages, boundary - 1)) return false;
  if (!isCompactionCoveredByBoundary(session.contextCompaction, boundary)) return false;
  return !hasUnresolvedToolCalls(session.messages.slice(0, boundary));
}

function isCompactionCoveredByBoundary(
  contextCompaction: AISessionContextCompaction | undefined,
  boundary: number,
): boolean {
  if (!contextCompaction) return true;
  const compactedMessageCount = contextCompaction.compactedMessageCount;
  return Boolean(
    contextCompaction.summary.trim()
    && Number.isInteger(compactedMessageCount)
    && compactedMessageCount >= 0
    && compactedMessageCount <= boundary
  );
}

function cloneForkMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    content: stripOutputHandleText(message.content),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map(cloneForkToolCall) } : {}),
    ...(message.toolResults ? { toolResults: message.toolResults.map(cloneForkToolResult) } : {}),
  };
}

function cloneForkToolCall(toolCall: ToolCall): ToolCall {
  return {
    ...toolCall,
    arguments: stripOutputHandleValue(toolCall.arguments) as Record<string, unknown>,
  };
}

function cloneForkToolResult(toolResult: ToolResult): ToolResult {
  return { ...toolResult, content: stripOutputHandleText(toolResult.content) };
}

function cloneForkCompaction(
  contextCompaction: AISessionContextCompaction,
): AISessionContextCompaction {
  return { ...contextCompaction, summary: stripOutputHandleText(contextCompaction.summary) };
}

function stripOutputHandleText(value: string): string {
  if (!value.includes('tool-output-')) return value;
  return value
    .replace(OUTPUT_HANDLE_ASSIGNMENT_RE, REMOVED_OUTPUT_HANDLE_NOTICE)
    .replace(OUTPUT_HANDLE_ID_RE, REMOVED_OUTPUT_HANDLE_NOTICE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripOutputHandleValue(value: unknown): unknown {
  if (typeof value === 'string') return stripOutputHandleText(value);
  if (Array.isArray(value)) return value.map(stripOutputHandleValue);
  if (!isRecord(value)) return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    // A dead handle argument would make the replayed call look resolvable.
    if (key === 'handleId' && typeof entry === 'string' && OUTPUT_HANDLE_ID_TEST_RE.test(entry)) {
      continue;
    }
    sanitized[key] = stripOutputHandleValue(entry);
  }
  return sanitized;
}
