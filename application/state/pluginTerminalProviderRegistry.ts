import {
  getSharedPluginRuntimeStatus,
  invalidateSharedPluginRuntimeStatus,
} from './pluginRuntimeStatusCache';

export interface PluginTerminalProviderBridge {
  listPluginTerminalProviders(options: NetcattyTerminalProviderQuery): Promise<ReadonlyArray<NetcattyTerminalProviderContribution>>;
  providePluginTerminal(request: NetcattyTerminalProviderRequest): Promise<ReadonlyArray<NetcattyTerminalProviderResult>>;
  cancelPluginTerminalRequest(requestId: string): Promise<boolean>;
  publishPluginTerminalSessionEvent(event: NetcattyTerminalSessionEvent): Promise<ReadonlyArray<{ pluginId: string; delivered: boolean }>>;
  getPluginRuntimeStatus?(): Promise<NetcattyPluginRuntimeStatus>;
  onPluginContributionsChanged?(callback: () => void): () => void;
}

export interface PluginTerminalProviderResponse {
  readonly requestId: string;
  readonly stale: boolean;
  readonly results: ReadonlyArray<NetcattyTerminalProviderResult>;
}

export interface PluginTerminalProviderRequestOptions {
  readonly signal?: AbortSignal;
}

function freezeValue<T>(value: T): Readonly<T> {
  const clone = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return;
    for (const child of Array.isArray(item) ? item : Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(clone);
  return clone as Readonly<T>;
}

function requestKey(sessionId: string, kind: NetcattyTerminalProviderKind, supersessionKey: string): string {
  return `${sessionId}\0${kind}\0${supersessionKey}`;
}

function createRequestId(): string {
  return `terminal-${crypto.randomUUID()}`;
}

function mergeLifecycleSessionSnapshot(
  previous: NetcattyTerminalSessionSnapshot | undefined,
  event: NetcattyTerminalSessionEvent,
): Readonly<NetcattyTerminalSessionSnapshot> {
  const session: NetcattyTerminalSessionSnapshot = { ...(previous ?? {}), ...event.session };
  if (event.type === 'disconnected' || event.type === 'reconnected') {
    if (!Object.hasOwn(event.session, 'cwd')) delete session.cwd;
    if (!Object.hasOwn(event.session, 'title')) delete session.title;
    if (!Object.hasOwn(event.session, 'alternateScreen')) delete session.alternateScreen;
  }
  if (event.type === 'cwdChanged' && !Object.hasOwn(event.session, 'cwd')) delete session.cwd;
  if (event.type === 'titleChanged' && !Object.hasOwn(event.session, 'title')) delete session.title;
  return freezeValue(session);
}

export class PluginTerminalProviderRegistry {
  readonly #bridge: PluginTerminalProviderBridge;
  readonly #statusBridge: Pick<NetcattyBridge, 'getPluginRuntimeStatus'>;
  readonly #activeRequests = new Map<string, string>();
  readonly #sessionSnapshots = new Map<string, NetcattyTerminalSessionSnapshot>();
  readonly #providerListeners = new Set<() => void>();
  readonly #providerListCache = new Map<string, ReadonlyArray<NetcattyTerminalProviderContribution>>();
  readonly #pendingProviderLists = new Map<string, Promise<ReadonlyArray<NetcattyTerminalProviderContribution>>>();
  readonly #disposeContributionListener: (() => void) | undefined;
  #providerListGeneration = 0;
  #bridgeAvailability: 'unknown' | 'available' | 'unavailable' = 'unknown';
  #disposed = false;

  constructor(
    bridge: PluginTerminalProviderBridge,
    statusBridge: Pick<NetcattyBridge, 'getPluginRuntimeStatus'> = bridge,
  ) {
    this.#bridge = bridge;
    this.#statusBridge = statusBridge;
    this.#disposeContributionListener = bridge.onPluginContributionsChanged?.(() => {
      this.#providerListGeneration += 1;
      this.#bridgeAvailability = 'unknown';
      invalidateSharedPluginRuntimeStatus(this.#statusBridge);
      this.#providerListCache.clear();
      this.#pendingProviderLists.clear();
      for (const requestId of this.#activeRequests.values()) {
        void this.#bridge.cancelPluginTerminalRequest(requestId).catch(() => false);
      }
      this.#activeRequests.clear();
      for (const listener of [...this.#providerListeners]) {
        try { listener(); } catch { /* isolate application listeners */ }
      }
    });
  }

  #isUnavailable(): boolean {
    return this.#disposed || this.#bridgeAvailability === 'unavailable';
  }

  async #probeRuntimeStatus(generation: number): Promise<boolean> {
    try {
      const status = await getSharedPluginRuntimeStatus(this.#statusBridge);
      if (this.#disposed) return false;
      if (generation !== this.#providerListGeneration) {
        return this.#bridgeAvailability !== 'unavailable';
      }
      if (!status.available) {
        this.#bridgeAvailability = 'unavailable';
        this.#providerListCache.clear();
        return false;
      }
      this.#bridgeAvailability = 'available';
      return true;
    } catch {
      if (!this.#disposed && generation === this.#providerListGeneration) {
        this.#bridgeAvailability = 'unavailable';
        this.#providerListCache.clear();
      }
      return false;
    }
  }

  onDidChangeProviders(listener: () => void): () => void {
    if (this.#disposed) return () => {};
    this.#providerListeners.add(listener);
    return () => this.#providerListeners.delete(listener);
  }

  async listProviders(query: NetcattyTerminalProviderQuery): Promise<ReadonlyArray<NetcattyTerminalProviderContribution>> {
    if (this.#disposed) return Object.freeze([]);
    if (this.#bridgeAvailability === 'unavailable') return Object.freeze([]);
    const key = JSON.stringify(query);
    const cached = this.#providerListCache.get(key);
    if (cached) return cached;
    const pending = this.#pendingProviderLists.get(key);
    if (pending) return pending;
    const generation = this.#providerListGeneration;
    const request = (async () => {
      try {
        if (
          this.#bridgeAvailability === 'unknown'
          && typeof this.#statusBridge.getPluginRuntimeStatus === 'function'
        ) {
          const available = await this.#probeRuntimeStatus(generation);
          if (!available) return Object.freeze([]);
        }
        if (this.#isUnavailable()) {
          return Object.freeze([]);
        }
        const providers = freezeValue(await this.#bridge.listPluginTerminalProviders(query));
        if (generation === this.#providerListGeneration) {
          if (this.#bridgeAvailability !== 'unavailable') this.#bridgeAvailability = 'available';
          this.#providerListCache.set(key, providers);
        }
        return providers;
      } catch (error) {
        if (generation === this.#providerListGeneration) {
          this.#bridgeAvailability = 'unavailable';
          this.#providerListCache.clear();
        }
        throw error;
      } finally {
        if (this.#pendingProviderLists.get(key) === request) this.#pendingProviderLists.delete(key);
      }
    })();
    this.#pendingProviderLists.set(key, request);
    return request;
  }

  async request(
    request: Omit<NetcattyTerminalProviderRequest, 'requestId'> & { supersessionKey?: string },
    options: PluginTerminalProviderRequestOptions = {},
  ): Promise<PluginTerminalProviderResponse> {
    if (this.#disposed || options.signal?.aborted) {
      return Object.freeze({ requestId: '', stale: true, results: Object.freeze([]) });
    }
    const { supersessionKey: rawSupersessionKey, ...providerRequest } = request;
    const supersessionKey = typeof rawSupersessionKey === 'string'
      && rawSupersessionKey.length > 0
      && rawSupersessionKey.length <= 128
      ? rawSupersessionKey
      : 'default';
    const previousSession = this.#sessionSnapshots.get(request.session.sessionId);
    const session = freezeValue({ ...(previousSession ?? {}), ...request.session });
    this.#sessionSnapshots.set(session.sessionId, session);
    const key = requestKey(session.sessionId, request.kind, supersessionKey);
    const previousRequestId = this.#activeRequests.get(key);
    if (previousRequestId) void this.#bridge.cancelPluginTerminalRequest(previousRequestId).catch(() => false);
    const requestId = createRequestId();
    this.#activeRequests.set(key, requestId);
    let bridgeRequestStarted = false;
    let aborted = false;
    let resolveAborted: (() => void) | undefined;
    const abortedRequest = new Promise<{
      readonly status: 'aborted';
    }>((resolve) => {
      resolveAborted = () => resolve({ status: 'aborted' });
    });
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      if (this.#activeRequests.get(key) === requestId) this.#activeRequests.delete(key);
      if (bridgeRequestStarted) {
        void this.#bridge.cancelPluginTerminalRequest(requestId).catch(() => false);
      }
      resolveAborted?.();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (options.signal?.aborted) onAbort();
      if (aborted) {
        return Object.freeze({ requestId, stale: true, results: Object.freeze([]) });
      }
      bridgeRequestStarted = true;
      let bridgeResponse: Promise<ReadonlyArray<NetcattyTerminalProviderResult>>;
      try {
        bridgeResponse = this.#bridge.providePluginTerminal({
          ...providerRequest,
          session,
          requestId,
        });
      } catch (error) {
        bridgeResponse = Promise.reject(error);
      }
      const bridgeRequest = bridgeResponse
        .then(
          (results) => ({ status: 'fulfilled' as const, results }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );
      const outcome = options.signal
        ? await Promise.race([bridgeRequest, abortedRequest])
        : await bridgeRequest;
      if (outcome.status === 'aborted') {
        return Object.freeze({ requestId, stale: true, results: Object.freeze([]) });
      }
      if (outcome.status === 'rejected') {
        const stale = this.#disposed || this.#activeRequests.get(key) !== requestId;
        if (stale) return Object.freeze({ requestId, stale: true, results: Object.freeze([]) });
        throw outcome.error;
      }
      const results = freezeValue(outcome.results);
      const stale = this.#disposed || this.#activeRequests.get(key) !== requestId;
      return Object.freeze({
        requestId,
        stale,
        results: stale ? Object.freeze([]) : results,
      });
    } catch (error) {
      const stale = this.#disposed || this.#activeRequests.get(key) !== requestId;
      if (stale) return Object.freeze({ requestId, stale: true, results: Object.freeze([]) });
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      if (this.#activeRequests.get(key) === requestId) this.#activeRequests.delete(key);
    }
  }

  async publishSessionEvent(event: NetcattyTerminalSessionEvent): Promise<void> {
    if (this.#disposed) return;
    // Short-circuit BEFORE mergeLifecycleSessionSnapshot so disabled plugin
    // hosts never run structuredClone/Object.freeze or retain session snapshots.
    if (this.#bridgeAvailability === 'unavailable') return;
    if (
      this.#bridgeAvailability === 'unknown'
      && typeof this.#statusBridge.getPluginRuntimeStatus === 'function'
    ) {
      const available = await this.#probeRuntimeStatus(this.#providerListGeneration);
      if (!available) return;
    }
    if (this.#isUnavailable()) return;
    const previous = this.#sessionSnapshots.get(event.session.sessionId);
    const session = mergeLifecycleSessionSnapshot(previous, event);
    if (event.type === 'disposed') this.#sessionSnapshots.delete(session.sessionId);
    else this.#sessionSnapshots.set(session.sessionId, session);
    try {
      await this.#bridge.publishPluginTerminalSessionEvent(freezeValue({ ...event, session }));
      this.#bridgeAvailability = 'available';
    } catch (error) {
      this.#bridgeAvailability = 'unavailable';
      throw error;
    }
  }

  cancelSession(sessionId: string): void {
    this.#sessionSnapshots.delete(sessionId);
    for (const [key, requestId] of [...this.#activeRequests]) {
      if (!key.startsWith(`${sessionId}\0`)) continue;
      this.#activeRequests.delete(key);
      void this.#bridge.cancelPluginTerminalRequest(requestId).catch(() => false);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#providerListGeneration += 1;
    for (const requestId of this.#activeRequests.values()) {
      void this.#bridge.cancelPluginTerminalRequest(requestId).catch(() => false);
    }
    this.#activeRequests.clear();
    this.#sessionSnapshots.clear();
    this.#providerListeners.clear();
    this.#providerListCache.clear();
    this.#pendingProviderLists.clear();
    this.#disposeContributionListener?.();
  }
}

export async function collectPluginTerminalProviderKinds(
  registry: PluginTerminalProviderRegistry | null,
  kinds: readonly NetcattyTerminalProviderKind[],
): Promise<ReadonlySet<NetcattyTerminalProviderKind>> {
  if (!registry) return new Set();
  try {
    const enumerations = await Promise.all(kinds.map(async (kind) => ({
      kind,
      providers: await registry.listProviders({ kind }),
    })));
    return new Set(enumerations
      .filter((entry) => entry.providers.length > 0)
      .map((entry) => entry.kind));
  } catch {
    return new Set();
  }
}

export function isPluginTerminalProviderKindAvailable(
  kinds: ReadonlySet<NetcattyTerminalProviderKind> | null,
  kind: NetcattyTerminalProviderKind,
): boolean {
  return kinds?.has(kind) ?? false;
}

export class PluginTerminalProviderAvailability {
  #generation = 0;
  #kinds: ReadonlySet<NetcattyTerminalProviderKind> | null = null;

  async refresh(
    registry: PluginTerminalProviderRegistry | null,
    kinds: readonly NetcattyTerminalProviderKind[],
  ): Promise<boolean> {
    const generation = ++this.#generation;
    const next = await collectPluginTerminalProviderKinds(registry, kinds);
    if (generation !== this.#generation) return false;
    this.#kinds = next;
    return true;
  }

  has(kind: NetcattyTerminalProviderKind): boolean {
    return isPluginTerminalProviderKindAvailable(this.#kinds, kind);
  }
}

export function createWindowPluginTerminalProviderRegistry(
  bridge: NetcattyBridge | undefined = typeof window === 'undefined' ? undefined : netcattyBridge.get(),
): PluginTerminalProviderRegistry | null {
  if (!bridge?.listPluginTerminalProviders
    || !bridge.providePluginTerminal
    || !bridge.cancelPluginTerminalRequest
    || !bridge.publishPluginTerminalSessionEvent) return null;
  return new PluginTerminalProviderRegistry({
    listPluginTerminalProviders: (options) => bridge.listPluginTerminalProviders!(options),
    providePluginTerminal: (request) => bridge.providePluginTerminal!(request),
    cancelPluginTerminalRequest: (requestId) => bridge.cancelPluginTerminalRequest!(requestId),
    publishPluginTerminalSessionEvent: (event) => bridge.publishPluginTerminalSessionEvent!(event),
    getPluginRuntimeStatus: bridge.getPluginRuntimeStatus
      ? () => bridge.getPluginRuntimeStatus!()
      : undefined,
    onPluginContributionsChanged: bridge.onPluginContributionsChanged
      ? (callback) => bridge.onPluginContributionsChanged!(callback)
      : undefined,
  }, bridge);
}

let windowRegistry: PluginTerminalProviderRegistry | null | undefined;

export function getWindowPluginTerminalProviderRegistry(): PluginTerminalProviderRegistry | null {
  if (windowRegistry !== undefined) return windowRegistry;
  if (typeof window === 'undefined') return null;
  windowRegistry = createWindowPluginTerminalProviderRegistry(netcattyBridge.get());
  return windowRegistry;
}
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
