import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_SFTP_LIST_DENSITY,
  getNextSftpListDensity,
  parseSftpListDensity,
  type SftpListDensity,
} from "../../../domain/sftpListDensity";
import { STORAGE_KEY_SFTP_LIST_DENSITY } from "../../../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";

type Listener = () => void;

const listeners = new Set<Listener>();

let snapshot: SftpListDensity = parseSftpListDensity(
  localStorageAdapter.readString(STORAGE_KEY_SFTP_LIST_DENSITY),
);

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeSftpListDensity(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSftpListDensitySnapshot(): SftpListDensity {
  return snapshot;
}

export function setSftpListDensity(next: SftpListDensity) {
  const density = parseSftpListDensity(next);
  if (density === snapshot) return;
  snapshot = density;
  localStorageAdapter.writeString(STORAGE_KEY_SFTP_LIST_DENSITY, density);
  emit();
}

export function toggleSftpListDensity() {
  setSftpListDensity(getNextSftpListDensity(snapshot));
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY_SFTP_LIST_DENSITY) return;
    snapshot = parseSftpListDensity(event.newValue);
    emit();
  });
}

export function useSftpListDensity() {
  const density = useSyncExternalStore(
    subscribeSftpListDensity,
    getSftpListDensitySnapshot,
    () => DEFAULT_SFTP_LIST_DENSITY,
  );
  const setDensity = useCallback((next: SftpListDensity) => {
    setSftpListDensity(next);
  }, []);
  const toggleDensity = useCallback(() => {
    toggleSftpListDensity();
  }, []);
  return { density, setDensity, toggleDensity };
}
