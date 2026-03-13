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

/**
 * Build a cache key that includes connection details so that the same host ID
 * with different session-time overrides (port, protocol) uses separate entries.
 */
export const buildCacheKey = (
  hostId: string,
  hostname?: string,
  port?: number,
  protocol?: string,
  sftpSudo?: boolean,
  username?: string,
): string => {
  return `${hostId}:${hostname ?? ''}:${port ?? ''}:${protocol ?? ''}:${sftpSudo ? 'sudo' : ''}:${username ?? ''}`;
};

export const getSharedRemoteHostCache = (
  cacheKey: string,
): SharedRemoteHostCacheEntry | null => {
  const entry = sharedRemoteHostCache.get(cacheKey);
  if (!entry) return null;

  if (Date.now() - entry.updatedAt > SHARED_REMOTE_HOST_CACHE_TTL_MS) {
    sharedRemoteHostCache.delete(cacheKey);
    return null;
  }

  return entry;
};

export const setSharedRemoteHostCache = (
  cacheKey: string,
  entry: Omit<SharedRemoteHostCacheEntry, "updatedAt">,
): void => {
  sharedRemoteHostCache.set(cacheKey, {
    ...entry,
    updatedAt: Date.now(),
  });
};
