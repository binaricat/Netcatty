import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import {
  STORAGE_KEY_AI_ACTIVE_SESSION_MAP,
  STORAGE_KEY_AI_SESSIONS,
  STORAGE_KEY_AI_SESSIONS_OVERFLOW,
  STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW,
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
  pruneInactiveScopedState,
} from './aiScopeCleanup';
import { emitAIStateChanged } from './aiStateEvents';
import { peekAgentRuntimeCleanup } from '../../infrastructure/ai/harness/agentRuntimeHandle';
import { setReversibleModelPrivacy } from '../../infrastructure/ai/harness/modelSecretRedaction';
import { DebouncedBackupMirror, mergeImportedSessions, readLiveSessionsArray } from './aiSessionsBackup';

/** Typed accessor for the Electron IPC bridge exposed on `window.netcatty`. */
export interface AIBridge {
  aiSdkAgentCleanup?: (chatSessionId: string) => Promise<{ ok: boolean }>;
  aiPrivacyClearSession?: (chatSessionId: string) => Promise<{ ok: boolean; error?: string }>;
  deleteChatToolOutputsTemp?: (chatSessionId: string) => Promise<{ deletedCount: number }>;
  deleteTerminalToolOutputsEverywhereTemp?: (terminalSessionId: string) => Promise<{ deletedCount: number }>;
  aiMcpSetPermissionMode?: (mode: AIPermissionMode) => Promise<unknown> | unknown;
  aiMcpSetToolIntegrationMode?: (mode: AIToolIntegrationMode) => Promise<unknown> | unknown;
  aiMcpSetCommandBlocklist?: (blocklist: string[]) => Promise<unknown> | unknown;
  aiMcpSetCommandTimeout?: (timeout: number) => Promise<unknown> | unknown;
  aiMcpSetMaxIterations?: (maxIterations: number) => Promise<unknown> | unknown;
  /** Durability mirror: write one timestamped backup generation to disk. */
  aiSessionsBackupWrite?: (payload: { json: string }) => Promise<{ ok: boolean }>;
  aiSessionsBackupReadLatest?: () => Promise<{ ok: boolean; json?: string }>;
  aiSessionsBackupExport?: (payload: { json: string }) => Promise<{ success: boolean; filePath?: string }>;
  aiSessionsBackupImport?: () => Promise<{ success: boolean; json?: string }>;
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
  // Only the startup-light handle is imported here; the runtime registers it
  // when created. Without a runtime there is no in-memory runtime state, but
  // the reversible-privacy flag (set outside the runtime) and the
  // main-process privacy mapping may still exist, so always clear those.
  const runtime = peekAgentRuntimeCleanup();
  for (const sessionId of sessionIds) {
    if (runtime) {
      runtime.clearChatSession(sessionId);
    } else {
      setReversibleModelPrivacy(sessionId, false);
      void bridge?.aiPrivacyClearSession?.(sessionId).catch(() => {});
    }
    void bridge?.aiSdkAgentCleanup?.(sessionId).catch(() => {});
    void bridge?.deleteChatToolOutputsTemp?.(sessionId).catch(() => {});
  }
}

export function cleanupClosedTerminalSessions(terminalSessionIds: string[]) {
  const bridge = getAIBridge();
  const runtime = peekAgentRuntimeCleanup();
  for (const terminalSessionId of new Set(terminalSessionIds)) {
    runtime?.clearTerminalSession(terminalSessionId);
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

/** Last live terminal/workspace target ids observed by orphan cleanup. */
export let latestAIActiveTargetIdsSnapshot: Set<string> = new Set();

export function cleanupOrphanedAISessions(activeTargetIds: Set<string>) {
  latestAIActiveTargetIdsSnapshot = activeTargetIds;
  const currentSessions = latestAISessionsSnapshot
    ?? readSessionsFromStorage();

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

  // Issue #4015 R2: a dropped chat is recoverable now, so mark it dangling
  // instead of stripping its record or pointer. `/chats` lists dangling chats
  // with a rebind affordance; the flag clears when the chat is rebound or its
  // scope target becomes live again.
  const orphanedIds = new Set(nextSessionCleanup.orphanedSessionIds);
  let sessionsMarked = false;
  const markedSessions = currentSessions.map((session) => {
    if (orphanedIds.has(session.id)) {
      if (session.scopeDangling) return session;
      sessionsMarked = true;
      return { ...session, scopeDangling: true };
    }
    if (
      session.scopeDangling
      && (!session.scope.targetId || activeTargetIds.has(session.scope.targetId))
    ) {
      sessionsMarked = true;
      const { scopeDangling: _cleared, ...rest } = session;
      return rest as AISession;
    }
    return session;
  });

  if (sessionsMarked) {
    setLatestAISessionsSnapshot(markedSessions);
    // Startup cleanup can run before the disk backup read resolves. Defer
    // persistence until those chats are merged, preserving their recovery
    // marker and avoiding a partial backup of only the loaded sessions.
    const diskOnlyIds = localStorageAdapter.read<string[]>(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW) ?? [];
    const loadedIds = new Set(markedSessions.map(session => session.id));
    if (!diskOnlyIds.some(id => !loadedIds.has(id))) {
      writeSessionsForStorage(markedSessions);
    }
    emitAIStateChanged(STORAGE_KEY_AI_SESSIONS);
  }

  // Issue #4015 R2: keep active-pointer entries for scopes whose target
  // closed. Clearing them used to make dangling chats invisible (rank 0) and
  // unrecoverable from the UI; the pointer is rewritten on rebind instead.
  const currentDraftsByScope = latestAIDraftsByScopeSnapshot ?? {};
  const currentPanelViewByScope = latestAIPanelViewByScopeSnapshot ?? {};
  const prunedScopedState = pruneInactiveScopedState(
    currentDraftsByScope,
    currentPanelViewByScope,
    activeTargetIds,
  );

  if (prunedScopedState.draftsByScope !== currentDraftsByScope) {
    for (const scopeKey of Object.keys(currentDraftsByScope)) {
      if (scopeKey in prunedScopedState.draftsByScope) continue;
      bumpDraftMutationVersion(scopeKey);
      bumpDraftUploadGeneration(scopeKey);
    }
    setLatestAIDraftsByScopeSnapshot(prunedScopedState.draftsByScope);
    emitAIStateChanged(AI_STATE_CHANGED_DRAFTS_BY_SCOPE);
  }

  if (prunedScopedState.panelViewByScope !== currentPanelViewByScope) {
    for (const scopeKey of Object.keys(currentPanelViewByScope)) {
      if (scopeKey in prunedScopedState.panelViewByScope) continue;
      bumpDraftMutationVersion(scopeKey);
    }
    setLatestAIPanelViewByScopeSnapshot(prunedScopedState.panelViewByScope);
    emitAIStateChanged(AI_STATE_CHANGED_PANEL_VIEW_BY_SCOPE);
  }
}


/** Maximum number of sessions to keep in localStorage. */
const MAX_STORED_SESSIONS = 50;
/** Maximum number of messages per session when persisting to localStorage. */
const MAX_SESSION_MESSAGES = 200;
/**
 * String-length budget for the primary sessions JSON and each overflow chunk.
 * Replay bulk is shed from the primary blob first; whole sessions that still
 * do not fit are retained in overflow rather than silently evicted.
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

export function prepareRestoredSessions(sessions: AISession[], syncEnabled: boolean): AISession[] {
  return syncEnabled ? sessions : pruneSessionsForStorage(sessions);
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
  const prepared = pruneSessionsForStorage(sessions).map(rawSession => {
    // These messages are replaced by the durable summary before every later
    // request, so their replay ciphertext can never be used again. Remove it
    // before deciding whether the newest session deserves full protection;
    // otherwise dead metadata can evict other visible conversations.
    const session = stripCompactedEncryptedReasoningFromSession(rawSession);
    return { session, json: JSON.stringify(session) };
  });

  // Check whether retained history fits before preparing degradation. Use
  // the existing JSON string-length budget including array delimiters, and
  // avoid preparing unused stripped messages and serializing payloads again.
  const fullLength = 2 + prepared.reduce((total, entry) => total + entry.json.length, 0)
    + Math.max(0, prepared.length - 1);
  if (fullLength <= budgetBytes) {
    return {
      json: `[${prepared.map(entry => entry.json).join(',')}]`,
      sessions: prepared.map(entry => entry.session),
    };
  }

  // Reuse the full representation when the unchanged degradation ladder is
  // needed, including on quota retries with a smaller budget.
  const serialized = prepared.map(({ session, json }) => {
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
 * Persist sessions to localStorage with byte-budgeted primary/overflow slices.
 * Returns true when local history was saved, possibly as a newest-primary
 * fallback with the full history scheduled for disk backup under quota pressure.
 */

// Durability mirror (issue #4015 follow-up): every successful store write
// also schedules a debounced disk backup so a wiped/recreated profile does
// not take the chat history with it. Persisted history is mirrored, including
// overflow sessions, throttled to at most one write per mutation batch.
// Before a byte-budget drop, mirror the full
// count-capped set even if the subsequent localStorage writes fail.
const backupMirror = new DebouncedBackupMirror((json) => {
  try {
    void getAIBridge()?.aiSessionsBackupWrite?.({ json })?.catch(() => {});
  } catch {
    // Backup failures must never break chat persistence.
  }
});

export function flushBackupMirror() {
  try {
    backupMirror.flushNow();
  } catch {
    // Unload and persistence must remain fail-safe.
  }
}

export function __resetBackupMirrorForTests() {
  backupMirror.reset();
}

export function scheduleBackupMirror(json: string) {
  try {
    backupMirror.schedule(json);
  } catch {
    // ignore
  }
}

/**
 * Last successful write: the same immutable sessions array is written again by
 * the debounced save path and by cloud-sync collection, and each write used to
 * re-serialize the whole (often multi-MB) history.
 */
let lastSessionsWrite: { sessions: AISession[]; synced: boolean; json: string } | null = null;

function rememberSessionsWrite(sessions: AISession[], synced: boolean, json: string): void {
  lastSessionsWrite = { sessions, synced, json };
}

function storedSessionsJsonEquals(json: string): boolean {
  try {
    return localStorageAdapter.readString(STORAGE_KEY_AI_SESSIONS) === json;
  } catch {
    return false;
  }
}

function overflowChunkKey(index: number): string {
  return index === 0 ? STORAGE_KEY_AI_SESSIONS_OVERFLOW : `${STORAGE_KEY_AI_SESSIONS_OVERFLOW}_${index + 1}`;
}

function readOverflowChunks(): string[] {
  const chunks: string[] = [];
  for (let index = 0; ; index += 1) {
    const chunk = localStorageAdapter.readString(overflowChunkKey(index));
    if (chunk == null) return chunks;
    chunks.push(chunk);
  }
}

function clearOverflowChunks(startIndex = 0) {
  for (let index = startIndex; localStorageAdapter.readString(overflowChunkKey(index)) != null; index += 1) {
    localStorageAdapter.remove(overflowChunkKey(index));
  }
}

function writeDiskOverflowIds(ids: string[]): boolean {
  if (ids.length > 0) {
    return localStorageAdapter.write(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW, ids);
  }
  if (localStorageAdapter.readString(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW) != null) {
    localStorageAdapter.remove(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW);
  }
  return true;
}

/** Replace the entire overflow blob; never leave a partially written JSON array. */
function replaceOverflowChunks(chunks: string[]): boolean {
  clearOverflowChunks();
  let complete = false;
  try {
    complete = chunks.every((chunk, index) => (
      localStorageAdapter.writeString(overflowChunkKey(index), chunk)
    ));
    return complete;
  } finally {
    if (!complete) clearOverflowChunks();
  }
}

/** Read both local retention slices; newer copies win if a session is duplicated. */
export function readSessionsFromStorage(): AISession[] {
  return mergeImportedSessions(
    readLiveSessionsArray(readOverflowChunks().join('')),
    readLiveSessionsArray(localStorageAdapter.readString(STORAGE_KEY_AI_SESSIONS)),
  );
}

export function writeSessionsForStorage(
  sessions: AISession[],
  options: { deletedSessionIds?: readonly string[] } = {},
): boolean {
  const synced = Boolean(
    localStorageAdapter.read<{ enabled?: boolean }>(STORAGE_KEY_CLOUD_SYNC_AI_SESSIONS)?.enabled,
  );
  // Nothing to do when this exact array was already written in this mode and
  // storage still holds that write (another window may have replaced it).
  if (
    lastSessionsWrite?.sessions === sessions
    && lastSessionsWrite.synced === synced
    && storedSessionsJsonEquals(lastSessionsWrite.json)
    // A matching primary alone cannot establish that overflow is intact.
    && localStorageAdapter.readString(STORAGE_KEY_AI_SESSIONS_OVERFLOW) == null
    && localStorageAdapter.readString(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW) == null
  ) {
    return true;
  }
  // Synced records are authoritative after restart: silently evicting a
  // session or turn here would turn local retention into cloud deletion.
  if (synced) {
    const json = JSON.stringify(sessions);
    const previousChunks = readOverflowChunks();
    // The authoritative primary replaces overflow, so free its quota first.
    clearOverflowChunks();
    let syncedOk = false;
    try {
      syncedOk = localStorageAdapter.writeString(STORAGE_KEY_AI_SESSIONS, json);
      if (syncedOk) {
        clearOverflowChunks();
        if (localStorageAdapter.readString(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW) != null) {
          localStorageAdapter.remove(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW);
        }
        scheduleBackupMirror(json);
        rememberSessionsWrite(sessions, true, json);
      }
      return syncedOk;
    } finally {
      if (!syncedOk) replaceOverflowChunks(previousChunks);
    }
  }
  const inputIds = new Set(sessions.map(session => session.id));
  const pruned = pruneSessionsForStorage(sessions);
  const retainedIds = new Set(pruned.map(session => session.id));
  const deletedIds = new Set(options.deletedSessionIds);
  // A live write can race startup's backup read. Preserve marker IDs absent
  // from the live input unless explicitly deleted. IDs present in the input
  // are resolved even if the count cap evicts them; pending IDs block mirroring.
  const diskOverflowIds = localStorageAdapter.read<unknown>(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW);
  const unresolvedDiskIds: string[] = Array.isArray(diskOverflowIds)
    ? diskOverflowIds.filter((id): id is string => (
      typeof id === 'string' && !retainedIds.has(id) && !deletedIds.has(id) && !inputIds.has(id)
    ))
    : [];
  let fullBackupScheduled = false;
  const ensureFullBackup = () => {
    if (!fullBackupScheduled && unresolvedDiskIds.length === 0) {
      scheduleBackupMirror(JSON.stringify(pruned));
      fullBackupScheduled = true;
    }
  };
  const persistCandidate = (
    candidate: { json: string; sessions: AISession[] },
    budget: number,
    chunkBudget = budget,
  ): boolean => {
    const primaryIds = new Set(candidate.sessions.map(session => session.id));
    const omitted = pruned.filter(session => !primaryIds.has(session.id));
    if (omitted.length > 0) ensureFullBackup();
    // Apply the same replay-bulk ladder to every overflow chat as budgets
    // tighten. Chunking alone cannot reduce an origin's aggregate quota use.
    const overflow = omitted.map(session => serializeSessionsForStorage([session], budget).sessions[0]);
    const overflowJson = overflow.length > 0 ? JSON.stringify(overflow) : '';
    // Split the array's JSON string, so even one oversized session can span
    // chunks without losing messages. Concatenate all chunks before parsing.
    const chunks: string[] = [];
    // Primary budgets can shrink to a tiny empty chat. Keep overflow writes
    // bounded independently while still supporting small per-key quotas.
    const chunkSize = Math.max(32 * 1024, chunkBudget);
    for (let offset = 0; offset < overflowJson.length; offset += chunkSize) {
      chunks.push(overflowJson.slice(offset, offset + chunkSize));
    }
    const previousChunks = readOverflowChunks();
    const previousPrimary = localStorageAdapter.readString(STORAGE_KEY_AI_SESSIONS);
    let primaryWritten = false;
    let persisted = false;
    try {
      // Reclaim both old slices before writing overflow: the final history may
      // fit even when overflow plus the old, larger primary would exceed quota.
      clearOverflowChunks();
      if (!localStorageAdapter.writeString(STORAGE_KEY_AI_SESSIONS, candidate.json)) return false;
      primaryWritten = true;
      if (!replaceOverflowChunks(chunks)) return false;
      if (!writeDiskOverflowIds(unresolvedDiskIds)) return false;
      persisted = true;
      if (!fullBackupScheduled && unresolvedDiskIds.length === 0) scheduleBackupMirror(candidate.json);
      rememberSessionsWrite(sessions, false, candidate.json);
      return true;
    } finally {
      if (!persisted) {
        clearOverflowChunks();
        if (primaryWritten) {
          if (previousPrimary == null) localStorageAdapter.remove(STORAGE_KEY_AI_SESSIONS);
          else localStorageAdapter.writeString(STORAGE_KEY_AI_SESSIONS, previousPrimary);
        }
        replaceOverflowChunks(previousChunks);
      }
    }
  };
  const primaryCandidates: { json: string; sessions: AISession[] }[] = [];
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
    const candidate = serializeSessionsForStorage(pruned, budget);
    primaryCandidates.push(candidate);
    // Even an unchanged primary can succeed with smaller overflow chunks or
    // more degraded overflow replay data at this retry budget.
    if (persistCandidate(candidate, budget)) return true;
    previousLength = candidate.json.length;
  }
  // Last resort: use the smallest primary representation (the newest chat
  // with replay-only bulk removed), retaining other chats in overflow.
  const minimalCandidate = serializeSessionsForStorage(pruned, 0);
  const minimalChunkBudget = Math.min(minimalCandidate.json.length, RETRY_SESSIONS_JSON_BYTES[RETRY_SESSIONS_JSON_BYTES.length - 1]);
  primaryCandidates.push(minimalCandidate);
  if (persistCandidate(minimalCandidate, 0, minimalChunkBudget)) return true;

  // If the complete retained set cannot fit, save the newest primary anyway.
  // Schedule the full disk mirror before discarding overflow; do not let an
  // old valid primary block persistence of every subsequent conversation turn.
  ensureFullBackup();
  const previousChunks = readOverflowChunks();
  const previousPrimary = localStorageAdapter.readString(STORAGE_KEY_AI_SESSIONS);
  const previousDiskOverflow = localStorageAdapter.readString(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW);
  clearOverflowChunks();
  let primaryWritten = false;
  let primaryPersisted = false;
  try {
    for (const candidate of primaryCandidates) {
      const primaryIds = new Set(candidate.sessions.map(session => session.id));
      const diskOnlyIds = [...new Set([
        ...unresolvedDiskIds,
        ...pruned.filter(session => !primaryIds.has(session.id)).map(session => session.id),
      ])];
      // Replacing a large old primary can free the space needed by metadata.
      // Roll it back below if the recovery marker still cannot be persisted.
      if (!localStorageAdapter.writeString(STORAGE_KEY_AI_SESSIONS, candidate.json)) continue;
      primaryWritten = true;
      if (writeDiskOverflowIds(diskOnlyIds)) {
        primaryPersisted = true;
        rememberSessionsWrite(sessions, false, candidate.json);
        return true;
      }
    }
  } finally {
    if (!primaryPersisted) {
      if (primaryWritten) {
        if (previousPrimary == null) localStorageAdapter.remove(STORAGE_KEY_AI_SESSIONS);
        else localStorageAdapter.writeString(STORAGE_KEY_AI_SESSIONS, previousPrimary);
      }
      if (previousDiskOverflow != null) {
        localStorageAdapter.writeString(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW, previousDiskOverflow);
      } else if (localStorageAdapter.readString(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW) != null) {
        localStorageAdapter.remove(STORAGE_KEY_AI_SESSIONS_DISK_OVERFLOW);
      }
      replaceOverflowChunks(previousChunks);
    }
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


/**
 * Issue #4015 R2: rewrite the active-session map when rebinding a dangling
 * chat. Drops every pointer that still names `sessionId` under a different
 * scope key, then sets the new scope as active. Callers must persist and
 * publish the returned map (do not rebuild from a stale snapshot).
 */
export function rebindActiveSessionMap(
  activeSessionIdMap: Record<string, string | null>,
  sessionId: string,
  scopeKey: string,
): Record<string, string | null> {
  let next = activeSessionIdMap;
  for (const [key, id] of Object.entries(activeSessionIdMap)) {
    if (id !== sessionId || key === scopeKey) continue;
    if (next === activeSessionIdMap) next = { ...activeSessionIdMap };
    delete next[key];
  }
  if (next[scopeKey] === sessionId) return next;
  return { ...next, [scopeKey]: sessionId };
}

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
        readSessionsFromStorage();
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
