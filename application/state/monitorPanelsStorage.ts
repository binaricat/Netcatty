import { mergeSyncPayloads } from "../../domain/syncMerge";
import { useSyncExternalStore } from "react";
import {
  normalizeMonitorPanels,
  rebaseMonitorPanel,
  type MonitorPanel,
} from "../../domain/monitorPanels";
import { STORAGE_KEY_MONITOR_PANELS } from "../../infrastructure/config/storageKeys";
import {
  localStorageAdapter,
  LOCAL_STORAGE_ADAPTER_CHANGED_EVENT,
} from "../../infrastructure/persistence/localStorageAdapter";
import { withVaultImportLock } from "./vaultManagedImportLock";

export function readMonitorPanels(): MonitorPanel[] {
  return normalizeMonitorPanels(
    localStorageAdapter.read(STORAGE_KEY_MONITOR_PANELS),
  );
}
export function writeMonitorPanels(value: unknown): void {
  if (
    !localStorageAdapter.write(
      STORAGE_KEY_MONITOR_PANELS,
      normalizeMonitorPanels(value),
    )
  )
    throw new Error("monitor.saveFailed");
}
export async function saveMonitorPanel(
  base: MonitorPanel | null,
  next: MonitorPanel,
): Promise<void> {
  return withVaultImportLock("vault", async () =>
    writeMonitorPanels(rebaseMonitorPanel(readMonitorPanels(), base, next)),
  );
}
export async function deleteMonitorPanel(id: string): Promise<void> {
  return withVaultImportLock("vault", async () =>
    writeMonitorPanels(readMonitorPanels().filter((p) => p.id !== id)),
  );
}
/** Rebase a prepared cloud snapshot against edits committed while it was applying. */
export async function applyMonitorPanels(
  value: unknown,
  base: MonitorPanel[],
  replace = false,
): Promise<void> {
  return withVaultImportLock("vault", async () => {
    const remote = normalizeMonitorPanels(value);
    if (replace) {
      writeMonitorPanels(remote);
      return;
    }
    const payload = (panels: MonitorPanel[]) => ({
      hosts: [],
      keys: [],
      snippets: [],
      customGroups: [],
      syncedAt: 0,
      monitorPanels: panels,
    });
    writeMonitorPanels(
      mergeSyncPayloads(
        payload(base),
        payload(readMonitorPanels()),
        payload(remote),
      ).payload.monitorPanels ?? [],
    );
  });
}
let cachedRaw: string | null | undefined;
let cached: MonitorPanel[] = [];
function getSnapshot() {
  const raw = localStorageAdapter.readString(STORAGE_KEY_MONITOR_PANELS);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = readMonitorPanels();
  }
  return cached;
}
function subscribe(listener: () => void) {
  const handler = (event: Event) => {
    const key =
      event instanceof StorageEvent
        ? event.key
        : (event as CustomEvent<{ key: string }>).detail?.key;
    if (!key || key === STORAGE_KEY_MONITOR_PANELS) listener();
  };
  window.addEventListener("storage", handler);
  window.addEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, handler);
  return () => {
    window.removeEventListener("storage", handler);
    window.removeEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, handler);
  };
}
export function useMonitorPanels(): MonitorPanel[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
