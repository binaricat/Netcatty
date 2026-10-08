import type {
  AISession,
  AISessionContextCompaction,
  ChatMessage,
  ToolCall,
  ToolResult,
} from '../infrastructure/ai/types';

export type AISessionBranchTarget =
  | { kind: 'after-turn'; assistantMessageId: string }
  | { kind: 'before-latest-turn' };

export type AISessionBranchUserDraft = Pick<
  ChatMessage,
  'content' | 'attachments' | 'images'
>;

export interface AISessionBranchBoundary {
  /** Number of source messages retained by the branch. */
  messageCount: number;
  /** Present when undoing the latest turn so its prompt can be restored. */
  userDraft?: AISessionBranchUserDraft;
}

const OUTPUT_HANDLE_ID = 'tool-output-[A-Za-z0-9-]+';
const OUTPUT_HANDLE_ASSIGNMENT_RE = new RegExp(`\\bhandleId\\s*=\\s*${OUTPUT_HANDLE_ID}`, 'g');
const OUTPUT_HANDLE_ID_RE = new RegExp(OUTPUT_HANDLE_ID, 'g');
const REMOVED_OUTPUT_HANDLE_NOTICE = '[output handle removed for branched session]';

function isCompletedAssistant(message: ChatMessage | undefined): message is ChatMessage {
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

function isAssistantAtTurnEnd(messages: readonly ChatMessage[], index: number): boolean {
  if (!isCompletedAssistant(messages[index])) return false;
  const next = messages[index + 1];
  return next === undefined || next.role === 'user';
}

/**
 * Validate persisted tool-call ordering without repairing it. Reused provider
 * call IDs pair with the nearest preceding unresolved call, matching replay.
 */
function hasCompleteToolExchanges(messages: readonly ChatMessage[]): boolean {
  const pendingById = new Map<string, number>();

  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (!call.id) return false;
      pendingById.set(call.id, (pendingById.get(call.id) ?? 0) + 1);
    }

    if (message.role === 'tool' && !message.toolResults?.length) return false;
    for (const result of message.toolResults ?? []) {
      const pending = pendingById.get(result.toolCallId) ?? 0;
      if (pending === 0) return false;
      if (pending === 1) pendingById.delete(result.toolCallId);
      else pendingById.set(result.toolCallId, pending - 1);
    }
  }

  return pendingById.size === 0;
}

function validCompactionForBoundary(
  contextCompaction: AISessionContextCompaction | undefined,
  sourceMessageCount: number,
  boundaryMessageCount: number,
): boolean {
  if (!contextCompaction) return true;
  const compactedMessageCount = contextCompaction.compactedMessageCount;
  return Boolean(
    contextCompaction.summary.trim()
    && Number.isInteger(compactedMessageCount)
    && compactedMessageCount >= 0
    && compactedMessageCount <= sourceMessageCount
    && compactedMessageCount <= boundaryMessageCount
  );
}

function hasValidCompactionToolBoundary(
  session: AISession,
  boundaryMessageCount: number,
): boolean {
  const compactedMessageCount = session.contextCompaction?.compactedMessageCount ?? 0;
  if (compactedMessageCount === 0) return true;
  return hasCompleteToolExchanges(
    session.messages.slice(0, Math.min(compactedMessageCount, boundaryMessageCount)),
  );
}

function isSafeBoundary(
  session: AISession,
  messageCount: number,
  allowEmpty: boolean,
): boolean {
  if (!Number.isInteger(messageCount) || messageCount < 0 || messageCount > session.messages.length) {
    return false;
  }
  if (!validCompactionForBoundary(
    session.contextCompaction,
    session.messages.length,
    messageCount,
  ) || !hasValidCompactionToolBoundary(session, messageCount)) {
    return false;
  }

  const retained = session.messages.slice(0, messageCount);
  if (!hasCompleteToolExchanges(retained)) return false;
  if (retained.length === 0) return allowEmpty;
  return isAssistantAtTurnEnd(session.messages, retained.length - 1);
}

function cloneUserDraft(message: ChatMessage): AISessionBranchUserDraft {
  const draft = sanitizeOutputHandles({
    content: message.content,
    ...(message.attachments ? { attachments: message.attachments } : {}),
    ...(message.images ? { images: message.images } : {}),
  }) as AISessionBranchUserDraft;
  return draft;
}

/**
 * Resolve a requested fork/undo point to a safe, exclusive message boundary.
 * Unsafe partial turns, dangling tool exchanges, and boundaries that would make
 * the persisted compaction summary include discarded messages are rejected.
 */
export function getBranchBoundary(
  session: AISession,
  target: AISessionBranchTarget,
): AISessionBranchBoundary | null {
  if (target.kind === 'after-turn') {
    const assistantIndex = session.messages.findIndex(
      message => message.id === target.assistantMessageId && message.role === 'assistant',
    );
    if (assistantIndex < 0 || !isAssistantAtTurnEnd(session.messages, assistantIndex)) {
      return null;
    }

    const messageCount = assistantIndex + 1;
    return isSafeBoundary(session, messageCount, false) ? { messageCount } : null;
  }

  const lastIndex = session.messages.length - 1;
  if (lastIndex < 0 || !isAssistantAtTurnEnd(session.messages, lastIndex)) return null;
  if (!isSafeBoundary(session, session.messages.length, false)) return null;

  let latestUserIndex = -1;
  for (let index = lastIndex - 1; index >= 0; index -= 1) {
    if (session.messages[index].role === 'user') {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return null;

  const latestUser = session.messages[latestUserIndex];
  if (!isSafeBoundary(session, latestUserIndex, latestUserIndex === 0)) return null;

  return {
    messageCount: latestUserIndex,
    userDraft: cloneUserDraft(latestUser),
  };
}

function sanitizeOutputHandleString(value: string): string {
  return value
    .replace(OUTPUT_HANDLE_ASSIGNMENT_RE, REMOVED_OUTPUT_HANDLE_NOTICE)
    .replace(OUTPUT_HANDLE_ID_RE, REMOVED_OUTPUT_HANDLE_NOTICE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeOutputHandles(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeOutputHandleString(value);
  if (Array.isArray(value)) return value.map(sanitizeOutputHandles);
  if (!isRecord(value)) return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'handleId' && typeof entry === 'string' && OUTPUT_HANDLE_ID_RE.test(entry)) {
      OUTPUT_HANDLE_ID_RE.lastIndex = 0;
      continue;
    }
    OUTPUT_HANDLE_ID_RE.lastIndex = 0;
    sanitized[key] = sanitizeOutputHandles(entry);
  }
  return sanitized;
}

interface BranchedMessageIds {
  messageId: string;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  pendingApprovalToolCallId?: string;
}

function cloneBranchMessage(
  message: ChatMessage,
  ids: BranchedMessageIds,
): ChatMessage {
  const { providerContinuation: _providerContinuation, ...portableMessage } = message;
  void _providerContinuation;
  const remapped = {
    ...portableMessage,
    id: ids.messageId,
    ...(message.toolCalls ? { toolCalls: ids.toolCalls } : {}),
    ...(message.toolResults ? { toolResults: ids.toolResults } : {}),
    ...(message.pendingApproval
      ? {
          pendingApproval: {
            ...message.pendingApproval,
            ...(ids.pendingApprovalToolCallId
              ? { toolCallId: ids.pendingApprovalToolCallId }
              : {}),
          },
        }
      : {}),
  };
  return sanitizeOutputHandles(remapped) as ChatMessage;
}

function defaultBranchId(now: number): string {
  return `ai_${now}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create an independent session at a boundary returned by getBranchBoundary.
 * Provider/session continuation state and source-session output handles cannot
 * safely cross into the new session, so they are deliberately omitted.
 */
export function createBranchedSession(
  source: AISession,
  boundary: AISessionBranchBoundary,
  now: number,
  createId: () => string = () => defaultBranchId(now),
): AISession {
  const allowEmpty = boundary.messageCount === 0;
  if (!isSafeBoundary(source, boundary.messageCount, allowEmpty)) {
    throw new Error('Cannot branch an AI session at an unsafe boundary.');
  }

  const retainedMessages = source.messages.slice(0, boundary.messageCount);
  const branchId = createId();
  const pendingCallIds = new Map<string, string[]>();
  const latestCallIds = new Map<string, string>();
  let toolCallIndex = 0;
  const idsByMessage = retainedMessages.map((message, messageIndex): BranchedMessageIds => {
    const toolCalls = (message.toolCalls ?? []).map(call => {
      const branchedCallId = `${branchId}_tool_${toolCallIndex++}`;
      const pending = pendingCallIds.get(call.id) ?? [];
      pending.push(branchedCallId);
      pendingCallIds.set(call.id, pending);
      latestCallIds.set(call.id, branchedCallId);
      return { ...call, id: branchedCallId };
    });
    const toolResults = (message.toolResults ?? []).map(result => {
      const pending = pendingCallIds.get(result.toolCallId);
      const branchedCallId = pending?.pop();
      if (pending?.length === 0) pendingCallIds.delete(result.toolCallId);
      return { ...result, toolCallId: branchedCallId ?? result.toolCallId };
    });
    const pendingApprovalSourceId = message.pendingApproval?.toolCallId;
    const pendingApprovalToolCallId = pendingApprovalSourceId
      ? latestCallIds.get(pendingApprovalSourceId)
      : undefined;
    return {
      messageId: `${branchId}_message_${messageIndex}`,
      toolCalls,
      toolResults,
      pendingApprovalToolCallId,
    };
  });
  const messages = retainedMessages.map((message, index) => (
    cloneBranchMessage(message, idsByMessage[index])
  ));

  return {
    id: branchId,
    title: source.title,
    agentId: source.agentId,
    scope: sanitizeOutputHandles(source.scope) as AISession['scope'],
    messages,
    ...(source.contextCompaction
      ? {
          contextCompaction: sanitizeOutputHandles(
            source.contextCompaction,
          ) as AISessionContextCompaction,
        }
      : {}),
    lineage: {
      parentSessionId: source.id,
      ...(retainedMessages.at(-1)
        ? { branchedFromMessageId: retainedMessages.at(-1)?.id }
        : {}),
    },
    createdAt: now,
    updatedAt: now,
  };
}
