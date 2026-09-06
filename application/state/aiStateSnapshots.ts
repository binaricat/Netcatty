import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import {
  STORAGE_KEY_AI_ACTIVE_SESSION_MAP,
  STORAGE_KEY_AI_SESSIONS,
} from '../../infrastructure/config/storageKeys';
import type {
  AIDraft,
  AIPanelView,
  AISession,
  AIPermissionMode,
  AIToolIntegrationMode,
  ChatMessageAttachment,
} from '../../infrastructure/ai/types';
import type { ProviderContinuationOptions } from '../../infrastructure/ai/providerContinuation';
import { findSafeChatMessageCompactionSplitIndex } from '../../infrastructure/ai/contextCompaction';
import {
  bumpDraftMutationVersionState,
  bumpDraftUploadGenerationState,
  getDraftUploadGenerationState,
} from './aiDraftState';
import {
  pruneInactiveScopedSessions,
  pruneInactiveScopedTransientState,
} from './aiScopeCleanup';
import { emitAIStateChanged } from './aiStateEvents';
import { getAgentRuntime } from '../../infrastructure/ai/harness/globalAgentRuntime';

/** Typed accessor for the Electron IPC bridge exposed on `window.netcatty`. */
export interface AIBridge {
  aiSdkAgentCleanup?: (chatSessionId: string) => Promise<{ ok: boolean }>;
  deleteChatToolOutputsTemp?: (chatSessionId: string) => Promise<{ deletedCount: number }>;
  deleteTerminalToolOutputsEverywhereTemp?: (terminalSessionId: string) => Promise<{ deletedCount: number }>;
  aiMcpSetPermissionMode?: (mode: AIPermissionMode) => Promise<unknown> | unknown;
  aiMcpSetToolIntegrationMode?: (mode: AIToolIntegrationMode) => Promise<unknown> | unknown;
  aiMcpSetCommandBlocklist?: (blocklist: string[]) => Promise<unknown> | unknown;
  aiMcpSetCommandTimeout?: (timeout: number) => Promise<unknown> | unknown;
  aiMcpSetMaxIterations?: (maxIterations: number) => Promise<unknown> | unknown;
}

export function getAIBridge() {
  return (window as unknown as { netcatty?: AIBridge }).netcatty;
}


export const AI_STATE_CHANGED_DRAFTS_BY_SCOPE = 'netcatty:ai-drafts-by-scope';
export const AI_STATE_CHANGED_PANEL_VIEW_BY_SCOPE = 'netcatty:ai-panel-view-by-scope';

export type DraftsByScope = Partial<Record<string, AIDraft>>;
export type PanelViewByScope = Partial<Record<string, AIPanelView>>;

export function cleanupSdkAgentSessions(sessionIds: string[]) {
  const bridge = getAIBridge();
  if (sessionIds.length === 0) return;
  for (const sessionId of sessionIds) {
    void bridge?.aiSdkAgentCleanup?.(sessionId).catch(() => {});
  }
}

export function cleanupDeletedAIChatSessions(sessionIds: string[]) {
  const bridge = getAIBridge();
  if (sessionIds.length === 0) return;
  for (const sessionId of sessionIds) {
    getAgentRuntime().clearChatSession(sessionId);
    void bridge?.aiSdkAgentCleanup?.(sessionId).catch(() => {});
    void bridge?.deleteChatToolOutputsTemp?.(sessionId).catch(() => {});
  }
}

export function cleanupClosedTerminalSessions(terminalSessionIds: string[]) {
  const bridge = getAIBridge();
  for (const terminalSessionId of new Set(terminalSessionIds)) {
    getAgentRuntime().clearTerminalSession(terminalSessionId);
    void bridge?.deleteTerminalToolOutputsEverywhereTemp?.(terminalSessionId).catch(() => {});
  }
}

function isScopeKeyActive(scopeKey: string, activeTargetIds: Set<string>) {
  const separatorIndex = scopeKey.indexOf(':');
  if (separatorIndex === -1) return true;

  const targetId = scopeKey.slice(separatorIndex + 1);
  if (!targetId) return true;

  return activeTargetIds.has(targetId);
}

export function cleanupOrphanedAISessions(activeTargetIds: Set<string>) {
  const currentSessions = latestAISessionsSnapshot
    ?? localStorageAdapter.read<AISession[]>(STORAGE_KEY_AI_SESSIONS)
    ?? [];

  // Sessions shown by a still-live scope must be protected from cleanup
  // even when their own `scope.targetId` points at a closed terminal —
  // history can be resumed into a different terminal and we must not
  // delete it outright while it's actively being used.
  const preCleanupActiveSessionMap = latestAIActiveSessionMapSnapshot
    ?? localStorageAdapter.read<Record<string, string | null>>(STORAGE_KEY_AI_ACTIVE_SESSION_MAP)
    ?? {};
  const activeSessionIds = new Set<string>();
  for (const [scopeKey, sessionId] of Object.entries(preCleanupActiveSessionMap)) {
    if (!sessionId) continue;
    if (!isScopeKeyActive(scopeKey, activeTargetIds)) continue;
    activeSessionIds.add(sessionId);
  }

  const nextSessionCleanup = pruneInactiveScopedSessions(
    currentSessions,
    activeTargetIds,
    activeSessionIds,
  );

  if (nextSessionCleanup.orphanedSessionIds.length > 0) {
    cleanupSdkAgentSessions(nextSessionCleanup.orphanedSessionIds);
  }

  if (nextSessionCleanup.sessions !== currentSessions) {
    setLatestAISessionsSnapshot(nextSessionCleanup.sessions);
    writeSessionsForStorage(nextSessionCleanup.sessions);
    emitAIStateChanged(STORAGE_KEY_AI_SESSIONS);
  }

  const activeSessionIdMap = preCleanupActiveSessionMap;
  let activeSessionMapChanged = false;
  const nextActiveSessionIdMap = { ...activeSessionIdMap };

  for (const scopeKey of Object.keys(activeSessionIdMap)) {
    if (isScopeKeyActive(scopeKey, activeTargetIds)) continue;
    delete nextActiveSessionIdMap[scopeKey];
    activeSessionMapChanged = true;
  }

  if (activeSessionMapChanged) {
    setLatestAIActiveSessionMapSnapshot(nextActiveSessionIdMap);
    localStorageAdapter.write(STORAGE_KEY_AI_ACTIVE_SESSION_MAP, nextActiveSessionIdMap);
    emitAIStateChanged(STORAGE_KEY_AI_ACTIVE_SESSION_MAP);
  }

  const currentActiveSessionIdMap = activeSessionMapChanged
    ? nextActiveSessionIdMap
    : activeSessionIdMap;
  const currentDraftsByScope = latestAIDraftsByScopeSnapshot ?? {};
  const currentPanelViewByScope = latestAIPanelViewByScopeSnapshot ?? {};
  const prunedScopedTransientState = pruneInactiveScopedTransientState(
    currentActiveSessionIdMap,
    currentDraftsByScope,
    currentPanelViewByScope,
    activeTargetIds,
  );

  if (prunedScopedTransientState.activeSessionIdMap !== currentActiveSessionIdMap) {
    setLatestAIActiveSessionMapSnapshot(prunedScopedTransientState.activeSessionIdMap);
    localStorageAdapter.write(
      STORAGE_KEY_AI_ACTIVE_SESSION_MAP,
      prunedScopedTransientState.activeSessionIdMap,
    );
    emitAIStateChanged(STORAGE_KEY_AI_ACTIVE_SESSION_MAP);
  }

  if (prunedScopedTransientState.draftsByScope !== currentDraftsByScope) {
    for (const scopeKey of Object.keys(currentDraftsByScope)) {
      if (scopeKey in prunedScopedTransientState.draftsByScope) continue;
      bumpDraftMutationVersion(scopeKey);
      bumpDraftUploadGeneration(scopeKey);
    }
    setLatestAIDraftsByScopeSnapshot(prunedScopedTransientState.draftsByScope);
    emitAIStateChanged(AI_STATE_CHANGED_DRAFTS_BY_SCOPE);
  }

  if (prunedScopedTransientState.panelViewByScope !== currentPanelViewByScope) {
    for (const scopeKey of Object.keys(currentPanelViewByScope)) {
      if (scopeKey in prunedScopedTransientState.panelViewByScope) continue;
      bumpDraftMutationVersion(scopeKey);
    }
    setLatestAIPanelViewByScopeSnapshot(prunedScopedTransientState.panelViewByScope);
    emitAIStateChanged(AI_STATE_CHANGED_PANEL_VIEW_BY_SCOPE);
  }
}


/** Maximum number of sessions to keep in localStorage. */
const MAX_STORED_SESSIONS = 50;
/** Maximum number of messages per session when persisting to localStorage. */
const MAX_SESSION_MESSAGES = 200;
/**
 * Byte budget for the serialized sessions JSON. The localStorage quota is
 * ~5-10 MB across all keys, and Responses reasoning ciphertext can add tens
 * of KB per turn, so keep the sessions blob well under the quota with
 * headroom for the rest of the app's storage keys.
 */
const MAX_SESSIONS_JSON_BYTES = 2 * 1024 * 1024;
/** Retry budgets used when the primary budget still fails to persist. */
const RETRY_SESSIONS_JSON_BYTES = [
  1024 * 1024,
  512 * 1024,
  256 * 1024,
  128 * 1024,
] as const;

/**
 * Remove `reasoningEncryptedContent` ciphertext from a message's persisted
 * continuation. The ciphertext exists so stateless Responses turns can replay
 * prior reasoning items; it is also by far the largest per-message payload.
 * When storage pressure forces it, dropping the ciphertext keeps the visible
 * conversation intact at the cost of reasoning replay for affected messages.
 */
function stripReasoningEncryptedContent(
  options: ProviderContinuationOptions,
): ProviderContinuationOptions | undefined {
  const hasCiphertext = Object.values(options).some(
    providerOptions => typeof providerOptions?.reasoningEncryptedContent === 'string',
  );
  if (!hasCiphertext) return options;
  const stripped: ProviderContinuationOptions = {};
  for (const [provider, providerOptions] of Object.entries(options)) {
    const rest = { ...providerOptions };
    delete rest.reasoningEncryptedContent;
    if (Object.keys(rest).length) stripped[provider] = rest;
  }
  return Object.keys(stripped).length ? stripped : undefined;
}

function stripEncryptedReasoningFromMessage(message: AISession['messages'][number]) {
  const continuation = message.providerContinuation;
  if (!continuation?.reasoningParts) return message;
  let changed = false;
  const parts = continuation.reasoningParts.map(part => {
    if (!part.providerOptions) return part;
    const providerOptions = stripReasoningEncryptedContent(part.providerOptions);
    if (providerOptions === part.providerOptions) return part;
    changed = true;
    return providerOptions ? { text: part.text, providerOptions } : { text: part.text };
  });
  if (!changed) return message;
  return {
    ...message,
    providerContinuation: {
      ...continuation,
      reasoningParts: parts,
    },
  };
}

function stripEncryptedReasoningFromSession(session: AISession): AISession {
  let changed = false;
  const messages = session.messages.map(message => {
    const stripped = stripEncryptedReasoningFromMessage(message);
    if (stripped !== message) changed = true;
    return stripped;
  });
  return changed ? { ...session, messages } : session;
}

function stripAttachmentBodies(
  attachments: ChatMessageAttachment[],
): ChatMessageAttachment[] {
  let changed = false;
  const next = attachments.map(attachment => {
    if (!attachment.base64Data) return attachment;
    changed = true;
    return {
      ...attachment,
      base64Data: '',
    };
  });
  return changed ? next : attachments;
}

/**
 * Replace an attachment's persisted base64 payload with a metadata-only stub.
 * Attachment bodies (vault-note inlines, files, legacy images) are by far the
 * largest per-message payload, and the aggregate draft budget only bounds a
 * single turn: each send persists its attachments on the session message, so
 * several large note-mention turns can push one session past every storage
 * retry budget. Dropping the bodies keeps the conversation — including the
 * attachment metadata — instead of leaving the whole chat memory-only after a
 * failed write; the in-memory state is untouched.
 */
function stripAttachmentBodiesFromMessage(message: AISession['messages'][number]) {
  const attachments = message.attachments
    ? stripAttachmentBodies(message.attachments)
    : undefined;
  const images = message.images
    ? stripAttachmentBodies(message.images)
    : undefined;
  if (attachments === message.attachments && images === message.images) return message;
  return {
    ...message,
    ...(attachments !== undefined ? { attachments } : {}),
    ...(images !== undefined ? { images } : {}),
  };
}

function stripAttachmentBodiesFromSession(session: AISession): AISession {
  let changed = false;
  const messages = session.messages.map(message => {
    const stripped = stripAttachmentBodiesFromMessage(message);
    if (stripped !== message) changed = true;
    return stripped;
  });
  return changed ? { ...session, messages } : session;
}

function stripCompactedEncryptedReasoningFromSession(session: AISession): AISession {
  const compactedMessageCount = Math.min(
    session.messages.length,
    Math.max(0, session.contextCompaction?.compactedMessageCount ?? 0),
  );
  if (compactedMessageCount === 0) return session;

  let changed = false;
  const messages = session.messages.map((message, index) => {
    if (index >= compactedMessageCount) return message;
    const stripped = stripEncryptedReasoningFromMessage(message);
    if (stripped !== message) changed = true;
    return stripped;
  });
  return changed ? { ...session, messages } : session;
}

/**
 * Prune sessions before writing to localStorage to prevent hitting the
 * ~5-10 MB storage quota. Only affects what is persisted — the in-memory
 * state retains all messages until the session is reloaded.
 *
 * - Keeps only the MAX_STORED_SESSIONS most-recently-updated sessions.
 * - Trims each session's messages to the last MAX_SESSION_MESSAGES.
 */
export function pruneSessionsForStorage(sessions: AISession[]): AISession[] {
  // Sort by updatedAt descending so we keep the newest
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const limited = sorted.slice(0, MAX_STORED_SESSIONS);
  return limited.map(s => {
    if (s.messages.length > MAX_SESSION_MESSAGES) {
      // Do not start the retained tail with a tool result whose assistant call
      // was just trimmed. Reuse the same tool-safe boundary logic as context
      // compaction, even if that retains a few more than the nominal cap.
      const removedMessageCount = findSafeChatMessageCompactionSplitIndex(
        s.messages,
        MAX_SESSION_MESSAGES,
      );
      const contextCompaction = s.contextCompaction
        ? {
            ...s.contextCompaction,
            compactedMessageCount: Math.max(
              0,
              s.contextCompaction.compactedMessageCount - removedMessageCount,
            ),
          }
        : undefined;
      return {
        ...s,
        messages: s.messages.slice(removedMessageCount),
        ...(contextCompaction ? { contextCompaction } : {}),
      };
    }
    return s;
  });
}

/**
 * Serialize sessions for localStorage under a byte budget, escalating pruning
 * as needed. Returns the JSON to persist plus the (possibly) further-pruned
 * sessions that JSON represents.
 */
export function serializeSessionsForStorage(
  sessions: AISession[],
  budgetBytes: number = MAX_SESSIONS_JSON_BYTES,
): { json: string; sessions: AISession[] } {
  const serialized = pruneSessionsForStorage(sessions).map(rawSession => {
    // These messages are replaced by the durable summary before every later
    // request, so their replay ciphertext can never be used again. Remove it
    // before deciding whether the newest session deserves full protection;
    // otherwise dead metadata can evict other visible conversations.
    const session = stripCompactedEncryptedReasoningFromSession(rawSession);
    const ciphertextMessages = session.messages.flatMap((message, index) => {
      const strippedMessage = stripEncryptedReasoningFromMessage(message);
      if (strippedMessage === message) return [];
      return [{
        index,
        strippedMessage,
        jsonLengthDelta: JSON.stringify(strippedMessage).length - JSON.stringify(message).length,
      }];
    });
    const strippedSession = stripEncryptedReasoningFromSession(session);
    const json = JSON.stringify(session);
    const attachmentStrippedMessages = session.messages.flatMap((message, index) => {
      const strippedMessage = stripAttachmentBodiesFromMessage(message);
      if (strippedMessage === message) return [];
      return [{
        index,
        strippedMessage,
        jsonLengthDelta: JSON.stringify(strippedMessage).length - JSON.stringify(message).length,
      }];
    });
    const strippedJson = strippedSession === session
      ? json
      : JSON.stringify(strippedSession);
    // Smallest representation this serializer can produce for the session
    // (replay ciphertext and attachment bodies removed). Retention below
    // must use this floor: a newest session carrying large attachment
    // bodies can still deserve to keep older visible history once the
    // attachment fallback strips those bodies, even though its full or
    // ciphertext-stripped representations alone exceed the budget.
    const minimalSession = stripAttachmentBodiesFromSession(strippedSession);
    const minimalJson = minimalSession === strippedSession
      ? strippedJson
      : JSON.stringify(minimalSession);
    return {
      session,
      json,
      strippedSession,
      strippedJson,
      minimalJson,
      ciphertextMessages,
      attachmentStrippedMessages,
    };
  });

  // Preserve the newest session's full continuation whenever it can fit by
  // itself. That session is the one the user is most likely continuing now;
  // older visible history must not make its next tool turn unreplayable.
  const protectNewestContinuation = serialized.length > 0
    && serialized[0].json.length + 2 <= budgetBytes;

  // Determine how many sessions can fit using the smallest representation for
  // older sessions while reserving the newest session's full representation
  // when possible. This also prevents an old, oversized visible chat that must
  // be dropped anyway from causing newer replay ciphertext to be stripped.
  // The per-session floor is its fully stripped representation, so a newest
  // chat with oversized attachment bodies is retained at its metadata-only
  // size and the attachment fallback below prunes those bodies instead of
  // evicting older history that would otherwise still fit.
  let minimalLength = 2
    + serialized.reduce((total, entry, index) => (
      total + (protectNewestContinuation && index === 0 ? entry.json.length : entry.minimalJson.length)
    ), 0)
    + Math.max(0, serialized.length - 1);
  while (minimalLength > budgetBytes && serialized.length > 1) {
    const removed = serialized.pop();
    if (!removed) break;
    minimalLength -= removed.minimalJson.length + 1;
  }

  // Then keep full continuation data for the retained sessions and remove
  // replay-only ciphertext from the oldest retained sessions only as needed,
  // never touching the protected newest session. Within one session, remove
  // it one message at a time from oldest to newest so a long active chat can
  // retain its most recent replayable tool exchange when that still fits.
  let jsonLength = 2 + serialized.reduce((total, entry) => total + entry.json.length, 0)
    + Math.max(0, serialized.length - 1);
  const firstStrippableIndex = protectNewestContinuation ? 1 : 0;
  for (
    let index = serialized.length - 1;
    index >= firstStrippableIndex && jsonLength > budgetBytes;
    index -= 1
  ) {
    const current = serialized[index];
    let strippedMessageCount = 0;
    while (jsonLength > budgetBytes && strippedMessageCount < current.ciphertextMessages.length) {
      jsonLength += current.ciphertextMessages[strippedMessageCount].jsonLengthDelta;
      strippedMessageCount += 1;
    }
    if (strippedMessageCount > 0) {
      const strippedMessagesByIndex = new Map(
        current.ciphertextMessages
          .slice(0, strippedMessageCount)
          .map(entry => [entry.index, entry.strippedMessage] as const),
      );
      const nextSession = {
        ...current.session,
        messages: current.session.messages.map((message, messageIndex) => (
          strippedMessagesByIndex.get(messageIndex) ?? message
        )),
      };
      const nextJson = JSON.stringify(nextSession);
      const projectedJsonLength = current.json.length
        + current.ciphertextMessages
          .slice(0, strippedMessageCount)
          .reduce((total, entry) => total + entry.jsonLengthDelta, 0);
      jsonLength += nextJson.length - projectedJsonLength;
      serialized[index] = {
        ...current,
        session: nextSession,
        json: nextJson,
      };
    }
  }

  // Last resort when even the ciphertext budget failed: prune persisted
  // attachment payloads oldest-first, including from the newest session.
  // The aggregate attachment budget only bounds a single draft, so every
  // sent turn keeps its attachment bodies on the session message and a chat
  // with several large note mentions can outgrow every retry budget —
  // without this fallback the newest chat fails to persist entirely and
  // disappears on restart. Oldest messages lose their bodies first so the
  // most recent turns keep theirs whenever possible.
  for (let index = serialized.length - 1; index >= 0; index -= 1) {
    if (jsonLength <= budgetBytes) break;
    const current = serialized[index];
    let strippedAttachmentCount = 0;
    while (
      jsonLength > budgetBytes
      && strippedAttachmentCount < current.attachmentStrippedMessages.length
    ) {
      jsonLength += current.attachmentStrippedMessages[strippedAttachmentCount].jsonLengthDelta;
      strippedAttachmentCount += 1;
    }
    if (strippedAttachmentCount > 0) {
      const strippedMessagesByIndex = new Map(
        current.attachmentStrippedMessages
          .slice(0, strippedAttachmentCount)
          .map(entry => [entry.index, entry.strippedMessage] as const),
      );
      const nextSession = {
        ...current.session,
        messages: current.session.messages.map((message, messageIndex) => (
          strippedMessagesByIndex.get(messageIndex) ?? message
        )),
      };
      const nextJson = JSON.stringify(nextSession);
      const projectedJsonLength = current.json.length
        + current.attachmentStrippedMessages
          .slice(0, strippedAttachmentCount)
          .reduce((total, entry) => total + entry.jsonLengthDelta, 0);
      jsonLength += nextJson.length - projectedJsonLength;
      serialized[index] = {
        ...current,
        session: nextSession,
        json: nextJson,
      };
    }
  }

  return {
    json: `[${serialized.map(entry => entry.json).join(',')}]`,
    sessions: serialized.map(entry => entry.session),
  };
}

/**
 * Persist sessions to localStorage with byte-budgeted pruning and retries.
 * Returns true when the write succeeded; a false result means the payload
 * could not be persisted even after escalation (it stays memory-only).
 */
export function writeSessionsForStorage(sessions: AISession[]): boolean {
  let previousLength = Number.POSITIVE_INFINITY;
  for (const configuredBudget of [MAX_SESSIONS_JSON_BYTES, ...RETRY_SESSIONS_JSON_BYTES]) {
    // A real quota failure means the next attempt must be smaller even when
    // the failed payload was already below the nominal retry budget. Reduce
    // materially on each bounded retry so several small sessions can be
    // removed before the retry sequence is exhausted.
    const reducedBudget = Number.isFinite(previousLength)
      ? Math.floor(previousLength * 0.75)
      : configuredBudget;
    const budget = Math.min(configuredBudget, reducedBudget);
    if (budget < 2) break;
    const candidate = serializeSessionsForStorage(sessions, budget);
    if (candidate.json.length >= previousLength) continue;
    if (localStorageAdapter.writeString(STORAGE_KEY_AI_SESSIONS, candidate.json)) return true;
    previousLength = candidate.json.length;
  }
  // Last resort: attempt the smallest representation this serializer can
  // produce (the newest session with replay-only ciphertext removed). A very
  // small amount of shared quota may still be enough to preserve that chat.
  const minimalCandidate = serializeSessionsForStorage(sessions, 0);
  if (
    minimalCandidate.json.length < previousLength
    && localStorageAdapter.writeString(STORAGE_KEY_AI_SESSIONS, minimalCandidate.json)
  ) {
    return true;
  }
  console.warn(
    '[AIState] Failed to persist AI sessions within the storage quota; recent chat history may not survive a restart.',
  );
  return false;
}

export let latestAISessionsSnapshot: AISession[] | null = null;
export let latestAIActiveSessionMapSnapshot: Record<string, string | null> | null = null;
export let latestAIDraftsByScopeSnapshot: DraftsByScope | null = null;
export let latestAIPanelViewByScopeSnapshot: PanelViewByScope | null = null;
let latestAIDraftMutationVersionByScopeSnapshot: Record<string, number> = {};
let latestAIDraftUploadGenerationByScopeSnapshot: Record<string, number> = {};

export function setLatestAISessionsSnapshot(sessions: AISession[]) {
  latestAISessionsSnapshot = sessions;
}

export function setLatestAIActiveSessionMapSnapshot(activeSessionIdMap: Record<string, string | null>) {
  latestAIActiveSessionMapSnapshot = activeSessionIdMap;
}

export function prewarmAIStateStorageSnapshots() {
  try {
    if (latestAISessionsSnapshot === null) {
      latestAISessionsSnapshot =
        localStorageAdapter.read<AISession[]>(STORAGE_KEY_AI_SESSIONS) ?? [];
    }
    if (latestAIActiveSessionMapSnapshot === null) {
      latestAIActiveSessionMapSnapshot =
        localStorageAdapter.read<Record<string, string | null>>(STORAGE_KEY_AI_ACTIVE_SESSION_MAP) ?? {};
    }
  } catch (error) {
    console.warn('[AIState] Failed to prewarm AI state storage snapshots:', error);
  }
}

export function setLatestAIDraftsByScopeSnapshot(draftsByScope: DraftsByScope) {
  latestAIDraftsByScopeSnapshot = draftsByScope;
}

export function setLatestAIPanelViewByScopeSnapshot(panelViewByScope: PanelViewByScope) {
  latestAIPanelViewByScopeSnapshot = panelViewByScope;
}

export function bumpDraftMutationVersion(scopeKey: string) {
  latestAIDraftMutationVersionByScopeSnapshot = bumpDraftMutationVersionState(
    latestAIDraftMutationVersionByScopeSnapshot,
    scopeKey,
  );
}

export function getDraftUploadGeneration(scopeKey: string) {
  return getDraftUploadGenerationState(
    latestAIDraftUploadGenerationByScopeSnapshot,
    scopeKey,
  );
}

export function bumpDraftUploadGeneration(scopeKey: string) {
  latestAIDraftUploadGenerationByScopeSnapshot = bumpDraftUploadGenerationState(
    latestAIDraftUploadGenerationByScopeSnapshot,
    scopeKey,
  );
}
