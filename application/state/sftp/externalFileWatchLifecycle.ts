import { useCallback, useEffect, useRef, type MutableRefObject } from "react";

export async function cleanupFailedExternalOpenTemp(
  bridge: Pick<NetcattyBridge, "unregisterTempFile" | "deleteTempFile">,
  sftpId: string,
  localPath: string,
): Promise<void> {
  if (!localPath) return;
  if (bridge.unregisterTempFile) {
    await bridge.unregisterTempFile(sftpId, localPath);
    return;
  }
  await bridge.deleteTempFile?.(localPath);
}

export type StopExternalFileWatch = (
  watchId: string,
  cleanupTempFile: boolean,
) => void | Promise<unknown>;

export type SubscribeExternalFileWatchStopped = (
  callback: (payload: {
    watchId: string;
    localPath?: string;
    remotePath?: string;
    sftpId?: string;
  }) => void,
) => (() => void) | void;

export interface ExternalFileWatchLifecycle {
  activeCountRef: MutableRefObject<number>;
  captureGeneration(): number;
  remember(watchId: string | undefined, generation?: number): void;
  releaseAll(cleanupTempFiles?: boolean): Promise<void>;
}

export function useExternalFileWatchLifecycle(
  stopWatch: StopExternalFileWatch,
  subscribeStopped?: SubscribeExternalFileWatchStopped,
  onStoppedLocalPath?: (localPath: string) => void,
): ExternalFileWatchLifecycle {
  const watchIdsRef = useRef<Set<string>>(new Set());
  const activeCountRef = useRef(0);
  const stopWatchRef = useRef(stopWatch);
  const subscribeStoppedRef = useRef(subscribeStopped);
  const onStoppedLocalPathRef = useRef(onStoppedLocalPath);
  const disposedRef = useRef(false);
  const generationRef = useRef(0);
  const invalidatedCleanupTempFilesRef = useRef(false);
  stopWatchRef.current = stopWatch;
  subscribeStoppedRef.current = subscribeStopped;
  onStoppedLocalPathRef.current = onStoppedLocalPath;

  const captureGeneration = useCallback(() => generationRef.current, []);

  const remember = useCallback((watchId: string | undefined, generation = generationRef.current) => {
    if (!watchId) return;
    if (disposedRef.current || generation !== generationRef.current) {
      // startFileWatch may resolve after the owning React tree unmounts. There
      // may also have been an explicit disconnect cleanup while IPC was pending.
      // There will be no later cleanup for the old generation, so release now.
      const cleanupTempFile = disposedRef.current
        ? false
        : invalidatedCleanupTempFilesRef.current;
      void Promise.resolve()
        .then(() => stopWatchRef.current(watchId, cleanupTempFile))
        .catch(() => {});
      return;
    }
    watchIdsRef.current.add(watchId);
    activeCountRef.current = watchIdsRef.current.size;
  }, []);

  const releaseAll = useCallback(async (cleanupTempFiles = false) => {
    invalidatedCleanupTempFilesRef.current = cleanupTempFiles;
    generationRef.current += 1;
    const watchIds = [...watchIdsRef.current];
    watchIdsRef.current.clear();
    activeCountRef.current = 0;
    await Promise.all(watchIds.map(async (watchId) => {
      try {
        await stopWatchRef.current(watchId, cleanupTempFiles);
      } catch {
        // The owning SFTP session or worker may already have released it.
      }
    }));
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      void releaseAll(false);
    };
  }, [releaseAll]);

  useEffect(() => subscribeStoppedRef.current?.(({ watchId, localPath }) => {
    if (!watchId || !watchIdsRef.current.delete(watchId)) return;
    activeCountRef.current = watchIdsRef.current.size;
    if (localPath) onStoppedLocalPathRef.current?.(localPath);
  }), []);

  return { activeCountRef, captureGeneration, remember, releaseAll };
}
