/**
 * useSftpFileAssociations - Hook for managing SFTP file opener associations
 * Uses a shared state pattern to sync across components
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { STORAGE_KEY_SFTP_FILE_ASSOCIATIONS, STORAGE_KEY_SFTP_DEFAULT_OPENER } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import type { FileAssociation, FileOpenerType, SystemAppInfo } from '../../lib/sftpFileUtils';
import { getFileExtension, isKnownBinaryFile } from '../../lib/sftpFileUtils';

export interface FileAssociationEntry {
  openerType: FileOpenerType;
  systemApp?: SystemAppInfo;
}

export interface FileAssociationsMap {
  [extension: string]: FileAssociationEntry;
}

// ---------------------------------------------------------------------------
// Per-extension associations store
// ---------------------------------------------------------------------------

const subscribers = new Set<() => void>();

let snapshotRef: { associations: FileAssociationsMap } = { associations: {} };

function loadFromStorage(): FileAssociationsMap {
  const stored = localStorageAdapter.read<FileAssociationsMap>(STORAGE_KEY_SFTP_FILE_ASSOCIATIONS);
  if (stored) {
    const migrated: FileAssociationsMap = {};
    for (const [ext, value] of Object.entries(stored)) {
      if (typeof value === 'string') {
        migrated[ext] = { openerType: value as FileOpenerType };
      } else {
        migrated[ext] = value as FileAssociationEntry;
      }
    }
    return migrated;
  }
  return {};
}

snapshotRef = { associations: loadFromStorage() };

function saveToStorage(associations: FileAssociationsMap) {
  localStorageAdapter.write(STORAGE_KEY_SFTP_FILE_ASSOCIATIONS, associations);
}

function updateAssociations(newAssociations: FileAssociationsMap) {
  snapshotRef = { associations: newAssociations };
  saveToStorage(newAssociations);
  subscribers.forEach(callback => callback());
}

function subscribe(callback: () => void) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

function getSnapshot() {
  return snapshotRef;
}

// ---------------------------------------------------------------------------
// Default opener store (separate from per-extension associations)
// ---------------------------------------------------------------------------

const defaultOpenerSubscribers = new Set<() => void>();

let defaultOpenerSnapshot: { entry: FileAssociationEntry | null } = {
  entry: localStorageAdapter.read<FileAssociationEntry>(STORAGE_KEY_SFTP_DEFAULT_OPENER) ?? null,
};

function subscribeDefaultOpener(callback: () => void) {
  defaultOpenerSubscribers.add(callback);
  return () => defaultOpenerSubscribers.delete(callback);
}

function getDefaultOpenerSnapshot() {
  return defaultOpenerSnapshot;
}

function updateDefaultOpener(entry: FileAssociationEntry | null) {
  defaultOpenerSnapshot = { entry };
  if (entry) {
    localStorageAdapter.write(STORAGE_KEY_SFTP_DEFAULT_OPENER, entry);
  } else {
    localStorage.removeItem(STORAGE_KEY_SFTP_DEFAULT_OPENER);
  }
  defaultOpenerSubscribers.forEach(callback => callback());
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSftpFileAssociations() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const associations = snapshot.associations;

  const defaultOpenerState = useSyncExternalStore(subscribeDefaultOpener, getDefaultOpenerSnapshot, getDefaultOpenerSnapshot);

  // Listen for storage events from other tabs/windows
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY_SFTP_FILE_ASSOCIATIONS) {
        updateAssociations(loadFromStorage());
      } else if (e.key === STORAGE_KEY_SFTP_DEFAULT_OPENER) {
        updateDefaultOpener(
          localStorageAdapter.read<FileAssociationEntry>(STORAGE_KEY_SFTP_DEFAULT_OPENER) ?? null,
        );
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  /**
   * Get the opener entry for a file based on its extension.
   * Falls back to the default opener when no per-extension association exists.
   */
  const getOpenerForFile = useCallback((fileName: string): FileAssociationEntry | null => {
    const ext = getFileExtension(fileName);
    if (associations[ext]) return associations[ext];
    // Fall back to default opener, but skip built-in editor for binary files
    const fallback = defaultOpenerState.entry;
    if (fallback && fallback.openerType === 'builtin-editor' && isKnownBinaryFile(fileName)) {
      return null;
    }
    return fallback;
  }, [associations, defaultOpenerState]);

  /**
   * Get the default (fallback) opener, if set.
   */
  const getDefaultOpener = useCallback((): FileAssociationEntry | null => {
    return defaultOpenerState.entry;
  }, [defaultOpenerState]);

  /**
   * Set the default opener used when no per-extension association exists.
   */
  const setDefaultOpener = useCallback((openerType: FileOpenerType, systemApp?: SystemAppInfo) => {
    updateDefaultOpener({ openerType, systemApp });
  }, []);

  /**
   * Remove the default opener.
   */
  const removeDefaultOpener = useCallback(() => {
    updateDefaultOpener(null);
  }, []);

  /**
   * Set the opener type for a specific extension
   */
  const setOpenerForExtension = useCallback((
    extension: string,
    openerType: FileOpenerType,
    systemApp?: SystemAppInfo
  ) => {
    updateAssociations({
      ...snapshotRef.associations,
      [extension.toLowerCase()]: { openerType, systemApp },
    });
  }, []);

  /**
   * Remove the association for a specific extension
   */
  const removeAssociation = useCallback((extension: string) => {
    const next = { ...snapshotRef.associations };
    delete next[extension.toLowerCase()];
    updateAssociations(next);
  }, []);

  /**
   * Get all per-extension associations as an array.
   */
  const getAllAssociations = useCallback((): FileAssociation[] => {
    return Object.entries(associations).map(([extension, entry]: [string, FileAssociationEntry]) => ({
      extension,
      openerType: entry.openerType,
      systemApp: entry.systemApp,
    }));
  }, [associations]);

  /**
   * Clear all associations
   */
  const clearAllAssociations = useCallback(() => {
    updateAssociations({});
  }, []);

  return {
    associations,
    getOpenerForFile,
    getDefaultOpener,
    setDefaultOpener,
    removeDefaultOpener,
    setOpenerForExtension,
    removeAssociation,
    getAllAssociations,
    clearAllAssociations,
  };
}
