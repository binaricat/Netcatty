import React, { useCallback, useMemo, useRef, useState } from "react";
import type { SftpFileEntry } from "../../../types";
import type { SftpPane } from "../../../application/state/sftp/types";
import { filterHiddenFiles, isNavigableDirectory } from "../index";

interface UseSftpPanePathParams {
  connection: SftpPane["connection"] | null;
  files: SftpFileEntry[];
  showHiddenFiles: boolean;
  onNavigateTo: (path: string) => void;
}

interface UseSftpPanePathResult {
  isEditingPath: boolean;
  editingPathValue: string;
  showPathSuggestions: boolean;
  pathSuggestionIndex: number;
  pathInputRef: React.RefObject<HTMLInputElement>;
  pathDropdownRef: React.RefObject<HTMLDivElement>;
  pathSuggestions: { path: string; type: "folder" | "history" }[];
  setEditingPathValue: (value: string) => void;
  setShowPathSuggestions: (value: boolean) => void;
  setPathSuggestionIndex: (value: number) => void;
  handlePathBlur: () => void;
  handlePathKeyDown: (e: React.KeyboardEvent) => void;
  handlePathDoubleClick: () => void;
  handlePathSubmit: (pathOverride?: string) => void;
}

export const useSftpPanePath = ({
  connection,
  files,
  showHiddenFiles,
  onNavigateTo,
}: UseSftpPanePathParams): UseSftpPanePathResult => {
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [editingPathValue, setEditingPathValue] = useState("");
  const [showPathSuggestions, setShowPathSuggestions] = useState(false);
  const [pathSuggestionIndex, setPathSuggestionIndex] = useState(-1);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const pathDropdownRef = useRef<HTMLDivElement>(null);

  const pathSuggestions = useMemo(() => {
    if (!isEditingPath || !connection) return [];
    const currentValue = editingPathValue.trim().toLowerCase();
    const suggestions: { path: string; type: "folder" | "history" }[] = [];

    const folders = filterHiddenFiles(files, showHiddenFiles).filter(
      (f) => isNavigableDirectory(f) && f.name !== "..",
    );
    folders.forEach((f) => {
      const fullPath =
        connection.currentPath === "/"
          ? `/${f.name}`
          : `${connection.currentPath}/${f.name}`;
      if (
        !currentValue ||
        fullPath.toLowerCase().includes(currentValue) ||
        f.name.toLowerCase().includes(currentValue)
      ) {
        suggestions.push({ path: fullPath, type: "folder" });
      }
    });

    const quickPaths = ["/home", "/var", "/etc", "/tmp", "/usr", "/opt", "/root"];
    quickPaths.forEach((qp) => {
      if (!currentValue || qp.toLowerCase().includes(currentValue)) {
        if (!suggestions.some((s) => s.path === qp)) {
          suggestions.push({ path: qp, type: "history" });
        }
      }
    });

    return suggestions.slice(0, 8);
  }, [connection, editingPathValue, files, isEditingPath, showHiddenFiles]);

  const handlePathDoubleClick = () => {
    if (!connection) return;
    setEditingPathValue(connection.currentPath);
    setIsEditingPath(true);
    setShowPathSuggestions(true);
    setPathSuggestionIndex(-1);
    setTimeout(() => pathInputRef.current?.select(), 0);
  };

  const handlePathSubmit = useCallback((pathOverride?: string) => {
    const newPath = (pathOverride ?? editingPathValue).trim() || "/";
    setIsEditingPath(false);
    setShowPathSuggestions(false);
    setPathSuggestionIndex(-1);
    if (connection && newPath !== connection.currentPath) {
      const isWindowsPath = /^[A-Za-z]:/.test(newPath);
      if (isWindowsPath) {
        let normalizedPath = newPath;
        if (/^[A-Za-z]:[\\/]?$/.test(newPath)) {
          normalizedPath = newPath.charAt(0).toUpperCase() + ":\\";
        }
        onNavigateTo(normalizedPath);
      } else {
        onNavigateTo(newPath.startsWith("/") ? newPath : `/${newPath}`);
      }
    }
  }, [connection, editingPathValue, onNavigateTo]);

  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (showPathSuggestions && pathSuggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPathSuggestionIndex((prev) =>
          prev < pathSuggestions.length - 1 ? prev + 1 : 0,
        );
        return;
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setPathSuggestionIndex((prev) =>
          prev > 0 ? prev - 1 : pathSuggestions.length - 1,
        );
        return;
      } else if (e.key === "Tab" && pathSuggestionIndex >= 0) {
        e.preventDefault();
        setEditingPathValue(pathSuggestions[pathSuggestionIndex].path);
        return;
      }
    }
    if (e.key === "Enter") {
      if (pathSuggestionIndex >= 0 && pathSuggestions[pathSuggestionIndex]) {
        handlePathSubmit(pathSuggestions[pathSuggestionIndex].path);
      } else {
        handlePathSubmit();
      }
    } else if (e.key === "Escape") {
      setIsEditingPath(false);
      setShowPathSuggestions(false);
      setPathSuggestionIndex(-1);
    }
  };

  const handlePathBlur = useCallback(() => {
    setTimeout(() => {
      if (!pathDropdownRef.current?.contains(document.activeElement)) {
        handlePathSubmit();
      }
    }, 150);
  }, [handlePathSubmit]);

  return {
    isEditingPath,
    editingPathValue,
    showPathSuggestions,
    pathSuggestionIndex,
    pathInputRef,
    pathDropdownRef,
    pathSuggestions,
    setEditingPathValue,
    setShowPathSuggestions,
    setPathSuggestionIndex,
    handlePathBlur,
    handlePathKeyDown,
    handlePathDoubleClick,
    handlePathSubmit,
  };
};
