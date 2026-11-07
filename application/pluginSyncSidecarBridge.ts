/**
 * Renderer bridge for plugin encrypted-sync sidecars.
 * Collects/applies sidecars through the main-process non-cascade store when
 * the plugin host is available. When the host is offline, last-known sidecars
 * are retained so cloud uploads cannot wipe previously synced plugin data.
 */

import type { PluginSyncSidecarBundle } from '../domain/pluginSyncSidecar';
import { SYNC_STORAGE_KEYS } from '../domain/sync';
import { localStorageAdapter } from '../infrastructure/persistence/localStorageAdapter';

/** Ordinary upload fallback when collect cannot reach the host. */
const LAST_KNOWN_SIDECARS_KEY = SYNC_STORAGE_KEYS.PLUGIN_SIDECARS_LAST_KNOWN;
/**
 * Remote apply that could not reach the host DB. Distinct from last-known so
 * a later collect does not re-apply a stale post-collect snapshot over newer
 * local plugin settings.
 */
const PENDING_REMOTE_SIDECARS_KEY = SYNC_STORAGE_KEYS.PLUGIN_SIDECARS_PENDING_REMOTE;
const HOST_UNAVAILABLE_MARKER = 'PLUGIN_SIDECAR_HOST_UNAVAILABLE';

export class PluginSidecarHostUnavailableError extends Error {
  readonly code = HOST_UNAVAILABLE_MARKER;

  constructor(message = 'Plugin sidecar host is unavailable') {
    super(message);
    this.name = 'PluginSidecarHostUnavailableError';
  }
}

export function isPluginSidecarHostUnavailableError(error: unknown): boolean {
  if (error instanceof PluginSidecarHostUnavailableError) return true;
  if (!error || typeof error !== 'object') return false;
  const maybe = error as { code?: unknown; message?: unknown };
  if (maybe.code === HOST_UNAVAILABLE_MARKER) return true;
  return typeof maybe.message === 'string'
    && maybe.message.includes('Plugin sidecar host is unavailable');
}

type ElectronSidecarApi = {
  collectPluginSyncSidecars?: () => Promise<PluginSyncSidecarBundle | null | undefined>;
  applyPluginSyncSidecars?: (
    bundle: PluginSyncSidecarBundle | null | undefined,
  ) => Promise<unknown>;
  /** True only when main process wired PluginSyncSidecarService. */
  pluginHostReady?: () => boolean;
};

function getSidecarApi(): ElectronSidecarApi | null {
  if (typeof window === 'undefined') return null;
  // Preload exposes the production bridge as window.netcatty only.
  const bridge = (window as Window & {
    netcatty?: ElectronSidecarApi;
    electron?: ElectronSidecarApi;
  }).netcatty
    ?? (window as Window & { electron?: ElectronSidecarApi }).electron;
  return bridge ?? null;
}

/**
 * Whether the main-process sidecar service is wired. Version-change backups
 * should wait for this (or a grace timeout) before latching, otherwise an
 * early empty collect permanently skips plugin settings in the upgrade snapshot.
 */
export function isPluginSidecarHostReady(): boolean {
  const api = getSidecarApi();
  if (!api) return false;
  if (typeof api.pluginHostReady === 'function') {
    try {
      return api.pluginHostReady() === true;
    } catch {
      return false;
    }
  }
  // Older / test bridges without the probe: collect presence implies ready.
  return typeof api.collectPluginSyncSidecars === 'function';
}

function readBundle(key: string): PluginSyncSidecarBundle | null {
  const raw = localStorageAdapter.read<PluginSyncSidecarBundle>(key);
  if (!raw || !Array.isArray(raw.entries)) return null;
  return { version: 1, entries: raw.entries };
}

function writeBundle(key: string, bundle: PluginSyncSidecarBundle | null | undefined): void {
  if (!bundle || !Array.isArray(bundle.entries)) {
    localStorageAdapter.remove(key);
    return;
  }
  const ok = localStorageAdapter.write(key, {
    version: 1,
    entries: bundle.entries,
  });
  if (ok === false) {
    throw new Error(
      `Failed to persist plugin sidecars (${key}); local storage write was rejected`,
    );
  }
}

function readLastKnownSidecars(): PluginSyncSidecarBundle | null {
  return readBundle(LAST_KNOWN_SIDECARS_KEY);
}

function writeLastKnownSidecars(bundle: PluginSyncSidecarBundle | null | undefined): void {
  writeBundle(LAST_KNOWN_SIDECARS_KEY, bundle);
}

/** null means no pending remote apply. Empty entries is a valid pending reset. */
function readPendingRemoteSidecars(): PluginSyncSidecarBundle | null {
  const raw = localStorageAdapter.read<PluginSyncSidecarBundle | null>(PENDING_REMOTE_SIDECARS_KEY);
  if (raw == null) return null;
  if (!Array.isArray(raw.entries)) return null;
  return { version: 1, entries: raw.entries };
}

function writePendingRemoteSidecars(bundle: PluginSyncSidecarBundle): void {
  const ok = localStorageAdapter.write(PENDING_REMOTE_SIDECARS_KEY, {
    version: 1,
    entries: bundle.entries,
  });
  if (ok === false) {
    // Operational failure — must not look like host-unavailable (which apply
    // swallows). Sync must abort so the remote bundle is not lost.
    throw new Error(
      'Failed to queue pending remote plugin sidecars; local storage write was rejected',
    );
  }
}

function clearPendingRemoteSidecars(): void {
  localStorageAdapter.remove(PENDING_REMOTE_SIDECARS_KEY);
}

function isAuthoritativeBundle(
  value: unknown,
): value is PluginSyncSidecarBundle {
  return Boolean(
    value
    && typeof value === 'object'
    && Array.isArray((value as PluginSyncSidecarBundle).entries),
  );
}

function isSuccessfulApplyResult(result: unknown): boolean {
  if (result == null) return false;
  if (
    typeof result === 'object'
    && result !== null
    && 'applied' in result
    && (result as { applied?: unknown }).applied === false
  ) {
    return false;
  }
  return true;
}

/**
 * Returns:
 * - a real bundle (possibly empty entries) when the host collected successfully
 * - last-known bundle when the host is unavailable (protect remote from wipe)
 * Throws on operational host failure (DB/runtime error) so sync aborts.
 *
 * Pending remote applies (host was offline during download) are replayed into
 * the DB before collection. Ordinary last-known collect snapshots are never
 * re-applied, so local settings edits made after the last collect are kept.
 */
export async function collectPluginSyncSidecarsFromHost(options: {
  /**
   * When true, never fall back to last-known cache. Returns null if the host is
   * gated off / non-authoritative so callers can omit `pluginSidecars` instead
   * of applying a stale cache snapshot (e.g. convergent conflict materialize).
   */
  liveOnly?: boolean;
} = {}): Promise<PluginSyncSidecarBundle | null> {
  const liveOnly = options.liveOnly === true;
  const api = getSidecarApi();
  if (typeof api?.collectPluginSyncSidecars !== 'function') {
    return liveOnly ? null : readLastKnownSidecars();
  }

  const pendingRemote = readPendingRemoteSidecars();
  if (pendingRemote && typeof api.applyPluginSyncSidecars === 'function') {
    try {
      const replayResult = await api.applyPluginSyncSidecars(pendingRemote);
      if (!isSuccessfulApplyResult(replayResult)) {
        // Upload path: keep returning pending so we do not push stale local
        // over an authoritative remote still waiting to apply.
        // liveOnly (conflict materialize): omit instead of attaching the queue.
        return liveOnly ? null : pendingRemote;
      }
      clearPendingRemoteSidecars();
    } catch (error) {
      // Operational failure: keep pending and surface so upload aborts.
      // Host-unavailable during replay: upload keeps pending; liveOnly omits.
      if (isPluginSidecarHostUnavailableError(error)) {
        return liveOnly ? null : pendingRemote;
      }
      throw error;
    }
  } else if (pendingRemote && typeof api.applyPluginSyncSidecars !== 'function') {
    return liveOnly ? null : pendingRemote;
  }

  const bundle = await api.collectPluginSyncSidecars();
  // Passive/null means the plugin host is gated off or manager resolution failed.
  // Do not treat that as an authoritative empty bundle (would wipe last-known).
  if (bundle == null || !isAuthoritativeBundle(bundle)) {
    return liveOnly ? null : readLastKnownSidecars();
  }
  const normalized: PluginSyncSidecarBundle = {
    version: 1,
    entries: bundle.entries,
  };
  // Defer overwriting a non-empty last-known with an authoritative empty collect.
  // useAutoSync runs hasMeaningfulCloudSyncData() after buildPayload/collect; if
  // we erased last-known here, a deliberate plugin-only reset (entries → [])
  // would look like an empty vault and be blocked. Commit the empty cache after
  // a successful upload via commitPluginSidecarsLastKnown().
  const previous = readLastKnownSidecars();
  const previousHadEntries = Array.isArray(previous?.entries) && previous.entries.length > 0;
  if (!(previousHadEntries && normalized.entries.length === 0)) {
    writeLastKnownSidecars(normalized);
  }
  return normalized;
}

/**
 * Persist the sidecar bundle that was just successfully synced (or applied).
 * Clears a deferred non-empty last-known after an empty reset upload.
 */
export function commitPluginSidecarsLastKnown(
  bundle: PluginSyncSidecarBundle | null | undefined,
): void {
  if (!bundle || !Array.isArray(bundle.entries)) {
    writeLastKnownSidecars({ version: 1, entries: [] });
    return;
  }
  writeLastKnownSidecars({ version: 1, entries: bundle.entries });
}

/**
 * After a successful cloud upload/download round-trip, finalize the deferred
 * last-known sidecar cache. Prefer merged/downloaded payload sidecars when
 * present so we do not overwrite a remote apply with the pre-sync local collect.
 */
export function commitPluginSidecarsAfterSuccessfulSync(
  payload: { pluginSidecars?: PluginSyncSidecarBundle | null },
  results: Iterable<{
    success?: boolean;
    mergedPayload?: { pluginSidecars?: PluginSyncSidecarBundle | null } | null;
  }>,
): void {
  const resultList = Array.from(results);
  if (!resultList.some((result) => result.success === true)) return;

  let commitSidecars: PluginSyncSidecarBundle | undefined;
  if (Object.prototype.hasOwnProperty.call(payload, 'pluginSidecars')) {
    commitSidecars = {
      version: 1,
      entries: Array.isArray(payload.pluginSidecars?.entries) ? payload.pluginSidecars.entries : [],
    };
  }
  for (const result of resultList) {
    if (
      result.mergedPayload
      && Object.prototype.hasOwnProperty.call(result.mergedPayload, 'pluginSidecars')
    ) {
      commitSidecars = {
        version: 1,
        entries: Array.isArray(result.mergedPayload.pluginSidecars?.entries)
          ? result.mergedPayload.pluginSidecars.entries
          : [],
      };
      break;
    }
  }
  if (commitSidecars) commitPluginSidecarsLastKnown(commitSidecars);
}

export async function applyPluginSyncSidecarsFromHost(
  bundle: PluginSyncSidecarBundle | null | undefined,
): Promise<void> {
  // Empty bundle is authoritative (cloud deleted all sidecars) — still apply.
  const normalized: PluginSyncSidecarBundle = {
    version: 1,
    entries: Array.isArray(bundle?.entries) ? bundle.entries : [],
  };
  const api = getSidecarApi();
  if (typeof api?.applyPluginSyncSidecars !== 'function') {
    // Host offline: queue remote apply for later DB replay, and keep last-known
    // for upload protection so cloud is not wiped with empty collect.
    writePendingRemoteSidecars(normalized);
    writeLastKnownSidecars(normalized);
    throw new PluginSidecarHostUnavailableError(
      'Plugin sidecar host is unavailable; cannot apply downloaded sidecars',
    );
  }
  const result = await api.applyPluginSyncSidecars(normalized);
  // Passive IPC returns null when the manager is unavailable, or
  // { applied: false } when the sidecar service was not wired.
  if (!isSuccessfulApplyResult(result)) {
    writePendingRemoteSidecars(normalized);
    writeLastKnownSidecars(normalized);
    throw new PluginSidecarHostUnavailableError(
      'Plugin sidecar host is unavailable; cannot apply downloaded sidecars',
    );
  }
  clearPendingRemoteSidecars();
  // Prefer merged entries returned by apply (includes missing-plugin rows the
  // remote omitted) when refreshing last-known without a successful collect.
  const appliedMerged: PluginSyncSidecarBundle | null = Array.isArray(
    (result as { entries?: unknown }).entries,
  )
    ? { version: 1, entries: (result as { entries: PluginSyncSidecarBundle['entries'] }).entries }
    : null;
  const fallbackLastKnown = appliedMerged ?? normalized;
  // Prefer a fresh host collect so last-known reflects post-apply host state.
  if (typeof api.collectPluginSyncSidecars === 'function') {
    try {
      const collected = await api.collectPluginSyncSidecars();
      if (isAuthoritativeBundle(collected)) {
        writeLastKnownSidecars({ version: 1, entries: collected.entries });
        return;
      }
      // Apply already committed; collect shape was non-authoritative. Prefer the
      // merged apply result over the raw remote so preserved local rows survive.
      writeLastKnownSidecars(fallbackLastKnown);
      return;
    } catch {
      // Apply already committed. Do not fall back to the raw remote bundle —
      // that would drop missing-plugin rows applyFromSync preserved.
      try {
        writeLastKnownSidecars(fallbackLastKnown);
      } catch {
        // last-known write failure is secondary; apply already succeeded.
      }
      return;
    }
  }
  // No collect API: use merged apply result when available, else remote.
  writeLastKnownSidecars(fallbackLastKnown);
}
