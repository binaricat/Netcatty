import { useCallback } from "react";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import type { SftpFileEntry, SftpFilenameEncoding } from "../../../domain/models";
import { formatFileSize, formatDate } from "./utils";

export const useSftpDirectoryListing = () => {
  const listLocalFiles = useCallback(
    async (path: string): Promise<SftpFileEntry[]> => {
      const rawFiles = await netcattyBridge.get()?.listLocalDir?.(path);
      if (!rawFiles) {
        const { buildMockLocalFiles } = await import("./mockLocalFiles");
        return buildMockLocalFiles(path);
      }

      return rawFiles.map((f) => {
        const size = parseInt(f.size) || 0;
        const lastModified = new Date(f.lastModified).getTime();
        return {
          name: f.name,
          type: f.type as "file" | "directory" | "symlink",
          size,
          sizeFormatted: formatFileSize(size),
          lastModified,
          lastModifiedFormatted: formatDate(lastModified),
          linkTarget: f.linkTarget as "file" | "directory" | null | undefined,
          hidden: f.hidden,
          owner: f.owner,
        };
      });
    },
    [],
  );

  const listRemoteFiles = useCallback(
    async (sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<SftpFileEntry[]> => {
      const rawFiles = await netcattyBridge.get()?.listSftp(sftpId, path, encoding);
      if (!rawFiles) return [];

      return rawFiles.map((f) => {
        const size = parseInt(f.size) || 0;
        const lastModified = new Date(f.lastModified).getTime();
        return {
          name: f.name,
          type: f.type as "file" | "directory" | "symlink",
          size,
          sizeFormatted: formatFileSize(size),
          lastModified,
          lastModifiedFormatted: formatDate(lastModified),
          permissions: f.permissions,
          owner: f.owner,
          linkTarget: f.linkTarget as "file" | "directory" | null | undefined,
        };
      });
    },
    [],
  );

  return {
    listLocalFiles,
    listRemoteFiles,
  };
};
