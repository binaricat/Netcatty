import { useCallback } from "react";
import type { SftpFilenameEncoding, TransferTask } from "../../../domain/models";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { isMissingStatError } from "./errors";
import type { SftpPane } from "./types";
import { getFileName, getParentPath, isSameSftpPath, joinPath } from "./utils";

export function useSftpTransferConflictOps() {
  const splitNameForDuplicate = useCallback((fileName: string, isDirectory: boolean) => {
    if (isDirectory) return { baseName: fileName, ext: "" };
    const lastDot = fileName.lastIndexOf(".");
    if (lastDot <= 0) return { baseName: fileName, ext: "" };
    return {
      baseName: fileName.slice(0, lastDot),
      ext: fileName.slice(lastDot),
    };
  }, []);

  const statTargetPath = useCallback(
    async (
      targetPane: SftpPane,
      targetSftpId: string | null,
      targetPath: string,
      targetEncoding: SftpFilenameEncoding,
    ): Promise<{ type?: "file" | "directory" | "symlink"; size: number; mtime: number } | null> => {
      if (!targetPane.connection) return null;

      try {
        if (targetPane.connection.isLocal) {
          const bridge = netcattyBridge.get();
          const stat = await (bridge?.lstatLocal ?? bridge?.statLocal)?.(targetPath);
          if (!stat) return null;
          return {
            type: stat.type as "file" | "directory" | "symlink" | undefined,
            size: stat.size,
            mtime: stat.lastModified || Date.now(),
          };
        }

        if (!targetSftpId) return null;
        const bridge = netcattyBridge.get();
        const stat = await (bridge?.lstatSftp ?? bridge?.statSftp)?.(
          targetSftpId,
          targetPath,
          targetEncoding,
        );
        if (!stat) return null;
        return {
          type: stat.type as "file" | "directory" | "symlink" | undefined,
          size: stat.size,
          mtime: stat.lastModified || Date.now(),
        };
      } catch (error) {
        // Missing path = no conflict. ENOTSUP / unknown type must fail closed.
        if (isMissingStatError(error)) return null;
        throw error;
      }
    },
    [],
  );

  const getDuplicateTarget = useCallback(
    async (
      task: TransferTask,
      targetPane: SftpPane,
      targetSftpId: string | null,
      targetEncoding: SftpFilenameEncoding,
    ) => {
      const parentPath = getParentPath(task.targetPath);
      const { baseName, ext } = splitNameForDuplicate(task.fileName, task.isDirectory);

      for (let index = 1; index < 1000; index++) {
        const suffix = index === 1 ? " (copy)" : ` (copy ${index})`;
        const fileName = `${baseName}${suffix}${ext}`;
        const targetPath = joinPath(parentPath, fileName);
        // Unsupported LSTAT must propagate — do not treat as a free name.
        const existing = await statTargetPath(targetPane, targetSftpId, targetPath, targetEncoding);
        if (!existing) return { fileName, targetPath };
      }

      const fallbackName = `${baseName} (copy ${Date.now()})${ext}`;
      return { fileName: fallbackName, targetPath: joinPath(parentPath, fallbackName) };
    },
    [splitNameForDuplicate, statTargetPath],
  );

  const isSameSourceEntry = useCallback(async (
    task: TransferTask,
    targetPane: SftpPane,
    targetSftpId: string | null,
    targetEncoding: SftpFilenameEncoding,
  ): Promise<boolean> => {
    if (!targetPane.connection || task.sourceConnectionId !== task.targetConnectionId) return false;
    if (isSameSftpPath(task.sourcePath, task.targetPath)) return true;
    const bridge = netcattyBridge.get();
    const resolve = targetPane.connection.isLocal
      ? bridge?.realpathLocal
      : targetSftpId && bridge?.realpathSftp
        ? (value: string) => bridge.realpathSftp!(targetSftpId, value, targetEncoding)
        : undefined;
    const [sourceParent, targetParent] = await Promise.all(
      [getParentPath(task.sourcePath), getParentPath(task.targetPath)].map(
        (value) => resolve ? resolve(value) : Promise.resolve(value),
      ),
    );
    return isSameSftpPath(
      joinPath(sourceParent, getFileName(task.sourcePath)),
      joinPath(targetParent, getFileName(task.targetPath)),
    );
  }, []);

  const deleteTargetPath = useCallback(
    async (
      task: TransferTask,
      targetPane: SftpPane,
      targetSftpId: string | null,
      targetEncoding: SftpFilenameEncoding,
      expectedType?: "file" | "directory" | "symlink",
    ) => {
      if (!targetPane.connection) return;
      // Replace unlinks symlinks before copying. Never unlink the source entry
      // when a clipboard copy is pasted back into its own directory.
      if (expectedType === "symlink" && await isSameSourceEntry(task, targetPane, targetSftpId, targetEncoding)) {
        throw new Error("Cannot replace the source link with itself. Choose Duplicate or Skip.");
      }
      if (targetPane.connection.isLocal) {
        const deleteLocalFile = netcattyBridge.get()?.deleteLocalFile;
        if (!deleteLocalFile) throw new Error("Local delete unavailable");
        await deleteLocalFile(task.targetPath, expectedType);
        return;
      }
      if (!targetSftpId) throw new Error("Target SFTP session not found");
      const deleteSftp = netcattyBridge.get()?.deleteSftp;
      if (!deleteSftp) throw new Error("SFTP delete unavailable");
      await deleteSftp(targetSftpId, task.targetPath, targetEncoding, expectedType);
    },
    [isSameSourceEntry],
  );


  return { statTargetPath, getDuplicateTarget, deleteTargetPath, isSameSourceEntry };
}
