import { useMemo } from "react";
import type { SftpFileEntry } from "../../../types";
import type { SftpPane } from "../../../application/state/sftp/types";
import type { SortField, SortOrder } from "../utils";
import { filterHiddenFiles } from "../index";

interface UseSftpPaneFilesParams {
  files: SftpFileEntry[];
  filter: string;
  connection: SftpPane["connection"] | null;
  showHiddenFiles: boolean;
  sortField: SortField;
  sortOrder: SortOrder;
}

interface UseSftpPaneFilesResult {
  filteredFiles: SftpFileEntry[];
  displayFiles: SftpFileEntry[];
  sortedDisplayFiles: SftpFileEntry[];
}

export const useSftpPaneFiles = ({
  files,
  filter,
  connection,
  showHiddenFiles,
  sortField,
  sortOrder,
}: UseSftpPaneFilesParams): UseSftpPaneFilesResult => {
  const filteredFiles = useMemo(() => {
    const term = filter.trim().toLowerCase();
    let nextFiles = filterHiddenFiles(files, showHiddenFiles, connection?.isLocal);
    if (!term) return nextFiles;
    return nextFiles.filter(
      (f) => f.name === ".." || f.name.toLowerCase().includes(term),
    );
  }, [files, filter, showHiddenFiles, connection?.isLocal]);

  const displayFiles = useMemo(() => {
    if (!connection) return [];
    const isRootPath =
      connection.currentPath === "/" ||
      /^[A-Za-z]:[\\/]?$/.test(connection.currentPath);
    if (isRootPath) return filteredFiles;
    const parentEntry: SftpFileEntry = {
      name: "..",
      type: "directory",
      size: 0,
      sizeFormatted: "--",
      lastModified: 0,
      lastModifiedFormatted: "--",
    };
    return [parentEntry, ...filteredFiles.filter((f) => f.name !== "..")];
  }, [connection, filteredFiles]);

  const sortedDisplayFiles = useMemo(() => {
    if (!displayFiles.length) return displayFiles;

    const parentEntry = displayFiles.find((f) => f.name === "..");
    const otherFiles = displayFiles.filter((f) => f.name !== "..");

    const sorted = [...otherFiles].sort((a, b) => {
      if (sortField !== "type") {
        if (a.type === "directory" && b.type !== "directory") return -1;
        if (a.type !== "directory" && b.type === "directory") return 1;
      }

      let cmp = 0;
      switch (sortField) {
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "size":
          cmp = (a.size || 0) - (b.size || 0);
          break;
        case "modified":
          cmp = (a.lastModified || 0) - (b.lastModified || 0);
          break;
        case "type": {
          const extA =
            a.type === "directory"
              ? "folder"
              : a.name.split(".").pop()?.toLowerCase() || "";
          const extB =
            b.type === "directory"
              ? "folder"
              : b.name.split(".").pop()?.toLowerCase() || "";
          cmp = extA.localeCompare(extB);
          break;
        }
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });

    return parentEntry ? [parentEntry, ...sorted] : sorted;
  }, [displayFiles, sortField, sortOrder]);

  return { filteredFiles, displayFiles, sortedDisplayFiles };
};
