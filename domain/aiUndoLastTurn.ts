import type {
  AISession,
  AISessionContextCompaction,
  ChatMessage,
  ChatMessageAttachment,
  UploadedFile,
} from '../infrastructure/ai/types';

/** Matches the `handleId=tool-output-…` references embedded in stored output. */
const TOOL_OUTPUT_HANDLE_ID_PATTERN = /\bhandleId=(tool-output-[A-Za-z0-9-]+)/g;
/** Matches the handle ids inside JSON-serialized tool-call arguments. */
const TOOL_OUTPUT_HANDLE_ID_JSON_PATTERN = /"handleId"\s*:\s*"(tool-output-[A-Za-z0-9-]+)"/g;

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
    for (const match of text.matchAll(TOOL_OUTPUT_HANDLE_ID_JSON_PATTERN)) {
      ids.add(match[1]);
    }
  };
  for (const message of messages) {
    scan(message.content);
    // A tool call's arguments can be the only surviving reference to a saved
    // output: for example a failed `tool_output_read` whose error result does
    // not echo the requested handle id.
    for (const call of message.toolCalls ?? []) {
      scan(JSON.stringify(call.arguments));
    }
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
  selectedUserSkillSlugs: string[];
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
  // Providers may reuse tool-call IDs across a session. Pair each result with
  // the nearest preceding unresolved call carrying the same ID (same strategy
  // as `repairToolMessageIntegrity`), otherwise a result for an earlier
  // occurrence would satisfy a later call that reused the ID.
  const pendingCalls = new Map<string, number>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      pendingCalls.set(call.id, (pendingCalls.get(call.id) ?? 0) + 1);
    }
    for (const result of message.toolResults ?? []) {
      const pending = pendingCalls.get(result.toolCallId) ?? 0;
      if (pending > 0) pendingCalls.set(result.toolCallId, pending - 1);
    }
  }
  for (const pending of pendingCalls.values()) {
    if (pending > 0) return true;
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
  const retainedPrefix = source.messages.slice(0, boundary);
  // When undo removes the first turn, the branch has no user message left and
  // still carries the source title, which was auto-titled from the removed
  // prompt. Reset it to the untitled placeholder so `autoTitleSession` can
  // retitle the branch from the prompt the user sends next; otherwise the
  // branch is permanently labeled with text that is no longer its prompt.
  // A retained user turn can legitimately carry empty text: a note-only send
  // leaves `content` blank while the mentioned note rides on the attachment
  // (and its title) — that turn still anchored the conversation, so it must
  // keep the note-derived title and suppress the reset.
  const hasRetainedUserMessage = retainedPrefix.some(
    message => message.role === 'user',
  );
  const branchedSession: AISession = {
    ...source,
    id: options.newId,
    messages: retainedPrefix,
    ...(hasRetainedUserMessage ? {} : { title: 'New Chat' }),
    externalSessionId: undefined,
    createdAt: options.now,
    updatedAt: options.now,
  };
  return {
    session: branchedSession,
    restored: {
      text: removedUserMessage.content,
      attachments: buildRestoredAttachments(removedUserMessage, options.now),
      // The undone turn was selected with these skill pills: they shaped the
      // model context, so resending the turn must not silently omit them.
      selectedUserSkillSlugs: [...(removedUserMessage.selectedUserSkillSlugs ?? [])],
    },
  };
}
