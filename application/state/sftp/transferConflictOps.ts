import { useCallback } from "react";
import type { SftpFilenameEncoding, TransferTask } from "../../../domain/models";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import type { SftpPane } from "./types";
import { getParentPath, joinPath } from "./utils";

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

      if (targetPane.connection.isLocal) {
        const stat = await netcattyBridge.get()?.statLocal?.(targetPath);
        if (!stat) return null;
        return {
          type: stat.type as "file" | "directory" | "symlink" | undefined,
          size: stat.size,
          mtime: stat.lastModified || Date.now(),
        };
      }

      if (!targetSftpId) return null;
      const stat = await netcattyBridge.get()?.statSftp?.(
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
        try {
          const existing = await statTargetPath(targetPane, targetSftpId, targetPath, targetEncoding);
          if (!existing) return { fileName, targetPath };
        } catch {
          return { fileName, targetPath };
        }
      }

      const fallbackName = `${baseName} (copy ${Date.now()})${ext}`;
      return { fileName: fallbackName, targetPath: joinPath(parentPath, fallbackName) };
    },
    [splitNameForDuplicate, statTargetPath],
  );

  const deleteTargetPath = useCallback(
    async (
      task: TransferTask,
      targetPane: SftpPane,
      targetSftpId: string | null,
      targetEncoding: SftpFilenameEncoding,
    ) => {
      if (!targetPane.connection) return;
      if (targetPane.connection.isLocal) {
        const deleteLocalFile = netcattyBridge.get()?.deleteLocalFile;
        if (!deleteLocalFile) throw new Error("Local delete unavailable");
        await deleteLocalFile(task.targetPath);
        return;
      }
      if (!targetSftpId) throw new Error("Target SFTP session not found");
      const deleteSftp = netcattyBridge.get()?.deleteSftp;
      if (!deleteSftp) throw new Error("SFTP delete unavailable");
      await deleteSftp(targetSftpId, task.targetPath, targetEncoding);
    },
    [],
  );


  return { statTargetPath, getDuplicateTarget, deleteTargetPath };
}
