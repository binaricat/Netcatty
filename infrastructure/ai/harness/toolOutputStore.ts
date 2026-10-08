export interface ToolOutputHandle {
  id: string;
  chatSessionId: string;
  capabilityId: string;
  sessionId?: string;
  totalChars: number;
  storedChars: number;
  sourceTruncated: boolean;
  preview: string;
  storedAt: number;
  accessedAt: number;
  fullContent?: string;
  filePath?: string;
  spillPromise?: Promise<void>;
  evicted?: boolean;
}

export interface PersistedToolOutputRecord {
  schemaVersion: 1;
  handleId: string;
  chatSessionId: string;
  capabilityId: string;
  terminalSessionId?: string;
  totalChars: number;
  storedChars: number;
  sourceTruncated: boolean;
  preview: string;
  storedAt: number;
  accessedAt: number;
}

export interface StoreToolOutputInput {
  chatSessionId: string;
  capabilityId: string;
  content: string;
  sessionId?: string;
  previewChars?: number;
}

export interface ReadToolOutputInput {
  handleId: string;
  mode?: 'head' | 'tail' | 'full' | 'range' | 'search';
  maxChars?: number;
  offset?: number;
  query?: string;
}

export interface ToolOutputReadResult {
  handleId: string;
  mode: NonNullable<ReadToolOutputInput['mode']>;
  content: string;
  totalChars: number;
  storedChars: number;
  sourceTruncated: boolean;
  startOffset: number;
  endOffset: number;
  nextOffset: number;
  hasMore: boolean;
  matchOffsets?: number[];
}

export const TOOL_OUTPUT_READ_MAX_CHARS = 12_000;
export const TOOL_OUTPUT_MAX_HANDLE_CHARS = 4_000_000;
export const TOOL_OUTPUT_MAX_HANDLES_PER_SESSION = 64;
export const TOOL_OUTPUT_MAX_CHARS_PER_SESSION = 8_000_000;
export const TOOL_OUTPUT_MAX_HANDLES_GLOBAL = 256;
export const TOOL_OUTPUT_MAX_CHARS_GLOBAL = 32_000_000;
export const TOOL_OUTPUT_MAX_CLOSED_TERMINAL_SESSIONS = 1_024;
export const TOOL_OUTPUT_MAX_FAILED_SESSION_DELETIONS = 1_024;
export const TOOL_OUTPUT_TTL_MS = 30 * 60 * 1_000;
export const TOOL_OUTPUT_SPILL_THRESHOLD_CHARS = 0;
const TOOL_OUTPUT_SEARCH_CONTEXT_CHARS = 320;
const TOOL_OUTPUT_SEARCH_MAX_MATCHES = 20;
const TOOL_OUTPUT_MAX_PENDING_ALIAS_RESTORES = 50;
export const TOOL_OUTPUT_ALIAS_MATERIALIZATION_RETRY_DELAY_MS = 200;
// Failed alias materializations are retried indefinitely (with capped
// exponential backoff) because a later turn may install working persistence;
// dropping them would permanently lose the branch-owned durable copy.
const TOOL_OUTPUT_ALIAS_MATERIALIZATION_MAX_RETRY_DELAY_MS = 30_000;
const TOOL_OUTPUT_MAX_PENDING_ALIAS_MATERIALIZATIONS = 50;
const TOOL_OUTPUT_LIFECYCLE_BLOOM_BITS = 1 << 22;
const TOOL_OUTPUT_LIFECYCLE_BLOOM_HASHES = 4;

/**
 * Fixed-memory deny set with no false negatives. Lifecycle ids are UUID-like
 * and never intentionally reused, so rare false positives are safer than
 * accepting output for a deleted chat/terminal after exact tombstone churn.
 */
class FixedStringBloomFilter {
  private readonly words = new Uint32Array(TOOL_OUTPUT_LIFECYCLE_BLOOM_BITS >>> 5);

  add(value: string): void {
    for (const bit of this.bitsFor(value)) {
      this.words[bit >>> 5] |= 1 << (bit & 31);
    }
  }

  has(value: string): boolean {
    for (const bit of this.bitsFor(value)) {
      if ((this.words[bit >>> 5] & (1 << (bit & 31))) === 0) return false;
    }
    return true;
  }

  private bitsFor(value: string): number[] {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ (code + index), 0x85ebca6b);
    }
    second |= 1;
    const mask = TOOL_OUTPUT_LIFECYCLE_BLOOM_BITS - 1;
    return Array.from({ length: TOOL_OUTPUT_LIFECYCLE_BLOOM_HASHES }, (_, index) => (
      (first + Math.imul(index, second)) >>> 0
    ) & mask);
  }
}

export interface ToolOutputPersistence {
  write(record: PersistedToolOutputRecord, content: string): Promise<string>;
  restore?(
    handleId: string,
    chatSessionId: string,
  ): Promise<{ path: string; record: PersistedToolOutputRecord } | null>;
  read(path: string, input: ReadToolOutputInput): Promise<Omit<ToolOutputReadResult, 'handleId' | 'storedChars' | 'sourceTruncated'> | null>;
  delete(path: string): Promise<void>;
  deleteSession?(chatSessionId: string): Promise<void>;
  deleteTerminalSession?(chatSessionId: string, terminalSessionId: string): Promise<void>;
  deleteTerminalEverywhere?(terminalSessionId: string): Promise<void>;
}

export interface AliasSessionHandlesOptions {
  /**
   * Restrict aliasing to the handles referenced by the retained conversation
   * prefix (messages kept after an undo plus compaction artifacts). When
   * omitted, every pending handle under the source session is aliased.
   */
  retainedHandleIds?: ReadonlySet<string>;
}

export interface ToolOutputStoreOptions {
  maxHandleChars?: number;
  maxHandlesPerSession?: number;
  maxCharsPerSession?: number;
  maxHandlesGlobal?: number;
  maxCharsGlobal?: number;
  ttlMs?: number;
  spillThresholdChars?: number;
  now?: () => number;
  persistence?: ToolOutputPersistence;
}

function nextHandleId(): string {
  const randomId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `tool-output-${randomId}`;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function safeSliceBounds(content: string, requestedStart: number, requestedEnd: number): [number, number] {
  let start = Math.min(content.length, Math.max(0, requestedStart));
  let end = Math.min(content.length, Math.max(start, requestedEnd));
  if (start > 0 && start < content.length && isLowSurrogate(content.charCodeAt(start))) {
    start -= 1;
  }
  if (end > start && end < content.length && isHighSurrogate(content.charCodeAt(end - 1))) {
    end -= 1;
  }
  return [start, end];
}

export class ToolOutputStore {
  private readonly bySession = new Map<string, Map<string, ToolOutputHandle>>();
  private readonly maxHandleChars: number;
  private readonly maxHandlesPerSession: number;
  private readonly maxCharsPerSession: number;
  private readonly maxHandlesGlobal: number;
  private readonly maxCharsGlobal: number;
  private readonly ttlMs: number;
  private readonly spillThresholdChars: number;
  private readonly now: () => number;
  private readonly restorePromises = new Map<string, Promise<ToolOutputHandle | undefined>>();
  private readonly sessionGenerations = new Map<string, number>();
  private readonly sessionDeletionPromises = new Map<string, Promise<void>>();
  private readonly failedSessionDeletions = new Set<string>();
  private readonly terminalMutationGenerations = new Map<string, number>();
  private readonly terminalDeletionPromises = new Map<string, Promise<void>>();
  private readonly failedTerminalDeletions = new Set<string>();
  private readonly deletedTerminalSessions = new Map<string, string>();
  private readonly closedTerminalSessions = new Set<string>();
  private readonly lifecycleDenyFilter = new FixedStringBloomFilter();
  // Alias requests whose in-memory handles are gone and whose durable restore
  // cannot run yet: persistence installs on the first turn (for example undo
  // immediately after an app restart), or `restore` just rejected transiently.
  // Retried with capped backoff (and replayed once persistence appears).
  private readonly pendingAliasRestores = new Map<string, {
    sourceChatSessionId: string;
    targetChatSessionId: string;
    handleIds: string[];
  }>();
  private pendingAliasRestoreReplayTimer?: ReturnType<typeof setTimeout>;
  private pendingAliasRestoreReplayAttempts = 0;
  // Alias passes still running for a source chat session; `prune` waits for
  // every one of them before deleting the source session's durable records.
  // A Set per source so undoing the same session into several branches keeps
  // an older in-flight copy tracked after a newer one is registered.
  private readonly aliasMaterializationPromises = new Map<string, Set<Promise<void>>>();
  // Shared durable files whose delete was deferred until the last alias stops
  // referencing them.
  private readonly deferredPathDeletes = new Set<string>();
  // Alias handles whose branch-owned durable copy could not be written (for
  // example a transient persistence.read/write failure). Retried with a delay
  // so deleting the source session or a restart does not lose the branch copy.
  // The failed aliases still read their content from the source chat session's
  // durable records, so the source is tracked here too: `prune` must not
  // delete it until every retry for it has drained.
  private readonly pendingAliasMaterializations = new Map<string, {
    targetChatSessionId: string;
    sourceChatSessionIds: Set<string>;
    handles: ToolOutputHandle[];
    attempts: number;
  }>();
  private aliasMaterializationRetryTimer?: ReturnType<typeof setTimeout>;
  // Notified whenever the pending alias materialization queue changes; lets
  // `prune` wait until every retry that still needs its source durable
  // records has finished before deleting them.
  private readonly materializationDrainListeners = new Set<() => void>();
  private persistence?: ToolOutputPersistence;

  constructor(options: ToolOutputStoreOptions = {}) {
    this.maxHandleChars = options.maxHandleChars ?? TOOL_OUTPUT_MAX_HANDLE_CHARS;
    this.maxHandlesPerSession = options.maxHandlesPerSession ?? TOOL_OUTPUT_MAX_HANDLES_PER_SESSION;
    this.maxCharsPerSession = options.maxCharsPerSession ?? TOOL_OUTPUT_MAX_CHARS_PER_SESSION;
    this.maxHandlesGlobal = options.maxHandlesGlobal ?? TOOL_OUTPUT_MAX_HANDLES_GLOBAL;
    this.maxCharsGlobal = options.maxCharsGlobal ?? TOOL_OUTPUT_MAX_CHARS_GLOBAL;
    this.ttlMs = options.ttlMs ?? TOOL_OUTPUT_TTL_MS;
    this.spillThresholdChars = options.spillThresholdChars ?? TOOL_OUTPUT_SPILL_THRESHOLD_CHARS;
    this.now = options.now ?? Date.now;
    this.persistence = options.persistence;
  }

  setPersistence(persistence: ToolOutputPersistence | undefined): void {
    this.persistence = persistence;
    if (persistence?.restore) {
      // A fresh (possibly repaired) persistence closure was installed; failed
      // restore attempts before it do not reflect its health.
      this.pendingAliasRestoreReplayAttempts = 0;
      this.replayPendingAliasRestores();
    }
    if (persistence?.write && this.pendingAliasMaterializations.size > 0) {
      void this.runAliasMaterializationRetries();
    }
  }

  private replayPendingAliasRestores(): void {
    if (this.pendingAliasRestores.size === 0) return;
    const pending = [...this.pendingAliasRestores.values()];
    this.pendingAliasRestores.clear();
    for (const request of pending) {
      void this.aliasSessionHandles(request.sourceChatSessionId, request.targetChatSessionId, {
        retainedHandleIds: new Set(request.handleIds),
      }).catch(() => {});
    }
    // Restores that still fail are re-queued by the alias pass; keep retrying
    // them later so a transient rejection does not permanently drop them.
    this.schedulePendingAliasRestoreReplay();
  }

  private queuePendingAliasRestores(
    sourceChatSessionId: string,
    targetChatSessionId: string,
    handleIds: string[],
  ): void {
    const key = `${sourceChatSessionId}\n${targetChatSessionId}`;
    const existing = this.pendingAliasRestores.get(key);
    if (existing) {
      existing.handleIds.push(...handleIds.filter(id => !existing.handleIds.includes(id)));
    } else {
      this.pendingAliasRestores.set(key, {
        sourceChatSessionId,
        targetChatSessionId,
        handleIds: [...handleIds],
      });
    }
    this.enforcePendingAliasRestoresLimit();
    this.schedulePendingAliasRestoreReplay();
  }

  private schedulePendingAliasRestoreReplay(): void {
    if (this.pendingAliasRestoreReplayTimer) return;
    if (this.pendingAliasRestores.size === 0) return;
    if (!this.persistence?.restore) return;
    // Back off while restores keep rejecting so a persistently unhealthy store
    // does not spin every 200 ms forever, mirroring the materialization queue.
    const delay = Math.min(
      TOOL_OUTPUT_ALIAS_MATERIALIZATION_RETRY_DELAY_MS * 2 ** this.pendingAliasRestoreReplayAttempts,
      TOOL_OUTPUT_ALIAS_MATERIALIZATION_MAX_RETRY_DELAY_MS,
    );
    this.pendingAliasRestoreReplayTimer = setTimeout(() => {
      this.pendingAliasRestoreReplayTimer = undefined;
      const pending = [...this.pendingAliasRestores.values()];
      this.pendingAliasRestores.clear();
      void Promise
        .allSettled(pending.map(request => this.aliasSessionHandles(
          request.sourceChatSessionId,
          request.targetChatSessionId,
          { retainedHandleIds: new Set(request.handleIds) },
        )))
        .then(() => {
          this.pendingAliasRestoreReplayAttempts = this.pendingAliasRestores.size > 0
            ? this.pendingAliasRestoreReplayAttempts + 1
            : 0;
          this.schedulePendingAliasRestoreReplay();
        });
    }, delay);
  }

  resolveRestartPersistenceNotices<T>(value: T, chatSessionId: string): T {
    return this.resolveRestartPersistenceNoticesValue(value, chatSessionId) as T;
  }

  getLifecycleMetadataStatsForTests(): {
    sessionGenerations: number;
    failedSessionDeletions: number;
    terminalMutationGenerations: number;
    failedTerminalDeletions: number;
    deletedTerminalSessions: number;
    closedTerminalSessions: number;
  } {
    return {
      sessionGenerations: this.sessionGenerations.size,
      failedSessionDeletions: this.failedSessionDeletions.size,
      terminalMutationGenerations: this.terminalMutationGenerations.size,
      failedTerminalDeletions: this.failedTerminalDeletions.size,
      deletedTerminalSessions: this.deletedTerminalSessions.size,
      closedTerminalSessions: this.closedTerminalSessions.size,
    };
  }

  store(input: StoreToolOutputInput): ToolOutputHandle {
    const previewChars = input.previewChars ?? 240;
    const now = this.now();
    const lifecycleDenied = this.lifecycleDenyFilter.has(`chat:${input.chatSessionId}`)
      || Boolean(
        input.sessionId
        && (
          this.closedTerminalSessions.has(input.sessionId)
          || this.lifecycleDenyFilter.has(`closed-terminal:${input.sessionId}`)
        )
      );
    if (lifecycleDenied) {
      return {
        id: nextHandleId(),
        chatSessionId: input.chatSessionId,
        capabilityId: input.capabilityId,
        sessionId: input.sessionId,
        totalChars: input.content.length,
        storedChars: 0,
        sourceTruncated: input.content.length > 0,
        preview: "",
        storedAt: now,
        accessedAt: now,
        evicted: true,
      };
    }
    const retainedContent = retainBoundedContent(input.content, this.maxHandleChars);
    const handle: ToolOutputHandle = {
      id: nextHandleId(),
      chatSessionId: input.chatSessionId,
      capabilityId: input.capabilityId,
      sessionId: input.sessionId,
      totalChars: input.content.length,
      storedChars: retainedContent.length,
      sourceTruncated: retainedContent.length < input.content.length,
      preview: retainedContent.slice(0, previewChars),
      storedAt: now,
      accessedAt: now,
      fullContent: retainedContent,
    };
    const sessionMap = this.bySession.get(input.chatSessionId) ?? new Map<string, ToolOutputHandle>();
    sessionMap.set(handle.id, handle);
    this.bySession.set(input.chatSessionId, sessionMap);
    this.enforceSessionLimits(input.chatSessionId, sessionMap);
    this.enforceGlobalLimits();
    if (sessionMap.has(handle.id)) this.startSpill(handle);
    return handle;
  }

  get(handleId: string, chatSessionId?: string): ToolOutputHandle | undefined {
    this.pruneExpired();
    if (chatSessionId) {
      const handle = this.bySession.get(chatSessionId)?.get(handleId);
      if (handle) handle.accessedAt = this.now();
      return handle;
    }
    for (const sessionMap of this.bySession.values()) {
      const handle = sessionMap.get(handleId);
      if (handle) {
        handle.accessedAt = this.now();
        return handle;
      }
    }
    return undefined;
  }

  listPendingHandles(chatSessionId: string): ToolOutputHandle[] {
    this.pruneExpired();
    return [...(this.bySession.get(chatSessionId)?.values() ?? [])];
  }

  /**
   * Alias handles stored under `sourceChatSessionId` into
   * `targetChatSessionId`'s namespace, keeping the same handle ids so
   * references retained in a branched conversation still resolve.
   *
   * When `options.retainedHandleIds` is provided, only handles referenced by
   * the retained conversation prefix are aliased; handles created by the
   * removed turn keep working under the source session but are not advertised
   * to the branch. Handles missing from the in-memory cache (for example after
   * an app restart) are restored from durable storage under the source
   * namespace when possible.
   *
   * Each alias is also backed by its own durable copy under the branch chat's
   * namespace so reads keep working after the app restarts, when restore looks
   * up manifests by the branch session id.
   */
  aliasSessionHandles(
    sourceChatSessionId: string,
    targetChatSessionId: string,
    options?: AliasSessionHandlesOptions,
  ): Promise<void> {
    // Track the whole alias pass as an in-flight materialization for the source
    // session: deleting the source chat must not drop its durable records (or
    // shared files) while branch aliases still read from them.
    const flight = this.runAliasSessionHandles(
      sourceChatSessionId,
      targetChatSessionId,
      options,
    );
    let flights = this.aliasMaterializationPromises.get(sourceChatSessionId);
    if (!flights) {
      flights = new Set<Promise<void>>();
      this.aliasMaterializationPromises.set(sourceChatSessionId, flights);
    }
    flights.add(flight);
    // Drop the flight once it settles without changing the promise's rejection
    // behavior for callers awaiting the alias pass.
    void flight.then(() => {}, () => {}).then(() => {
      const current = this.aliasMaterializationPromises.get(sourceChatSessionId);
      if (!current) return;
      current.delete(flight);
      if (current.size === 0) this.aliasMaterializationPromises.delete(sourceChatSessionId);
    });
    return flight;
  }

  private async runAliasSessionHandles(
    sourceChatSessionId: string,
    targetChatSessionId: string,
    options?: AliasSessionHandlesOptions,
  ): Promise<void> {
    if (sourceChatSessionId === targetChatSessionId) return;
    if (this.lifecycleDenyFilter.has(`chat:${targetChatSessionId}`)) return;
    const retained = options?.retainedHandleIds;
    const sourceMap = this.bySession.get(sourceChatSessionId);
    const wantedHandleIds = retained ? [...retained] : [...(sourceMap?.keys() ?? [])];
    if (wantedHandleIds.length === 0) return;
    const targetMap = this.bySession.get(targetChatSessionId) ?? new Map<string, ToolOutputHandle>();
    const aliased: ToolOutputHandle[] = [];
    const missingRestoreHandleIds: string[] = [];
    for (const handleId of wantedHandleIds) {
      let sourceHandle = sourceMap?.get(handleId);
      if (!sourceHandle) {
        let restoreFailed = false;
        sourceHandle = await this.restoreHandle(handleId, sourceChatSessionId).catch(() => {
          restoreFailed = true;
          return undefined;
        });
        if (!sourceHandle && (!this.persistence?.restore || restoreFailed)) {
          // Either persistence (which installs on the first turn) is not
          // available yet, or `restore` just rejected transiently (for example
          // a locked secure store right after a restart). Remember the request
          // and retry it instead of publishing the branch without the handle:
          // the retained prefix references it, and the branch namespace never
          // falls back to the source restore later.
          missingRestoreHandleIds.push(handleId);
        }
      }
      if (!sourceHandle || sourceHandle.evicted || targetMap.has(handleId)) continue;
      const alias: ToolOutputHandle = {
        ...sourceHandle,
        chatSessionId: targetChatSessionId,
        accessedAt: this.now(),
      };
      targetMap.set(handleId, alias);
      aliased.push(alias);
    }
    if (missingRestoreHandleIds.length > 0) {
      this.queuePendingAliasRestores(
        sourceChatSessionId,
        targetChatSessionId,
        missingRestoreHandleIds,
      );
    }
    if (aliased.length === 0) return;
    this.bySession.set(targetChatSessionId, targetMap);
    this.enforceSessionLimits(targetChatSessionId, targetMap);
    this.enforceGlobalLimits();
    await this.materializeDurableAliases(
      sourceChatSessionId,
      targetChatSessionId,
      aliased.filter(alias => !alias.evicted),
    );
  }

  private enforcePendingAliasRestoresLimit(): void {
    while (this.pendingAliasRestores.size > TOOL_OUTPUT_MAX_PENDING_ALIAS_RESTORES) {
      const oldest = this.pendingAliasRestores.keys().next().value;
      if (oldest === undefined) break;
      this.pendingAliasRestores.delete(oldest);
    }
  }

  /**
   * Give each alias its own durable record under the branch chat's namespace.
   * Aliases initially share the source handle's content/spill path so reads
   * work immediately; once the copy lands the alias points at it, so removing
   * the source session no longer breaks branch reads and restore finds the
   * branch-owned record after a restart.
   */
  private async materializeDurableAliases(
    sourceChatSessionId: string,
    targetChatSessionId: string,
    aliases: ToolOutputHandle[],
  ): Promise<void> {
    const failed = await this.materializeDurableHandles(targetChatSessionId, aliases);
    // The materialized aliases no longer read from the shared source files;
    // now is a good moment to finish any deferred deletes for them.
    this.processDeferredPathDeletes();
    if (failed.length > 0) {
      this.queueAliasMaterializationRetry(sourceChatSessionId, targetChatSessionId, failed);
    }
  }

  /**
   * Try to give each alias its own durable copy under the branch chat's
   * namespace. Returns the aliases whose materialization failed so the caller
   * can queue them for retry instead of silently losing the branch copy.
   */
  private async materializeDurableHandles(
    targetChatSessionId: string,
    aliases: ToolOutputHandle[],
  ): Promise<ToolOutputHandle[]> {
    const persistence = this.persistence;
    if (!persistence?.write) return aliases;
    const failed: ToolOutputHandle[] = [];
    for (const alias of aliases) {
      try {
        await alias.spillPromise;
        if (alias.evicted) continue;
        if (alias.fullContent == null && !alias.filePath) continue;
        const content = alias.fullContent ?? await this.readPersistedContent(alias, persistence);
        if (content == null) {
          failed.push(alias);
          continue;
        }
        const path = await persistence.write(
          {
            ...toPersistedRecord(alias),
            chatSessionId: targetChatSessionId,
            accessedAt: this.now(),
          },
          content,
        );
        if (alias.evicted) {
          void persistence.delete(path).catch(() => {});
          continue;
        }
        alias.filePath = path;
        alias.fullContent = undefined;
      } catch {
        // Transient persistence failure while the alias still shares the
        // source-owned view; queue the alias for retry rather than leaving it
        // pointing at the source's durable file forever.
        failed.push(alias);
      }
    }
    return failed;
  }

  private queueAliasMaterializationRetry(
    sourceChatSessionId: string,
    targetChatSessionId: string,
    handles: ToolOutputHandle[],
  ): void {
    while (this.pendingAliasMaterializations.size >= TOOL_OUTPUT_MAX_PENDING_ALIAS_MATERIALIZATIONS) {
      const oldest = this.pendingAliasMaterializations.keys().next().value;
      if (oldest === undefined) break;
      this.pendingAliasMaterializations.delete(oldest);
      this.notifyMaterializationWaiters();
    }
    const existing = this.pendingAliasMaterializations.get(targetChatSessionId);
    if (existing) {
      existing.sourceChatSessionIds.add(sourceChatSessionId);
      existing.handles.push(...handles.filter(handle => !existing.handles.includes(handle)));
      this.scheduleAliasMaterializationRetry();
      return;
    }
    this.pendingAliasMaterializations.set(targetChatSessionId, {
      targetChatSessionId,
      sourceChatSessionIds: new Set([sourceChatSessionId]),
      handles: [...handles],
      attempts: 0,
    });
    this.scheduleAliasMaterializationRetry();
  }

  private notifyMaterializationWaiters(): void {
    for (const notify of [...this.materializationDrainListeners]) {
      this.materializationDrainListeners.delete(notify);
      notify();
    }
  }

  /**
   * Resolves once the pending alias-materialization retry queue no longer
   * contains a request whose failed aliases still read the given source chat
   * session's durable records. Failed retries re-read the source-owned file on
   * every attempt, so the source session must be retained until each retry
   * either materializes the branch-owned copy or the queue drains some other
   * way (the target chat was deleted, its handles evicted/dropped, ...).
   */
  private async waitForPendingAliasMaterializationsDrain(
    predicate: (item: {
      sourceChatSessionIds: Set<string>;
      handles: ToolOutputHandle[];
    }) => boolean,
  ): Promise<void> {
    for (;;) {
      if (![...this.pendingAliasMaterializations.values()].some(predicate)) return;
      await new Promise<void>(resolve => {
        this.materializationDrainListeners.add(resolve);
      });
    }
  }

  private scheduleAliasMaterializationRetry(): void {
    if (this.aliasMaterializationRetryTimer) return;
    // Back off as attempts accumulate so persistently unavailable storage (for
    // example a locked secure store) does not spin every 200 ms forever, while
    // the work stays queued until persistence can actually write it.
    let maxAttempts = 0;
    for (const item of this.pendingAliasMaterializations.values()) {
      maxAttempts = Math.max(maxAttempts, item.attempts);
    }
    const delay = Math.min(
      TOOL_OUTPUT_ALIAS_MATERIALIZATION_RETRY_DELAY_MS * 2 ** maxAttempts,
      TOOL_OUTPUT_ALIAS_MATERIALIZATION_MAX_RETRY_DELAY_MS,
    );
    this.aliasMaterializationRetryTimer = setTimeout(() => {
      this.aliasMaterializationRetryTimer = undefined;
      void this.runAliasMaterializationRetries();
    }, delay);
  }

  private async runAliasMaterializationRetries(): Promise<void> {
    if (this.pendingAliasMaterializations.size === 0) return;
    const persistence = this.persistence;
    if (!persistence?.write) {
      // Persistence is not installed (or was removed); replay once
      // `setPersistence` provides it again instead of burning attempts.
      return;
    }
    const pending = [...this.pendingAliasMaterializations.values()];
    this.pendingAliasMaterializations.clear();
    for (const item of pending) {
      const attempts = item.attempts + 1;
      if (this.lifecycleDenyFilter.has(`chat:${item.targetChatSessionId}`)) continue;
      const targetMap = this.bySession.get(item.targetChatSessionId);
      const handles = item.handles.filter(
        handle => !handle.evicted && targetMap?.get(handle.id) === handle,
      );
      if (handles.length === 0) continue;
      const failed = await this.materializeDurableHandles(item.targetChatSessionId, handles);
      // Keep failed aliases pending indefinitely (the retry timer backs off
      // with attempts): a later turn can install working persistence, and
      // dropping the request here would permanently lose the branch copy.
      if (failed.length > 0) {
        this.pendingAliasMaterializations.set(item.targetChatSessionId, {
          targetChatSessionId: item.targetChatSessionId,
          sourceChatSessionIds: item.sourceChatSessionIds,
          handles: failed,
          attempts,
        });
      }
    }
    // Source sessions scheduled for deletion may now be drainable (retries
    // succeeded or their entries were dropped above).
    this.notifyMaterializationWaiters();
    if (this.pendingAliasMaterializations.size > 0) this.scheduleAliasMaterializationRetry();
  }

  private isPathReferencedByOtherHandles(path: string, except: ToolOutputHandle): boolean {
    for (const sessionMap of this.bySession.values()) {
      for (const existing of sessionMap.values()) {
        if (existing !== except && existing.filePath === path) return true;
      }
    }
    return false;
  }

  private processDeferredPathDeletes(): void {
    if (this.deferredPathDeletes.size === 0) return;
    for (const path of [...this.deferredPathDeletes]) {
      if (this.isPathReferencedByHandle(path)) continue;
      this.deferredPathDeletes.delete(path);
      void this.persistence?.delete(path).catch(() => {});
    }
  }

  private isPathReferencedByHandle(path: string): boolean {
    for (const sessionMap of this.bySession.values()) {
      for (const existing of sessionMap.values()) {
        if (existing.filePath === path) return true;
      }
    }
    return false;
  }

  private async readPersistedContent(
    handle: ToolOutputHandle,
    persistence: ToolOutputPersistence,
  ): Promise<string | null> {
    if (!handle.filePath) return null;
    const chunks: string[] = [];
    let offset = 0;
    while (offset < handle.storedChars) {
      const chunk = await persistence.read(handle.filePath, {
        handleId: handle.id,
        mode: 'range',
        offset,
        maxChars: TOOL_OUTPUT_READ_MAX_CHARS,
      });
      if (!chunk || chunk.content.length === 0) break;
      chunks.push(chunk.content);
      const nextOffset = Math.max(offset + chunk.content.length, chunk.nextOffset);
      if (nextOffset <= offset) break;
      offset = nextOffset;
    }
    const content = chunks.join('');
    return content.length === handle.storedChars ? content : null;
  }

  async flush(chatSessionId: string): Promise<void> {
    const handles = [...(this.bySession.get(chatSessionId)?.values() ?? [])];
    await Promise.allSettled(handles.map(handle => handle.spillPromise));
  }

  read(input: ReadToolOutputInput, chatSessionId?: string): string | null {
    return this.readChunk(input, chatSessionId)?.content ?? null;
  }

  readChunk(input: ReadToolOutputInput, chatSessionId?: string): ToolOutputReadResult | null {
    const handle = this.get(input.handleId, chatSessionId);
    if (!handle) return null;
    if (handle.fullContent == null) return null;
    return buildReadResult(handle, handle.fullContent, input);
  }

  async readChunkAsync(input: ReadToolOutputInput, chatSessionId?: string): Promise<ToolOutputReadResult | null> {
    let handle = this.get(input.handleId, chatSessionId);
    if (!handle && chatSessionId) {
      handle = await this.restoreHandle(input.handleId, chatSessionId);
    }
    if (!handle) return null;
    await handle.spillPromise;
    if (handle.fullContent != null) return buildReadResult(handle, handle.fullContent, input);
    if (!handle.filePath || !this.persistence) return null;
    const persisted = await this.persistence.read(handle.filePath, input);
    if (!persisted) {
      this.removeHandle(handle);
      return null;
    }
    return {
      ...persisted,
      handleId: handle.id,
      totalChars: handle.totalChars,
      storedChars: handle.storedChars,
      sourceTruncated: handle.sourceTruncated,
    };
  }

  /**
   * The protected durable deletion `prune` scheduled for a chat session, when
   * it is still in flight. Callers that would otherwise delete the session's
   * durable tool-output records through a direct (unprotected) path must
   * await this promise instead: it only fires after in-flight alias passes
   * and queued alias materialization retries finish reading the source
   * records.
   */
  getSessionDeletionPromise(chatSessionId: string): Promise<void> | undefined {
    return this.sessionDeletionPromises.get(chatSessionId);
  }

  prune(chatSessionId: string): void {
    this.lifecycleDenyFilter.add(`chat:${chatSessionId}`);
    this.failedSessionDeletions.delete(chatSessionId);
    this.sessionGenerations.set(chatSessionId, (this.sessionGenerations.get(chatSessionId) ?? 0) + 1);
    for (const key of this.deletedTerminalSessions.keys()) {
      if (key.startsWith(`${chatSessionId}:`)) {
        this.deletedTerminalSessions.delete(key);
        this.terminalMutationGenerations.delete(key);
        this.failedTerminalDeletions.delete(key);
      }
    }
    const sessionMap = this.bySession.get(chatSessionId);
    if (sessionMap) {
      for (const handle of sessionMap.values()) this.evictHandle(handle);
    }
    this.bySession.delete(chatSessionId);
    this.processDeferredPathDeletes();
    let deletionSucceeded = false;
    let deletion: Promise<void> | undefined;
    const persistence = this.persistence;
    const deleteSessionImpl = persistence?.deleteSession;
    if (persistence && deleteSessionImpl) {
      // Deleting the session must not break work that still reads its durable
      // records: concurrently running alias passes may be reading its files,
      // and failed alias copies are queued for retries that re-read the
      // source-owned file on every attempt. Wait for the alias passes and for
      // the queued retries targeting this session to drain before deleting.
      const pendingFlights = [...(this.aliasMaterializationPromises.get(chatSessionId) ?? [])];
      const waitForSourceReads = Promise.all([
        Promise.allSettled(pendingFlights),
        this.waitForPendingAliasMaterializationsDrain(item => (
          item.sourceChatSessionIds.has(chatSessionId)
        )),
      ]);
      const deleteSession = (): Promise<void> => deleteSessionImpl.call(persistence, chatSessionId);
      deletion = waitForSourceReads
        .then(deleteSession)
        .then(
          () => { deletionSucceeded = true; },
          () => {},
        );
    }
    if (deletion) {
      this.sessionDeletionPromises.set(chatSessionId, deletion);
      void deletion.finally(() => {
        if (this.sessionDeletionPromises.get(chatSessionId) !== deletion) {
          return;
        }
        this.sessionDeletionPromises.delete(chatSessionId);
        if (deletionSucceeded) {
          this.cleanupSessionGeneration(chatSessionId);
        } else {
          this.failedSessionDeletions.add(chatSessionId);
          this.enforceSessionDeletionMetadataLimit();
        }
      });
    } else if (this.persistence?.restore && !this.persistence.deleteSession) {
      this.failedSessionDeletions.add(chatSessionId);
      this.enforceSessionDeletionMetadataLimit();
    }
    this.cleanupSessionGeneration(chatSessionId);
  }

  pruneTerminalSession(chatSessionId: string, terminalSessionId: string): void {
    const terminalKey = `${chatSessionId}:${terminalSessionId}`;
    this.lifecycleDenyFilter.add(`terminal-key:${terminalKey}`);
    this.deletedTerminalSessions.delete(terminalKey);
    this.deletedTerminalSessions.set(terminalKey, chatSessionId);
    this.failedTerminalDeletions.delete(terminalKey);
    this.terminalMutationGenerations.set(
      terminalKey,
      (this.terminalMutationGenerations.get(terminalKey) ?? 0) + 1,
    );
    const sessionMap = this.bySession.get(chatSessionId);
    if (sessionMap) {
      for (const [handleId, handle] of sessionMap) {
        if (handle.sessionId !== terminalSessionId) continue;
        sessionMap.delete(handleId);
        this.evictHandle(handle);
      }
      if (sessionMap.size === 0) this.bySession.delete(chatSessionId);
    }
    let deletionSucceeded = false;
    let deletion: Promise<void> | undefined;
    const persistence = this.persistence;
    const deleteTerminalSessionImpl = persistence?.deleteTerminalSession;
    if (persistence && deleteTerminalSessionImpl) {
      // Same as `prune`: wait for every running alias pass and for the queued
      // alias copy retries that still read this terminal's durable records
      // before deleting them.
      const pendingFlights = [...(this.aliasMaterializationPromises.get(chatSessionId) ?? [])];
      const waitForSourceReads = Promise.all([
        Promise.allSettled(pendingFlights),
        this.waitForPendingAliasMaterializationsDrain(item => (
          item.sourceChatSessionIds.has(chatSessionId)
          && item.handles.some(handle => handle.sessionId === terminalSessionId)
        )),
      ]);
      const deleteTerminalSession = (): Promise<void> => deleteTerminalSessionImpl.call(
        persistence,
        chatSessionId,
        terminalSessionId,
      );
      deletion = waitForSourceReads
        .then(deleteTerminalSession)
        .then(
          () => { deletionSucceeded = true; },
          () => {},
        );
    }
    if (deletion) {
      this.terminalDeletionPromises.set(terminalKey, deletion);
      void deletion.finally(() => {
        if (this.terminalDeletionPromises.get(terminalKey) !== deletion) {
          return;
        }
        this.terminalDeletionPromises.delete(terminalKey);
        if (deletionSucceeded) {
          this.cleanupTerminalMutationMetadata(terminalKey, chatSessionId);
        } else {
          this.failedTerminalDeletions.add(terminalKey);
          this.enforceTerminalMutationMetadataLimit();
        }
      });
    }
    this.cleanupTerminalMutationMetadata(terminalKey, chatSessionId);
    this.enforceTerminalMutationMetadataLimit();
  }

  pruneTerminalSessionEverywhere(terminalSessionId: string): void {
    this.lifecycleDenyFilter.add(`closed-terminal:${terminalSessionId}`);
    this.closedTerminalSessions.delete(terminalSessionId);
    this.closedTerminalSessions.add(terminalSessionId);
    while (this.closedTerminalSessions.size > TOOL_OUTPUT_MAX_CLOSED_TERMINAL_SESSIONS) {
      const oldestTerminalSessionId = this.closedTerminalSessions.values().next().value;
      if (oldestTerminalSessionId === undefined) break;
      this.closedTerminalSessions.delete(oldestTerminalSessionId);
    }
    const chatSessionIds = [...this.bySession.keys()];
    for (const chatSessionId of chatSessionIds) {
      this.pruneTerminalSession(chatSessionId, terminalSessionId);
    }
    void this.persistence?.deleteTerminalEverywhere?.(terminalSessionId).catch(() => {});
  }

  private startSpill(handle: ToolOutputHandle): void {
    if (!this.persistence || (handle.fullContent?.length ?? 0) < this.spillThresholdChars) return;
    const persistence = this.persistence;
    const content = handle.fullContent!;
    handle.spillPromise = persistence.write(toPersistedRecord(handle), content).then(async path => {
      if (handle.evicted) {
        await persistence.delete(path);
        return;
      }
      handle.filePath = path;
      handle.fullContent = undefined;
    }).catch(() => {
      // Keep the in-memory copy if persistence is temporarily unavailable.
    });
  }

  private resolveRestartPersistenceNoticesValue(value: unknown, chatSessionId: string): unknown {
    if (typeof value === 'string') {
      return this.resolveRestartPersistenceNoticeString(value, chatSessionId);
    }
    if (Array.isArray(value)) {
      return value.map(entry => this.resolveRestartPersistenceNoticesValue(entry, chatSessionId));
    }
    if (!value || typeof value !== 'object') return value;

    const record = value as Record<string, unknown>;
    const handleId = typeof record.handleId === 'string' ? record.handleId : undefined;
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => {
      if (typeof entry === 'string' && handleId && this.isHandleRestartPersistent(handleId, chatSessionId)) {
        return [key, removeRestartPersistenceWarning(entry)];
      }
      return [key, this.resolveRestartPersistenceNoticesValue(entry, chatSessionId)];
    }));
  }

  private resolveRestartPersistenceNoticeString(value: string, chatSessionId: string): string {
    const handleIds = [...value.matchAll(/handleId=(tool-output-[A-Za-z0-9-]+)/g)]
      .map(match => match[1]);
    if (!handleIds.length) return value;
    return handleIds.every(handleId => this.isHandleRestartPersistent(handleId, chatSessionId))
      ? removeRestartPersistenceWarning(value)
      : value;
  }

  private isHandleRestartPersistent(handleId: string, chatSessionId: string): boolean {
    return Boolean(this.bySession.get(chatSessionId)?.get(handleId)?.filePath);
  }

  private enforceSessionLimits(chatSessionId: string, sessionMap: Map<string, ToolOutputHandle>): void {
    const totalChars = () => [...sessionMap.values()].reduce((sum, item) => sum + item.storedChars, 0);
    while (
      sessionMap.size > this.maxHandlesPerSession
      || totalChars() > this.maxCharsPerSession
    ) {
      const oldest = [...sessionMap.values()].sort((a, b) => a.accessedAt - b.accessedAt)[0];
      if (!oldest) break;
      sessionMap.delete(oldest.id);
      this.evictHandle(oldest);
    }
    if (sessionMap.size === 0) this.bySession.delete(chatSessionId);
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [chatSessionId, sessionMap] of this.bySession) {
      for (const [handleId, handle] of sessionMap) {
        if (handle.accessedAt > cutoff) continue;
        sessionMap.delete(handleId);
        if (!handle.filePath) this.evictHandle(handle);
      }
      if (sessionMap.size === 0) this.bySession.delete(chatSessionId);
    }
  }

  private enforceGlobalLimits(): void {
    const allHandles = () => [...this.bySession.entries()].flatMap(([chatSessionId, sessionMap]) => (
      [...sessionMap.values()].map(handle => ({ chatSessionId, sessionMap, handle }))
    ));
    while (true) {
      const entries = allHandles();
      const totalChars = entries.reduce((sum, entry) => sum + entry.handle.storedChars, 0);
      if (entries.length <= this.maxHandlesGlobal && totalChars <= this.maxCharsGlobal) break;
      const oldest = entries.sort((a, b) => a.handle.accessedAt - b.handle.accessedAt)[0];
      if (!oldest) break;
      oldest.sessionMap.delete(oldest.handle.id);
      this.evictHandle(oldest.handle);
      if (oldest.sessionMap.size === 0) this.bySession.delete(oldest.chatSessionId);
    }
  }

  private evictHandle(handle: ToolOutputHandle): void {
    handle.evicted = true;
    if (!handle.filePath || !this.persistence) return;
    if (this.isPathReferencedByOtherHandles(handle.filePath, handle)) {
      // Another session (a branch alias) still reads from this durable file;
      // defer the delete until the last reference drops and then sweep it.
      this.deferredPathDeletes.add(handle.filePath);
      void this.processDeferredPathDeletes();
      return;
    }
    void this.persistence.delete(handle.filePath).catch(() => {});
    void this.processDeferredPathDeletes();
  }

  private async restoreHandle(handleId: string, chatSessionId: string): Promise<ToolOutputHandle | undefined> {
    if (!this.persistence?.restore) return undefined;
    const pendingDeletion = this.sessionDeletionPromises.get(chatSessionId);
    if (pendingDeletion) await pendingDeletion;
    const key = `${chatSessionId}:${handleId}`;
    const pending = this.restorePromises.get(key);
    if (pending) return pending;

    const generation = this.sessionGenerations.get(chatSessionId) ?? 0;
    const terminalMutationGenerations = new Map(this.terminalMutationGenerations);
    const restorePromise = this.restoreHandleImpl(
      handleId,
      chatSessionId,
      generation,
      terminalMutationGenerations,
    ).finally(() => {
      this.restorePromises.delete(key);
      this.cleanupSessionGeneration(chatSessionId);
      this.enforceSessionDeletionMetadataLimit();
      this.cleanupTerminalMutationMetadataForChat(chatSessionId);
    });
    this.restorePromises.set(key, restorePromise);
    return restorePromise;
  }

  private async restoreHandleImpl(
    handleId: string,
    chatSessionId: string,
    generation: number,
    terminalMutationGenerations: Map<string, number>,
  ): Promise<ToolOutputHandle | undefined> {
    const restored = await this.persistence?.restore?.(handleId, chatSessionId);
    if (!restored || !isValidPersistedRecord(restored.record, handleId, chatSessionId)) return undefined;
    const restoredTerminalKey = restored.record.terminalSessionId
      ? `${chatSessionId}:${restored.record.terminalSessionId}`
      : undefined;
    if (
      this.failedSessionDeletions.has(chatSessionId)
      || this.lifecycleDenyFilter.has(`chat:${chatSessionId}`)
      || (this.sessionGenerations.get(chatSessionId) ?? 0) !== generation
      || (
        restoredTerminalKey
        && (this.terminalMutationGenerations.get(restoredTerminalKey) ?? 0)
          !== (terminalMutationGenerations.get(restoredTerminalKey) ?? 0)
      )
      || (
        restoredTerminalKey
        && (
          this.deletedTerminalSessions.has(restoredTerminalKey)
          || this.lifecycleDenyFilter.has(`terminal-key:${restoredTerminalKey}`)
        )
      )
      || (
        restored.record.terminalSessionId
        && (
          this.closedTerminalSessions.has(restored.record.terminalSessionId)
          || this.lifecycleDenyFilter.has(`closed-terminal:${restored.record.terminalSessionId}`)
        )
      )
    ) {
      void this.persistence?.delete(restored.path).catch(() => {});
      return undefined;
    }

    const record = restored.record;
    const handle: ToolOutputHandle = {
      id: record.handleId,
      chatSessionId: record.chatSessionId,
      capabilityId: record.capabilityId,
      sessionId: record.terminalSessionId,
      totalChars: record.totalChars,
      storedChars: record.storedChars,
      sourceTruncated: record.sourceTruncated,
      preview: record.preview,
      storedAt: record.storedAt,
      accessedAt: this.now(),
      filePath: restored.path,
    };
    const sessionMap = this.bySession.get(chatSessionId) ?? new Map<string, ToolOutputHandle>();
    const existing = sessionMap.get(handleId);
    if (existing) return existing;
    sessionMap.set(handleId, handle);
    this.bySession.set(chatSessionId, sessionMap);
    this.enforceSessionLimits(chatSessionId, sessionMap);
    this.enforceGlobalLimits();
    return sessionMap.get(handleId);
  }

  private removeHandle(handle: ToolOutputHandle): void {
    const sessionMap = this.bySession.get(handle.chatSessionId);
    sessionMap?.delete(handle.id);
    if (sessionMap?.size === 0) this.bySession.delete(handle.chatSessionId);
    this.evictHandle(handle);
  }

  private cleanupSessionGeneration(chatSessionId: string): void {
    if (this.sessionDeletionPromises.has(chatSessionId)) return;
    if (this.failedSessionDeletions.has(chatSessionId)) return;
    if (this.hasPendingRestoreForChat(chatSessionId)) return;
    this.sessionGenerations.delete(chatSessionId);
  }

  private enforceSessionDeletionMetadataLimit(): void {
    while (this.failedSessionDeletions.size > TOOL_OUTPUT_MAX_FAILED_SESSION_DELETIONS) {
      let removed = false;
      for (const chatSessionId of this.failedSessionDeletions) {
        if (
          this.sessionDeletionPromises.has(chatSessionId)
          || this.hasPendingRestoreForChat(chatSessionId)
        ) {
          continue;
        }
        this.failedSessionDeletions.delete(chatSessionId);
        this.sessionGenerations.delete(chatSessionId);
        removed = true;
        break;
      }
      if (!removed) break;
    }
  }

  private cleanupTerminalMutationMetadata(terminalKey: string, chatSessionId: string): void {
    if (this.terminalDeletionPromises.has(terminalKey)) return;
    if (this.failedTerminalDeletions.has(terminalKey)) return;
    if (this.hasPendingRestoreForChat(chatSessionId)) return;
    if (this.persistence?.restore && !this.persistence.deleteTerminalSession) return;
    this.terminalMutationGenerations.delete(terminalKey);
    this.deletedTerminalSessions.delete(terminalKey);
  }

  private cleanupTerminalMutationMetadataForChat(chatSessionId: string): void {
    const terminalPrefix = `${chatSessionId}:`;
    for (const terminalKey of this.terminalMutationGenerations.keys()) {
      if (terminalKey.startsWith(terminalPrefix)) {
        this.cleanupTerminalMutationMetadata(terminalKey, chatSessionId);
      }
    }
    this.enforceTerminalMutationMetadataLimit();
  }

  private hasPendingRestoreForChat(chatSessionId: string): boolean {
    const restorePrefix = `${chatSessionId}:`;
    return [...this.restorePromises.keys()].some(key => key.startsWith(restorePrefix));
  }

  private enforceTerminalMutationMetadataLimit(): void {
    while (this.deletedTerminalSessions.size > TOOL_OUTPUT_MAX_CLOSED_TERMINAL_SESSIONS) {
      let removed = false;
      for (const [terminalKey, chatSessionId] of this.deletedTerminalSessions) {
        if (
          this.terminalDeletionPromises.has(terminalKey)
          || this.hasPendingRestoreForChat(chatSessionId)
        ) {
          continue;
        }
        this.deletedTerminalSessions.delete(terminalKey);
        this.terminalMutationGenerations.delete(terminalKey);
        this.failedTerminalDeletions.delete(terminalKey);
        removed = true;
        break;
      }
      if (!removed) break;
    }
  }
}

function removeRestartPersistenceWarning(value: string): string {
  return value
    .replace(' restartPersistence=unavailable (read before closing the app)', '')
    .replace('This saved output is available only until the app closes. Read this handle before closing the app.', '')
    .replace(
      'Full file content is available only until the app closes. Use tool_output_read now.',
      'Full file content stored. Use tool_output_read with this handleId to read more.',
    )
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

function toPersistedRecord(handle: ToolOutputHandle): PersistedToolOutputRecord {
  return {
    schemaVersion: 1,
    handleId: handle.id,
    chatSessionId: handle.chatSessionId,
    capabilityId: handle.capabilityId,
    terminalSessionId: handle.sessionId,
    totalChars: handle.totalChars,
    storedChars: handle.storedChars,
    sourceTruncated: handle.sourceTruncated,
    preview: handle.preview,
    storedAt: handle.storedAt,
    accessedAt: handle.accessedAt,
  };
}

function isValidPersistedRecord(
  record: PersistedToolOutputRecord,
  handleId: string,
  chatSessionId: string,
): boolean {
  return record?.schemaVersion === 1
    && record.handleId === handleId
    && record.chatSessionId === chatSessionId
    && typeof record.capabilityId === 'string'
    && record.capabilityId.length > 0
    && Number.isFinite(record.totalChars)
    && record.totalChars >= 0
    && Number.isFinite(record.storedChars)
    && record.storedChars >= 0
    && record.storedChars <= TOOL_OUTPUT_MAX_HANDLE_CHARS
    && typeof record.sourceTruncated === 'boolean'
    && typeof record.preview === 'string'
    && Number.isFinite(record.storedAt)
    && Number.isFinite(record.accessedAt);
}

function retainBoundedContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const marker = `\n\n[... source output exceeded local handle limit; ${content.length - maxChars} chars omitted ...]\n\n`;
  if (marker.length >= maxChars) return content.slice(0, maxChars);
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.floor(budget / 2);
  const tail = budget - head;
  return `${content.slice(0, head)}${marker}${content.slice(-tail)}`;
}

function buildReadResult(
  handle: ToolOutputHandle,
  content: string,
  input: ReadToolOutputInput,
): ToolOutputReadResult {
    const requestedMax = Number.isFinite(input.maxChars)
      ? Math.floor(input.maxChars!)
      : TOOL_OUTPUT_READ_MAX_CHARS;
    const maxChars = Math.min(TOOL_OUTPUT_READ_MAX_CHARS, Math.max(1, requestedMax));
    const mode = input.mode ?? 'head';

    if (mode === 'search') {
      const query = input.query ?? '';
      if (!query) {
        return {
          handleId: handle.id,
          mode,
          content: 'Search query is required.',
          totalChars: handle.totalChars,
          storedChars: handle.storedChars,
          sourceTruncated: handle.sourceTruncated,
          startOffset: 0,
          endOffset: 0,
          nextOffset: 0,
          hasMore: false,
          matchOffsets: [],
        };
      }
      const haystack = content.toLocaleLowerCase();
      const needle = query.toLocaleLowerCase();
      const offsets: number[] = [];
      let cursor = Math.max(0, Math.floor(input.offset ?? 0));
      while (offsets.length < TOOL_OUTPUT_SEARCH_MAX_MATCHES) {
        const match = haystack.indexOf(needle, cursor);
        if (match < 0) break;
        offsets.push(match);
        cursor = match + Math.max(1, needle.length);
      }
      const excerpts: string[] = [];
      const renderedOffsets: number[] = [];
      let renderedChars = 0;
      for (const match of offsets) {
        const [start, end] = safeSliceBounds(
          content,
          match - TOOL_OUTPUT_SEARCH_CONTEXT_CHARS,
          match + query.length + TOOL_OUTPUT_SEARCH_CONTEXT_CHARS,
        );
        const excerpt = `[match offset=${match}]\n${content.slice(start, end)}`;
        const separator = excerpts.length > 0 ? '\n\n' : '';
        const available = maxChars - renderedChars - separator.length;
        if (available <= 0) break;
        if (excerpt.length > available) {
          if (excerpts.length > 0) break;
          const [, safeEnd] = safeSliceBounds(excerpt, 0, available);
          excerpts.push(excerpt.slice(0, safeEnd));
          renderedOffsets.push(match);
          renderedChars += safeEnd;
          break;
        }
        excerpts.push(excerpt);
        renderedOffsets.push(match);
        renderedChars += separator.length + excerpt.length;
      }
      const rendered = excerpts.join('\n\n');
      const nextOffset = renderedOffsets.length > 0
        ? renderedOffsets[renderedOffsets.length - 1] + Math.max(1, query.length)
        : content.length;
      return {
        handleId: handle.id,
        mode,
        content: rendered || `No matches found for "${query}".`,
        totalChars: handle.totalChars,
        storedChars: handle.storedChars,
        sourceTruncated: handle.sourceTruncated,
        startOffset: Math.max(0, Math.floor(input.offset ?? 0)),
        endOffset: nextOffset,
        nextOffset,
        hasMore: haystack.indexOf(needle, nextOffset) >= 0,
        matchOffsets: renderedOffsets,
      };
    }

    let startOffset = 0;
    if (mode === 'tail') {
      startOffset = Math.max(0, content.length - maxChars);
    } else if (mode === 'range') {
      startOffset = Math.min(content.length, Math.max(0, Math.floor(input.offset ?? 0)));
    }
    const [safeStartOffset, safeEndOffset] = safeSliceBounds(
      content,
      startOffset,
      startOffset + maxChars,
    );
    startOffset = safeStartOffset;
    const selected = content.slice(startOffset, safeEndOffset);
    const endOffset = safeEndOffset;
    return {
      handleId: handle.id,
      mode,
      content: selected,
      totalChars: handle.totalChars,
      storedChars: handle.storedChars,
      sourceTruncated: handle.sourceTruncated,
      startOffset,
      endOffset,
      nextOffset: endOffset,
      hasMore: endOffset < content.length,
    };
}

export const globalToolOutputStore = new ToolOutputStore();
