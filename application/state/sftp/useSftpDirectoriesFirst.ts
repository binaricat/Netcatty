import { useCallback, useEffect, useState } from "react";
import { STORAGE_KEY_SFTP_DIRECTORIES_FIRST } from "../../../infrastructure/config/storageKeys";
import {
  LOCAL_STORAGE_ADAPTER_CHANGED_EVENT,
  localStorageAdapter,
} from "../../../infrastructure/persistence/localStorageAdapter";

export const useSftpDirectoriesFirst = () => {
  const [directoriesFirst, setDirectoriesFirst] = useState(
    () => localStorageAdapter.readBoolean(STORAGE_KEY_SFTP_DIRECTORIES_FIRST) ?? true,
  );

  useEffect(() => {
    const syncDirectoriesFirst = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== STORAGE_KEY_SFTP_DIRECTORIES_FIRST) return;
      if (event instanceof CustomEvent && event.detail?.key !== STORAGE_KEY_SFTP_DIRECTORIES_FIRST) return;
      setDirectoriesFirst(
        localStorageAdapter.readBoolean(STORAGE_KEY_SFTP_DIRECTORIES_FIRST) ?? true,
      );
    };

    window.addEventListener("storage", syncDirectoriesFirst);
    window.addEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, syncDirectoriesFirst);
    return () => {
      window.removeEventListener("storage", syncDirectoriesFirst);
      window.removeEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, syncDirectoriesFirst);
    };
  }, []);

  const toggleDirectoriesFirst = useCallback(() => {
    setDirectoriesFirst((current) => {
      const next = !current;
      localStorageAdapter.writeBoolean(STORAGE_KEY_SFTP_DIRECTORIES_FIRST, next);
      return next;
    });
  }, []);

  return { directoriesFirst, toggleDirectoriesFirst };
};
