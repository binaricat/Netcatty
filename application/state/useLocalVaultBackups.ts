import { useCallback, useEffect, useState } from 'react';
import {
  type LocalVaultBackupPreview,
  getLocalVaultBackupCapabilities,
  getLocalVaultBackupMaxCount,
  listLocalVaultBackups,
  openLocalVaultBackupDir,
  readLocalVaultBackup,
  setLocalVaultBackupMaxCount,
  trimLocalVaultBackups,
} from '../localVaultBackups';

export function useLocalVaultBackups() {
  const [backups, setBackups] = useState<LocalVaultBackupPreview[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [maxBackups, setMaxBackupsState] = useState(() => getLocalVaultBackupMaxCount());
  // `null` while we're still asking the main process. The UI should treat
  // `null` as "unknown, don't render restore controls yet" so we never expose
  // a destructive action that might later be disabled.
  const [encryptionAvailable, setEncryptionAvailable] = useState<boolean | null>(null);

  const refreshBackups = useCallback(async () => {
    setIsLoading(true);
    try {
      const next = await listLocalVaultBackups();
      setBackups(next);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const caps = await getLocalVaultBackupCapabilities();
        if (!cancelled) {
          setEncryptionAvailable(caps.encryptionAvailable);
        }
      } catch {
        if (!cancelled) {
          setEncryptionAvailable(false);
        }
      }
    })();
    void refreshBackups();
    return () => {
      cancelled = true;
    };
  }, [refreshBackups]);

  const updateMaxBackups = useCallback(async (value: number) => {
    const sanitized = setLocalVaultBackupMaxCount(value);
    setMaxBackupsState(sanitized);
    await trimLocalVaultBackups(sanitized);
    await refreshBackups();
    return sanitized;
  }, [refreshBackups]);

  const openBackupDirectory = useCallback(async () => {
    await openLocalVaultBackupDir();
  }, []);

  return {
    backups,
    isLoading,
    maxBackups,
    encryptionAvailable,
    refreshBackups,
    readBackup: readLocalVaultBackup,
    setMaxBackups: updateMaxBackups,
    openBackupDirectory,
  };
}

export default useLocalVaultBackups;
