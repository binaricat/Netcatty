import { useMemo } from "react";
import type { SftpFileEntry } from "../../../types";
import type { SftpPane } from "../../../application/state/sftp/types";
import type { SortField, SortOrder } from "../utils";
import { filterHiddenFiles, sortSftpEntries } from "../index";

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
    let nextFiles = filterHiddenFiles(files, showHiddenFiles);
    if (!term) return nextFiles;
    return nextFiles.filter(
      (f) => f.name === ".." || f.name.toLowerCase().includes(term),
    );
  }, [files, filter, showHiddenFiles]);

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
    const sorted = sortSftpEntries(otherFiles, sortField, sortOrder);

    return parentEntry ? [parentEntry, ...sorted] : sorted;
  }, [displayFiles, sortField, sortOrder]);

  return { filteredFiles, displayFiles, sortedDisplayFiles };
};
