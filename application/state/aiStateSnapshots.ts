import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import {
  STORAGE_KEY_AI_ACTIVE_SESSION_MAP,
  STORAGE_KEY_AI_SESSIONS,
  STORAGE_KEY_CLOUD_SYNC_AI_SESSIONS,
} from '../../infrastructure/config/storageKeys';
import type {
  AIDraft,
  AIPanelView,
  AISession,
  AIPermissionMode,
  AIToolIntegrationMode,
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

export async function cleanupSdkAgentSessions(sessionIds: string[]): Promise<void> {
  const bridge = getAIBridge();
  if (sessionIds.length === 0) return;
  await Promise.all(sessionIds.map((sessionId) => bridge?.aiSdkAgentCleanup?.(sessionId).catch(() => {})));
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
 * Maximum persisted length of a single tool result payload. Terminal tool
 * output can reach hundreds of KB per command, and AI-driven terminal work
 * accumulates many of them. When storage pressure forces degradation, shedding
 * this replay bulk keeps every visible conversation persisted instead of
 * evicting whole chats that happen to carry it.
 */
const MAX_PERSISTED_TOOL_RESULT_CHARS = 8 * 1024;

function truncatePersistedToolResultContent(content: string): string {
  if (content.length <= MAX_PERSISTED_TOOL_RESULT_CHARS) return content;
  // The marker consumes budget and must stay single-line: JSON-escaped
  // newlines would cost 2 characters each, letting a slightly-over-cap
  // result serialize at the same (or larger) size than the original — the
  // ladder assumes the degraded form is the smallest. Shrink the retained
  // head+tail until the whole persisted copy fits the cap.
  let half = Math.floor(MAX_PERSISTED_TOOL_RESULT_CHARS / 2);
  let omitted = content.length - 2 * half;
  let marker = `[Netcatty] persisted copy truncated; ${omitted} characters of tool output omitted`;
  while (2 * half + marker.length > MAX_PERSISTED_TOOL_RESULT_CHARS) {
    half -= Math.ceil((2 * half + marker.length - MAX_PERSISTED_TOOL_RESULT_CHARS) / 2);
    omitted = content.length - 2 * half;
    marker = `[Netcatty] persisted copy truncated; ${omitted} characters of tool output omitted`;
  }
  return `${content.slice(0, half)}${marker}${content.slice(content.length - half)}`;
}

/**
 * Remove `reasoningEncryptedContent` ciphertext from a message's persisted
 * continuation and shed bulk tool output. The ciphertext exists so stateless
 * Responses turns can replay prior reasoning items; tool output dominates
 * persisted size in AI-driven terminal chats. When storage pressure forces
 * it, shedding this bulk keeps the visible conversation intact at the cost of
 * reasoning replay and full tool output for affected messages.
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

function stripReasoningCiphertextFromMessage(message: AISession['messages'][number]) {
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

function stripEncryptedReasoningFromMessage(message: AISession['messages'][number]) {
  const strippedContinuationMessage = stripReasoningCiphertextFromMessage(message);
  const toolResults = strippedContinuationMessage.toolResults;
  if (!toolResults?.length) return strippedContinuationMessage;
  let toolResultsChanged = false;
  const nextToolResults = toolResults.map((result) => {
    const content = truncatePersistedToolResultContent(result.content);
    if (content === result.content) return result;
    toolResultsChanged = true;
    return { ...result, content };
  });
  return toolResultsChanged
    ? { ...strippedContinuationMessage, toolResults: nextToolResults }
    : strippedContinuationMessage;
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

function stripCompactedEncryptedReasoningFromSession(session: AISession): AISession {
  const compactedMessageCount = Math.min(
    session.messages.length,
    Math.max(0, session.contextCompaction?.compactedMessageCount ?? 0),
  );
  if (compactedMessageCount === 0) return session;

  let changed = false;
  const messages = session.messages.map((message, index) => {
    if (index >= compactedMessageCount) return message;
    const stripped = stripReasoningCiphertextFromMessage(message);
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
 *
 * Degradation ladder, cheapest loss first: strip replay ciphertext, shed bulk
 * tool output (kept at a bounded head+tail per result), and only then drop
 * oldest whole sessions. Evicting visible chats to preserve tool bulk is what
 * emptied history for users under storage pressure.
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
    const degradableMessages = session.messages.flatMap((message, index) => {
      const degradedMessage = stripEncryptedReasoningFromMessage(message);
      if (degradedMessage === message) return [];
      return [{
        index,
        degradedMessage,
        jsonLengthDelta: JSON.stringify(degradedMessage).length - JSON.stringify(message).length,
      }];
    });
    const strippedSession = stripEncryptedReasoningFromSession(session);
    const json = JSON.stringify(session);
    return {
      session,
      json,
      strippedSession,
      strippedJson: strippedSession === session
        ? json
        : JSON.stringify(strippedSession),
      degradableMessages,
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
  let minimalLength = 2
    + serialized.reduce((total, entry, index) => (
      total + (protectNewestContinuation && index === 0 ? entry.json.length : entry.strippedJson.length)
    ), 0)
    + Math.max(0, serialized.length - 1);
  while (minimalLength > budgetBytes && serialized.length > 1) {
    const removed = serialized.pop();
    if (!removed) break;
    minimalLength -= removed.strippedJson.length + 1;
  }

  // Then keep full continuation data for the retained sessions and shed
  // replay-only bulk (ciphertext, oversized tool output) from the oldest
  // retained sessions only as needed, never touching the protected newest
  // session. Within one session, shed it one message at a time from oldest to
  // newest so a long active chat can retain its most recent replayable tool
  // exchange when that still fits.
  let jsonLength = 2 + serialized.reduce((total, entry) => total + entry.json.length, 0)
    + Math.max(0, serialized.length - 1);
  const firstStrippableIndex = protectNewestContinuation ? 1 : 0;
  for (
    let index = serialized.length - 1;
    index >= firstStrippableIndex && jsonLength > budgetBytes;
    index -= 1
  ) {
    const current = serialized[index];
    let degradedMessageCount = 0;
    while (jsonLength > budgetBytes && degradedMessageCount < current.degradableMessages.length) {
      jsonLength += current.degradableMessages[degradedMessageCount].jsonLengthDelta;
      degradedMessageCount += 1;
    }
    if (degradedMessageCount > 0) {
      const degradedMessagesByIndex = new Map(
        current.degradableMessages
          .slice(0, degradedMessageCount)
          .map(entry => [entry.index, entry.degradedMessage] as const),
      );
      const nextSession = {
        ...current.session,
        messages: current.session.messages.map((message, messageIndex) => (
          degradedMessagesByIndex.get(messageIndex) ?? message
        )),
      };
      const nextJson = JSON.stringify(nextSession);
      const projectedJsonLength = current.json.length
        + current.degradableMessages
          .slice(0, degradedMessageCount)
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
  // Synced records are authoritative after restart: silently evicting a
  // session or turn here would turn local retention into cloud deletion.
  if (localStorageAdapter.read<{ enabled?: boolean }>(STORAGE_KEY_CLOUD_SYNC_AI_SESSIONS)?.enabled) {
    return localStorageAdapter.write(STORAGE_KEY_AI_SESSIONS, sessions);
  }
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
