import { useCallback, useEffect, useState } from 'react';
import {
  type LocalVaultBackupPreview,
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
    void refreshBackups();
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
    refreshBackups,
    readBackup: readLocalVaultBackup,
    setMaxBackups: updateMaxBackups,
    openBackupDirectory,
  };
}

export default useLocalVaultBackups;
