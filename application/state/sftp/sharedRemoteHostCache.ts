import type { SftpFileEntry, SftpFilenameEncoding } from "../../../domain/models";

interface SharedRemoteHostCacheEntry {
  path: string;
  homeDir: string;
  files: SftpFileEntry[];
  filenameEncoding: SftpFilenameEncoding;
  updatedAt: number;
}

const SHARED_REMOTE_HOST_CACHE_TTL_MS = 60_000;

const sharedRemoteHostCache = new Map<string, SharedRemoteHostCacheEntry>();

export const getSharedRemoteHostCache = (
  hostId: string,
): SharedRemoteHostCacheEntry | null => {
  const entry = sharedRemoteHostCache.get(hostId);
  if (!entry) return null;

  if (Date.now() - entry.updatedAt > SHARED_REMOTE_HOST_CACHE_TTL_MS) {
    sharedRemoteHostCache.delete(hostId);
    return null;
  }

  return entry;
};

export const setSharedRemoteHostCache = (
  hostId: string,
  entry: Omit<SharedRemoteHostCacheEntry, "updatedAt">,
): void => {
  sharedRemoteHostCache.set(hostId, {
    ...entry,
    updatedAt: Date.now(),
  });
};
