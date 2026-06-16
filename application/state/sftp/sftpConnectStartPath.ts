import type { SftpFileEntry, SftpFilenameEncoding } from "../../../domain/models";

export interface RemoteSftpStartCache {
  path: string;
  homeDir: string;
  files: SftpFileEntry[];
  filenameEncoding: SftpFilenameEncoding;
}

interface ResolveRemoteSftpStartStateParams {
  filenameEncoding: SftpFilenameEncoding;
  ignoreSharedCache?: boolean;
  initialPath?: string;
  sharedHostCacheCandidate: RemoteSftpStartCache | null;
}

export function normalizeSftpInitialPath(initialPath?: string): string | undefined {
  return initialPath === undefined || initialPath.length === 0 ? undefined : initialPath;
}

export function resolveRemoteSftpStartState({
  filenameEncoding,
  ignoreSharedCache,
  initialPath,
  sharedHostCacheCandidate,
}: ResolveRemoteSftpStartStateParams): {
  initialPath: string | undefined;
  sharedHostCache: RemoteSftpStartCache | null;
  cachedStartPath: string;
} {
  const requestedInitialPath = normalizeSftpInitialPath(initialPath);
  const sharedHostCache =
    !ignoreSharedCache
      && sharedHostCacheCandidate?.filenameEncoding === filenameEncoding
      && (!requestedInitialPath || sharedHostCacheCandidate.path === requestedInitialPath)
      ? sharedHostCacheCandidate
      : null;

  return {
    initialPath: requestedInitialPath,
    sharedHostCache,
    cachedStartPath: requestedInitialPath ?? sharedHostCache?.path ?? "/",
  };
}
