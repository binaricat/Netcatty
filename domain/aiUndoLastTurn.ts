import type {
  AISession,
  AISessionContextCompaction,
  ChatMessage,
  ChatMessageAttachment,
  UploadedFile,
} from '../infrastructure/ai/types';

/** Matches the `handleId=tool-output-…` references embedded in stored output. */
const TOOL_OUTPUT_HANDLE_ID_PATTERN = /\bhandleId=(tool-output-[A-Za-z0-9-]+)/g;

/**
 * Collect the tool output handle ids referenced anywhere in the retained
 * conversation prefix plus its compaction artifacts. Used to restrict tool
 * output aliasing when a session is branched so handles belonging to the
 * removed turn are not advertised to the branch.
 */
export function collectRetainedToolOutputHandleIds(
  messages: readonly ChatMessage[],
  contextCompaction?: AISessionContextCompaction,
): Set<string> {
  const ids = new Set<string>();
  const scan = (text: string | undefined): void => {
    if (!text) return;
    for (const match of text.matchAll(TOOL_OUTPUT_HANDLE_ID_PATTERN)) {
      ids.add(match[1]);
    }
  };
  for (const message of messages) {
    scan(message.content);
    for (const result of message.toolResults ?? []) scan(result.content);
    for (const attachment of message.attachments ?? []) scan(attachment.previewText);
    for (const attachment of message.images ?? []) scan(attachment.previewText);
  }
  // The compaction summary embeds the archived conversation snapshot handle.
  scan(contextCompaction?.summary);
  return ids;
}

/**
 * Non-destructive "undo last turn" for AI chat sessions.
 *
 * Undo branches the conversation at the boundary *before* the latest user
 * message instead of truncating the original session. The original session
 * stays in history untouched; the branch (without the last turn) becomes the
 * conversation the user continues, and the undone user message is restored
 * into the composer for editing and resending.
 */

export interface UndoLastTurnRestoredDraft {
  text: string;
  attachments: UploadedFile[];
}

export interface UndoLastTurnResult {
  /** Branched copy of the source session without the last user turn. */
  session: AISession;
  /** Undone user message content for the composer. */
  restored: UndoLastTurnRestoredDraft;
}

/**
 * True when any assistant tool call in `messages` has no matching tool result
 * inside the same list. Cutting between a tool call and its result would
 * desync agent tool bookkeeping, so such boundaries are rejected.
 */
export function hasUnresolvedToolCalls(messages: readonly ChatMessage[]): boolean {
  const answered = new Set<string>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      answered.add(result.toolCallId);
    }
  }
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (!answered.has(call.id)) return true;
    }
  }
  return false;
}

/**
 * Index of the cut point for undoing the last turn (the last user message).
 * Returns null when undo is not offered:
 * - there is no user message at all,
 * - the boundary would fall inside the compacted prefix (its summary would no
 *   longer match the kept messages),
 * - cutting there would split an assistant tool call from its result.
 */
export function resolveUndoLastTurnBoundary(
  messages: readonly ChatMessage[],
  compactedMessageCount = 0,
): number | null {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) return null;
  if (lastUserIndex < compactedMessageCount) return null;
  const keptPrefix = messages.slice(0, lastUserIndex);
  if (hasUnresolvedToolCalls(keptPrefix)) return null;
  return lastUserIndex;
}

/** Map a persisted message attachment back to a composer upload (by value). */
export function buildRestoredAttachments(
  message: ChatMessage,
  now: number,
): UploadedFile[] {
  const attachments: ChatMessageAttachment[] = message.attachments ?? message.images ?? [];
  return attachments.map((attachment, index) => ({
    id: `undo_${now}_${index}`,
    filename: attachment.filename ?? '',
    mediaType: attachment.mediaType,
    base64Data: attachment.base64Data,
    dataUrl: attachment.base64Data
      ? `data:${attachment.mediaType};base64,${attachment.base64Data}`
      : '',
    ...(attachment.filePath !== undefined ? { filePath: attachment.filePath } : {}),
    ...(attachment.terminalSelection ? { terminalSelection: true } : {}),
    ...(attachment.vaultNoteId !== undefined ? { vaultNoteId: attachment.vaultNoteId } : {}),
    ...(attachment.vaultNoteTitle !== undefined ? { vaultNoteTitle: attachment.vaultNoteTitle } : {}),
    ...(attachment.previewText !== undefined ? { previewText: attachment.previewText } : {}),
    ...(attachment.lineCount !== undefined ? { lineCount: attachment.lineCount } : {}),
  }));
}

/**
 * Build the branched "undo last turn" copy of a session.
 *
 * The branch keeps the compacted prefix intact (its summary still describes
 * the kept messages) and drops the external agent session id: external agents
 * resume provider-side sessions, so the branch must start a fresh one.
 */
export function buildUndoLastTurnBranch(
  source: AISession,
  options: { newId: string; now: number },
): UndoLastTurnResult | null {
  const compactedMessageCount = source.contextCompaction?.compactedMessageCount ?? 0;
  const boundary = resolveUndoLastTurnBoundary(source.messages, compactedMessageCount);
  if (boundary == null) return null;

  const removedUserMessage = source.messages[boundary];
  const branchedSession: AISession = {
    ...source,
    id: options.newId,
    messages: source.messages.slice(0, boundary),
    externalSessionId: undefined,
    createdAt: options.now,
    updatedAt: options.now,
  };
  return {
    session: branchedSession,
    restored: {
      text: removedUserMessage.content,
      attachments: buildRestoredAttachments(removedUserMessage, options.now),
    },
  };
}
