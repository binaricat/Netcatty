/**
 * Pure planning logic for "Fork from here": copy an AI chat session up to a
 * completed assistant response into a new session, leaving the original
 * conversation untouched in history.
 *
 * Refusals (per the feature contract):
 * - only completed assistant-response turn boundaries fork — streaming, failed,
 *   cancelled, or in-progress turns are rejected,
 * - every tool call in the retained prefix must have a paired result and
 *   vice versa (no dangling calls or results on the branch),
 * - a stored compaction summary that would cover messages discarded by the
 *   branch is refused (the summary must stay accurate for the fork),
 * - incomplete-turn state (status text, pending approvals) is stripped while
 *   the per-message provider replay metadata is preserved, so the fresh
 *   provider thread replays the retained history.
 */

export type ForkRefusalReason =
  | 'message-not-found'
  | 'not-assistant'
  | 'not-completed'
  | 'dangling-tool-call'
  | 'dangling-tool-result'
  | 'compaction-covers-discarded';

/** A message type that carries the fork-relevant subset (e.g. ChatMessage). */
export type ForkMessageLike = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  thinking?: string;
  providerContinuation?: unknown;
  toolCalls?: ReadonlyArray<{ id: string }>;
  toolResults?: ReadonlyArray<{ toolCallId: string; content?: string; isError?: boolean }>;
  errorInfo?: unknown;
  statusText?: string;
  pendingApproval?: unknown;
  executionStatus?: string;
};

/** Structural subset of ChatMessage the fork planner needs. */
export type ForkMessage = ForkMessageLike & { timestamp?: number };

export type ForkPlan<M extends ForkMessageLike = ForkMessage> =
  | {
    ok: true;
    boundaryIndex: number;
    title: string;
    messages: M[];
    contextCompaction?: ForkContextCompaction;
  }
  | { ok: false; reason: ForkRefusalReason };

export type ForkContextCompaction = {
  summary: string;
  compactedMessageCount: number;
};

const INCOMPLETE_EXECUTION_STATUSES = new Set([
  'pending',
  'running',
  'failed',
  'cancelled',
]);

/**
 * Validate that every tool call in the retained prefix is paired with a
 * result and vice versa. Providers may reuse a tool-call id across turns, so
 * each result is consumed by the nearest preceding unresolved call with the
 * same id (same pairing rule as buildHistoricalToolReplayMaps): a result with
 * no pending call before it is dangling, and so is a call still pending after
 * the walk.
 */
function validateToolCallResultPairing(
  messages: readonly ForkMessageLike[],
): 'dangling-tool-call' | 'dangling-tool-result' | null {
  const pendingCallCounts = new Map<string, number>();
  for (const message of messages) {
    for (const toolCall of message.toolCalls ?? []) {
      if (!toolCall?.id) continue;
      pendingCallCounts.set(toolCall.id, (pendingCallCounts.get(toolCall.id) ?? 0) + 1);
    }
    for (const toolResult of message.toolResults ?? []) {
      const id = toolResult?.toolCallId;
      if (!id) continue;
      const pendingCount = pendingCallCounts.get(id) ?? 0;
      if (pendingCount === 0) return 'dangling-tool-result';
      pendingCallCounts.set(id, pendingCount - 1);
    }
  }
  for (const pendingCount of pendingCallCounts.values()) {
    if (pendingCount > 0) return 'dangling-tool-call';
  }
  return null;
}

/**
 * Strip incomplete-turn state so the branch starts clean; per-message provider
 * continuation metadata (Responses reasoning items, OpenAI Chat assistant
 * fields, tool-call wire options) is preserved because the fork's fresh
 * provider thread replays the retained history through it and safely discards
 * exchanges whose metadata no longer matches the active provider.
 */
export function stripMessageContinuationState<M extends ForkMessageLike>(message: M): M {
  if (
    message.statusText == null
    && message.pendingApproval == null
  ) {
    return message;
  }
  const next = { ...message };
  delete (next as Record<string, unknown>).statusText;
  delete (next as Record<string, unknown>).pendingApproval;
  return next;
}

export function buildForkTitle(title: string): string {
  const base = (title ?? '').trim() || 'New Chat';
  return base.endsWith('(fork)') ? base : `${base} (fork)`;
}

/** Structural subset of AISession the fork planner needs. */
export type ForkSourceSession<M extends ForkMessageLike = ForkMessage> = {
  title: string;
  messages: readonly M[];
  contextCompaction?: ForkContextCompaction;
};

/**
 * Plan a fork at `messageId`. Returns a refusal reason when the boundary is
 * not a safe completed turn, or the retained message list (trimmed of
 * incomplete-turn state, keeping provider replay metadata) plus the
 * carried-over compaction (when still accurate).
 */
export function planSessionFork<M extends ForkMessageLike>(
  source: ForkSourceSession<M>,
  messageId: string,
): ForkPlan<M> {
  const boundaryIndex = source.messages.findIndex(
    (message) => message.id === messageId,
  );
  if (boundaryIndex === -1) return { ok: false, reason: 'message-not-found' };
  const boundary = source.messages[boundaryIndex];
  if (boundary.role !== 'assistant') return { ok: false, reason: 'not-assistant' };
  if (
    boundary.errorInfo != null
    || boundary.statusText != null
    || boundary.pendingApproval != null
    || (boundary.executionStatus != null
      && INCOMPLETE_EXECUTION_STATUSES.has(boundary.executionStatus))
  ) {
    return { ok: false, reason: 'not-completed' };
  }

  const retained = source.messages.slice(0, boundaryIndex + 1);

  const pairingRefusal = validateToolCallResultPairing(retained);
  if (pairingRefusal) return { ok: false, reason: pairingRefusal };

  // A stored compaction summary covers the earliest `compactedMessageCount`
  // persisted messages. The summary must never cover messages discarded by
  // the branch, so refuse when its coverage would exceed the retained prefix.
  const compaction = source.contextCompaction;
  let nextCompaction: ForkContextCompaction | undefined;
  if (compaction) {
    if (compaction.compactedMessageCount > retained.length) {
      return { ok: false, reason: 'compaction-covers-discarded' };
    }
    nextCompaction = {
      summary: compaction.summary,
      compactedMessageCount: compaction.compactedMessageCount,
    };
  }

  return {
    ok: true,
    boundaryIndex,
    title: buildForkTitle(source.title),
    messages: retained.map(stripMessageContinuationState),
    ...(nextCompaction ? { contextCompaction: nextCompaction } : {}),
  } as ForkPlan<M>;
}

export function canForkFromMessage(
  source: {
    messages: readonly ForkMessageLike[];
    contextCompaction?: ForkContextCompaction;
  },
  messageId: string,
): boolean {
  // Only boundary validity matters here; the title is irrelevant for a
  // boolean check so an empty placeholder is fine.
  return planSessionFork({ title: '', messages: source.messages, contextCompaction: source.contextCompaction }, messageId).ok;
}
