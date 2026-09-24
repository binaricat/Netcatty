import { useCallback, useMemo, useRef } from "react";
import type { SftpFilenameEncoding } from "../../../domain/models/sftp";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { getParentPath } from "./utils";

type RememberedTarget = {
  targetPath: string;
  parentRealPath: string;
  parentIdentity: string | null;
};

const TARGET_LIMIT = 200;

const sourceKey = (
  endpointKey: string | null | undefined,
  sourcePath: string,
  encoding: SftpFilenameEncoding | undefined,
): string | null => endpointKey && sourcePath
  ? JSON.stringify([endpointKey, sourcePath, encoding ?? "auto"])
  : null;

const filesystemIdentity = (stat: SftpStatResult): string | null =>
  stat.dev !== undefined && stat.ino !== undefined ? `${stat.dev}:${stat.ino}` : null;

/** Each SFTP view remembers only targets that its user selected successfully. */
export function useSftpQuickDownloadTargets() {
  const targetsRef = useRef(new Map<string, RememberedTarget>());

  const remember = useCallback(async (
    endpointKey: string | null | undefined,
    sourcePath: string,
    encoding: SftpFilenameEncoding | undefined,
    targetPath: string,
  ): Promise<void> => {
    const key = sourceKey(endpointKey, sourcePath, encoding);
    const bridge = netcattyBridge.get();
    if (!key || !targetPath || !bridge?.statLocal || !bridge.lstatLocal || !bridge.realpathLocal) return;
    try {
      const parentPath = getParentPath(targetPath);
      const [parent, target, parentRealPath] = await Promise.all([
        bridge.statLocal(parentPath),
        bridge.lstatLocal(targetPath),
        bridge.realpathLocal(parentPath),
      ]);
      if (parent?.type !== "directory" || target?.type !== "file" || !parentRealPath) return;
      const targets = targetsRef.current;
      targets.delete(key);
      targets.set(key, { targetPath, parentRealPath, parentIdentity: filesystemIdentity(parent) });
      while (targets.size > TARGET_LIMIT) {
        const oldest = targets.keys().next().value;
        if (oldest === undefined) break;
        targets.delete(oldest);
      }
    } catch {
      // The next download uses Save As when a selected path cannot be verified.
    }
  }, []);

  const findValidTarget = useCallback(async (
    endpointKey: string | null | undefined,
    sourcePath: string,
    sftpId: string,
    encoding: SftpFilenameEncoding | undefined,
  ): Promise<string | null> => {
    const key = sourceKey(endpointKey, sourcePath, encoding);
    if (!key) return null;
    const targets = targetsRef.current;
    const remembered = targets.get(key);
    if (!remembered) return null;
    const bridge = netcattyBridge.get();
    if (!bridge?.statSftp || !bridge.statLocal || !bridge.lstatLocal || !bridge.realpathLocal) return null;
    try {
      const parentPath = getParentPath(remembered.targetPath);
      const [source, parent, target, parentRealPath] = await Promise.all([
        bridge.statSftp(sftpId, sourcePath, encoding),
        bridge.statLocal(parentPath),
        bridge.lstatLocal(remembered.targetPath),
        bridge.realpathLocal(parentPath),
      ]);
      if (
        source?.type !== "file"
        || parent?.type !== "directory"
        || target?.type !== "file"
        || parentRealPath !== remembered.parentRealPath
        || (remembered.parentIdentity !== null
          && filesystemIdentity(parent) !== remembered.parentIdentity)
      ) {
        targets.delete(key);
        return null;
      }
      targets.delete(key);
      targets.set(key, remembered);
      return remembered.targetPath;
    } catch {
      targets.delete(key);
      return null;
    }
  }, []);

  const forget = useCallback((
    endpointKey: string | null | undefined,
    sourcePath: string,
    encoding: SftpFilenameEncoding | undefined,
  ): void => {
    const key = sourceKey(endpointKey, sourcePath, encoding);
    if (key) targetsRef.current.delete(key);
  }, []);

  return useMemo(() => ({ remember, findValidTarget, forget }), [remember, findValidTarget, forget]);
}
