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
  // Extract ".." once and process the remaining files through filter -> sort
  // in fewer passes, instead of repeatedly filtering/finding ".." entries.
  const filteredFiles = useMemo(() => {
    const term = filter.trim().toLowerCase();
    let nextFiles = filterHiddenFiles(files, showHiddenFiles);
    if (!term) return nextFiles;
    return nextFiles.filter(
      (f) => f.name === ".." || f.name.toLowerCase().includes(term),
    );
  }, [files, filter, showHiddenFiles]);

  const { displayFiles, sortedDisplayFiles } = useMemo(() => {
    if (!connection) return { displayFiles: [] as SftpFileEntry[], sortedDisplayFiles: [] as SftpFileEntry[] };

    const isRootPath =
      connection.currentPath === "/" ||
      /^[A-Za-z]:[\\/]?$/.test(connection.currentPath);

    // Split ".." from other files in a single pass
    let parentEntry: SftpFileEntry | undefined;
    const otherFiles: SftpFileEntry[] = [];
    for (const f of filteredFiles) {
      if (f.name === "..") {
        parentEntry = f;
      } else {
        otherFiles.push(f);
      }
    }

    // For non-root paths, always ensure a ".." entry exists
    if (!isRootPath && !parentEntry) {
      parentEntry = {
        name: "..",
        type: "directory",
        size: 0,
        sizeFormatted: "--",
        lastModified: 0,
        lastModifiedFormatted: "--",
      };
    }

    const display = parentEntry ? [parentEntry, ...otherFiles] : otherFiles;
    const sorted = otherFiles.length
      ? sortSftpEntries(otherFiles, sortField, sortOrder)
      : otherFiles;
    const sortedDisplay = parentEntry ? [parentEntry, ...sorted] : sorted;

    return { displayFiles: display, sortedDisplayFiles: sortedDisplay };
  }, [connection, filteredFiles, sortField, sortOrder]);

  return { filteredFiles, displayFiles, sortedDisplayFiles };
};
