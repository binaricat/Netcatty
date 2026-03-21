/**
 * useSftpFileAssociations - Hook for managing SFTP file opener associations
 * Uses a shared state pattern to sync across components
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { STORAGE_KEY_SFTP_FILE_ASSOCIATIONS } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import type { FileAssociation, FileOpenerType, SystemAppInfo } from '../../lib/sftpFileUtils';
import { getFileExtension } from '../../lib/sftpFileUtils';

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
   * Get the opener entry for a file based on its extension
   */
  const getOpenerForFile = useCallback((fileName: string): FileAssociationEntry | null => {
    const ext = getFileExtension(fileName);
    return associations[ext] || null;
  }, [associations]);

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
   * Get all associations as an array
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
    setOpenerForExtension,
    removeAssociation,
    getAllAssociations,
    clearAllAssociations,
  };
}
