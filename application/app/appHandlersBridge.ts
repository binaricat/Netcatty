/**
 * Stable accessor bridge for App-local handlers that Host islands need when
 * assembling domain bags. `AppSideEffects` registers the live glue via
 * `useLayoutEffect`; Hosts call `getAppHandlers()` instead of receiving mega
 * props from App.
 *
 * Keep this intentionally loose (`Record<string, unknown>`): the handler set
 * tracks App glue, not a frozen public API.
 */

type Listener = () => void;

export type AppHandlers = Record<string, unknown>;

function handlersShallowEqual(prev: AppHandlers, next: AppHandlers): boolean {
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length !== nextKeys.length) return false;
  for (const key of nextKeys) {
    if (prev[key] !== next[key]) return false;
  }
  return true;
}

class AppHandlersBridge {
  private handlers: AppHandlers | null = null;
  private listeners = new Set<Listener>();

  get = (): AppHandlers | null => this.handlers;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  set(next: AppHandlers | null): void {
    if (this.handlers === next) return;
    if (
      this.handlers
      && next
      && handlersShallowEqual(this.handlers, next)
    ) {
      return;
    }
    this.handlers = next;
    for (const listener of this.listeners) listener();
  }
}

const bridge = new AppHandlersBridge();

export type StableAppHandlerCache = Map<string, { latest: unknown; stable: unknown }>;

/**
 * Give every function-valued handler a per-key wrapper with a stable identity
 * that always calls the latest implementation; non-functions (refs) pass
 * through. Many glue callbacks close over sessions/workspaces/hosts, so their
 * identities changed on every session status change and host update (connect
 * bursts, last-connected times), and the bridge re-notified every Host island,
 * rebuilding all shell bags and re-rendering AppView/TopTabs each time. The
 * handlers are actions invoked from events, never read during render.
 */
export function stabilizeAppHandlers(cache: StableAppHandlerCache, handlers: AppHandlers): AppHandlers {
  const stableHandlers: AppHandlers = {};
  for (const [key, value] of Object.entries(handlers)) {
    if (typeof value !== 'function') {
      stableHandlers[key] = value;
      continue;
    }
    let entry = cache.get(key);
    if (!entry) {
      const created: { latest: unknown; stable: unknown } = { latest: value, stable: null };
      created.stable = (...args: unknown[]) => (created.latest as (...callArgs: unknown[]) => unknown)(...args);
      cache.set(key, created);
      entry = created;
    }
    entry.latest = value;
    stableHandlers[key] = entry.stable;
  }
  return stableHandlers;
}

export function registerAppHandlers(handlers: AppHandlers | null): void {
  bridge.set(handlers);
}

export function getAppHandlers(): AppHandlers | null {
  return bridge.get();
}

export function subscribeAppHandlers(listener: Listener): () => void {
  return bridge.subscribe(listener);
}
