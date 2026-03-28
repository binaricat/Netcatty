/**
 * useSftpFileAssociations - Hook for managing SFTP file opener associations
 * Uses a shared state pattern to sync across components
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { STORAGE_KEY_SFTP_FILE_ASSOCIATIONS } from '../../infrastructure/config/storageKeys';
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

// Shared state and subscribers for cross-component synchronization
const subscribers = new Set<() => void>();

// Use a wrapper object so we can update the reference for useSyncExternalStore
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

// Initialize from storage
snapshotRef = { associations: loadFromStorage() };

function saveToStorage(associations: FileAssociationsMap) {
  localStorageAdapter.write(STORAGE_KEY_SFTP_FILE_ASSOCIATIONS, associations);
}

function updateAssociations(newAssociations: FileAssociationsMap) {
  // Create new reference so useSyncExternalStore detects change
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

/** Key used to store the global default opener — uses a reserved prefix to avoid
 *  collisions with real file extensions (e.g. a file named "foo.*"). */
const DEFAULT_OPENER_KEY = '__default__';

export function useSftpFileAssociations() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const associations = snapshot.associations;

  // Listen for storage events from other tabs/windows
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY_SFTP_FILE_ASSOCIATIONS) {
        updateAssociations(loadFromStorage());
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  /**
   * Get the opener entry for a file based on its extension.
   * Falls back to the default opener ("*") when no per-extension association exists.
   */
  const getOpenerForFile = useCallback((fileName: string): FileAssociationEntry | null => {
    const ext = getFileExtension(fileName);
    if (associations[ext]) return associations[ext];
    // Fall back to default opener, but skip built-in editor for binary files
    const fallback = associations[DEFAULT_OPENER_KEY];
    if (fallback && fallback.openerType === 'builtin-editor' && isKnownBinaryFile(fileName)) {
      return null;
    }
    return fallback || null;
  }, [associations]);

  /**
   * Get the default (fallback) opener, if set.
   */
  const getDefaultOpener = useCallback((): FileAssociationEntry | null => {
    return associations[DEFAULT_OPENER_KEY] || null;
  }, [associations]);

  /**
   * Set the default opener used when no per-extension association exists.
   */
  const setDefaultOpener = useCallback((openerType: FileOpenerType, systemApp?: SystemAppInfo) => {
    updateAssociations({
      ...snapshotRef.associations,
      [DEFAULT_OPENER_KEY]: { openerType, systemApp },
    });
  }, []);

  /**
   * Remove the default opener.
   */
  const removeDefaultOpener = useCallback(() => {
    const next = { ...snapshotRef.associations };
    delete next[DEFAULT_OPENER_KEY];
    updateAssociations(next);
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
   * Get all per-extension associations as an array (excludes the default opener).
   */
  const getAllAssociations = useCallback((): FileAssociation[] => {
    return Object.entries(associations)
      .filter(([ext]) => ext !== DEFAULT_OPENER_KEY)
      .map(([extension, entry]: [string, FileAssociationEntry]) => ({
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
