import { useCallback, useMemo, useRef } from "react";
import type { LocalDownloadTargetExpectation, LocalPublishedFileIdentity, SftpFilenameEncoding } from "../../../domain/models/sftp";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { getParentPath } from "./utils";

type RememberedTarget = LocalDownloadTargetExpectation & {
  targetPath: string;
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

const validTimestamp = (value: string | undefined): value is string =>
  typeof value === "string" && /^[1-9]\d*$/.test(value);

/** Each SFTP view remembers only targets that its user selected successfully. */
export function useSftpQuickDownloadTargets() {
  const targetsRef = useRef(new Map<string, RememberedTarget>());

  const remember = useCallback(async (
    endpointKey: string | null | undefined,
    sourcePath: string,
    encoding: SftpFilenameEncoding | undefined,
    targetPath: string,
    published: LocalPublishedFileIdentity,
  ): Promise<void> => {
    const key = sourceKey(endpointKey, sourcePath, encoding);
    if (!key) return;
    targetsRef.current.delete(key);
    const bridge = netcattyBridge.get();
    if (!targetPath || !/^[a-f0-9]{64}$/.test(published.sha256)
      || !bridge?.statLocal || !bridge.lstatLocal || !bridge.realpathLocal) return;
    try {
      const parentPath = getParentPath(targetPath);
      const [parent, target, parentRealPath] = await Promise.all([
        bridge.statLocal(parentPath),
        bridge.lstatLocal(targetPath),
        bridge.realpathLocal(parentPath),
      ]);
      if (parent?.type !== "directory" || target?.type !== "file" || !parentRealPath) return;
      const parentIdentity = filesystemIdentity(parent);
      const targetIdentity = filesystemIdentity(target);
      if (!parentIdentity || !targetIdentity
        || target.dev !== published.dev || target.ino !== published.ino
        || target.birthtimeNs !== published.birthtimeNs
        || target.ctimeNs !== published.ctimeNs
        || target.mtimeNs !== published.mtimeNs
        || !validTimestamp(parent.birthtimeNs)
        || !validTimestamp(target.birthtimeNs)
        || !validTimestamp(target.ctimeNs)
        || !validTimestamp(target.mtimeNs)) return;
      const targets = targetsRef.current;
      targets.set(key, {
        targetPath, parentRealPath,
        parentIdentity, parentBirthtimeNs: parent.birthtimeNs,
        targetIdentity, targetBirthtimeNs: target.birthtimeNs,
        targetCtimeNs: target.ctimeNs,
        targetMtimeNs: target.mtimeNs,
      });
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
  ): Promise<RememberedTarget | null> => {
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
        || filesystemIdentity(target) !== remembered.targetIdentity
        || target.birthtimeNs !== remembered.targetBirthtimeNs
        || target.ctimeNs !== remembered.targetCtimeNs
        || target.mtimeNs !== remembered.targetMtimeNs
        || parentRealPath !== remembered.parentRealPath
        || filesystemIdentity(parent) !== remembered.parentIdentity
        || parent.birthtimeNs !== remembered.parentBirthtimeNs
      ) {
        targets.delete(key);
        return null;
      }
      targets.delete(key);
      targets.set(key, remembered);
      return remembered;
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
