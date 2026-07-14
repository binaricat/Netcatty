import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, Check, ClipboardCopy, Eye, EyeOff, FilePlus, Folder, FolderPlus, FolderSync, Globe, Home, Languages, List, ListTree, RefreshCw, Search, TerminalSquare, Trash2, X } from "lucide-react";
import { useToolbarItemLayout } from "../../application/state/useToolbarItemLayout";
import type { ToolbarItemLayoutDefaults } from "../../domain/toolbarItemLayout";
import { STORAGE_KEY_SFTP_TOOLBAR_LAYOUT } from "../../infrastructure/config/storageKeys";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../../lib/utils";
import {
  ToolbarCustomizeContextMenu,
  ToolbarOverflowMenu,
  useToolbarOverflowClose,
} from "../ui/toolbar-item-layout";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { SftpBreadcrumb } from "./SftpBreadcrumb";
import type { SftpFilenameEncoding } from "../../types";
import type { SftpPane } from "../../application/state/sftp/types";
import type { SftpBookmark } from "../../domain/models";
import { toast } from "../ui/toast";

export const SFTP_TOOLBAR_ITEM_IDS = [
  "bookmark",
  "goToTerminalCwd",
  "followTerminalCwd",
  "copyPath",
  "viewMode",
  "filter",
  "encoding",
  "newFolder",
  "newFile",
  "showHidden",
  "refresh",
] as const;

export type SftpToolbarItemId = (typeof SFTP_TOOLBAR_ITEM_IDS)[number];

export const SFTP_TOOLBAR_LAYOUT_DEFAULTS: ToolbarItemLayoutDefaults = {
  order: [...SFTP_TOOLBAR_ITEM_IDS],
  placement: {
    bookmark: "show",
    goToTerminalCwd: "show",
    followTerminalCwd: "show",
    copyPath: "show",
    viewMode: "show",
    filter: "show",
    encoding: "collapse",
    newFolder: "show",
    newFile: "show",
    showHidden: "show",
    refresh: "show",
  },
  lockedIds: ["refresh"],
};

/**
 * When the toolbar is narrow, keep these user-shown actions inline so the path
 * still has room. Other user-shown actions temporarily join the ⋮ list.
 * User "hide" / permanent "collapse" are always respected (never re-shown).
 */
export const SFTP_TOOLBAR_NARROW_INLINE_IDS = new Set<SftpToolbarItemId>([
  "bookmark",
  "goToTerminalCwd",
  "followTerminalCwd",
  "copyPath",
  "viewMode",
  "filter",
]);

/** Prioritize path space; same threshold as the pre-customize toolbar. */
export const SFTP_TOOLBAR_NARROW_WIDTH = 400;

/** Apply user placement, then optional narrow-width temporary spill of show → overflow. */
export function resolveSftpToolbarVisibleIds({
  shown,
  collapsed,
  narrow,
}: {
  shown: string[];
  collapsed: string[];
  narrow: boolean;
}): { inlineIds: string[]; overflowIds: string[] } {
  if (!narrow) {
    return { inlineIds: shown, overflowIds: collapsed };
  }
  const inlineIds = shown.filter((id) =>
    SFTP_TOOLBAR_NARROW_INLINE_IDS.has(id as SftpToolbarItemId),
  );
  // If the user hid every pinned id, keep at least the first shown item so ⋮ isn't the only control.
  const safeInline =
    inlineIds.length > 0 ? inlineIds : shown.length > 0 ? [shown[0]] : [];
  const spilled = shown.filter((id) => !safeInline.includes(id));
  return {
    inlineIds: safeInline,
    overflowIds: [...spilled, ...collapsed],
  };
}

type SftpPaneViewMode = "list" | "tree";

export const getNextSftpViewMode = (viewMode: SftpPaneViewMode): SftpPaneViewMode =>
  viewMode === "list" ? "tree" : "list";

export const getSftpViewModeToggleLabelKey = (viewMode: SftpPaneViewMode): string =>
  viewMode === "list" ? "sftp.viewMode.switchToTree" : "sftp.viewMode.switchToList";

export const getSftpViewModeToggleTarget = (viewMode: SftpPaneViewMode) => ({
  nextViewMode: getNextSftpViewMode(viewMode),
  labelKey: getSftpViewModeToggleLabelKey(viewMode),
});

export const shouldToggleSftpBookmarkFromButton = ({
  bookmarkCount,
  isCurrentPathBookmarked,
}: {
  bookmarkCount: number;
  isCurrentPathBookmarked: boolean;
}): boolean => !isCurrentPathBookmarked && bookmarkCount === 0;

export const getSftpBookmarkButtonLabelKey = ({
  bookmarkCount,
  isCurrentPathBookmarked,
}: {
  bookmarkCount: number;
  isCurrentPathBookmarked: boolean;
}): string =>
  shouldToggleSftpBookmarkFromButton({ bookmarkCount, isCurrentPathBookmarked })
    ? "sftp.bookmark.add"
    : "sftp.bookmark.list";

export const copySftpCurrentPathToClipboard = async ({
  currentPath,
  writeText,
  onSuccess,
  onError,
  t,
}: {
  currentPath: string;
  writeText: (text: string) => Promise<void>;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
  t: (key: string) => string;
}) => {
  if (!currentPath) return;

  try {
    await writeText(currentPath);
    onSuccess(t("sftp.copyCurrentPath.success"));
  } catch {
    onError(t("sftp.copyCurrentPath.error"));
  }
};

export const getNextSftpToolbarDisplayPath = ({
  previousDisplayPath,
  previousConnectionId,
  connectionId,
  currentPath,
  loading,
}: {
  previousDisplayPath: string;
  previousConnectionId: string | undefined;
  connectionId: string | undefined;
  currentPath: string | undefined;
  loading: boolean;
}): string => {
  const connectionChanged = connectionId !== previousConnectionId;
  return connectionChanged || !loading ? currentPath ?? "" : previousDisplayPath;
};

interface SftpPaneToolbarProps {
  t: (key: string, params?: Record<string, unknown>) => string;
  pane: SftpPane;
  onNavigateTo: (path: string) => void;
  onSetFilter: (value: string) => void;
  onSetFilenameEncoding: (encoding: SftpFilenameEncoding) => void;
  onRefresh: () => void;
  showFilterBar: boolean;
  setShowFilterBar: (open: boolean) => void;
  filterInputRef: React.RefObject<HTMLInputElement>;
  isEditingPath: boolean;
  editingPathValue: string;
  setEditingPathValue: (value: string) => void;
  setShowPathSuggestions: (open: boolean) => void;
  showPathSuggestions: boolean;
  setPathSuggestionIndex: (value: number) => void;
  pathSuggestions: { path: string; type: "folder" | "history" }[];
  pathSuggestionIndex: number;
  pathInputRef: React.RefObject<HTMLInputElement>;
  pathDropdownRef: React.RefObject<HTMLDivElement>;
  handlePathBlur: () => void;
  handlePathKeyDown: (e: React.KeyboardEvent) => void;
  handlePathDoubleClick: () => void;
  handlePathSubmit: (pathOverride?: string) => void;
  startTransition: React.TransitionStartFunction;
  getNextUntitledName: (existingNames: string[]) => string;
  setNewFileName: (value: string) => void;
  setFileNameError: (value: string | null) => void;
  setShowNewFileDialog: (open: boolean) => void;
  setShowNewFolderDialog: (open: boolean) => void;
  setNewFolderName: (value: string) => void;
  // Bookmark props
  bookmarks: SftpBookmark[];
  isCurrentPathBookmarked: boolean;
  onToggleBookmark: () => void;
  onAddGlobalBookmark: (path: string) => void;
  isCurrentPathGlobalBookmarked: boolean;
  onNavigateToBookmark: (path: string) => void;
  onDeleteBookmark: (id: string) => void;
  showHiddenFiles: boolean;
  onToggleShowHiddenFiles?: () => void;
  onGoToTerminalCwd?: () => void;
  followTerminalCwd?: boolean;
  onToggleFollowTerminalCwd?: () => void;
  viewMode: SftpPaneViewMode;
  onSetViewMode: (mode: SftpPaneViewMode) => void;
  onListDrives?: () => Promise<string[]>;
}

interface SftpBookmarkListProps {
  bookmarks: SftpBookmark[];
  onNavigateToBookmark: (path: string) => void;
  onDeleteBookmark: (id: string) => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}

export const SftpBookmarkList: React.FC<SftpBookmarkListProps> = ({
  bookmarks,
  onNavigateToBookmark,
  onDeleteBookmark,
  t,
}) => (
  bookmarks.length > 0 ? (
    <div className="max-h-48 overflow-auto py-1">
      {bookmarks.map((bm) => (
        <div
          key={bm.id}
          className="flex items-center gap-1 px-2 py-1 hover:bg-secondary/60 group"
        >
          {bm.global && (
            <Globe size={10} className="shrink-0 text-primary" />
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex-1 text-left text-xs truncate font-mono"
                onClick={() => onNavigateToBookmark(bm.path)}
              >
                {bm.label}
                <span className="ml-1.5 text-muted-foreground text-[10px]">{bm.path}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{bm.path}</TooltipContent>
          </Tooltip>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={t("sftp.bookmark.remove")}
            onClick={(e) => {
              e.stopPropagation();
              onDeleteBookmark(bm.id);
            }}
          >
            <Trash2 size={10} />
          </Button>
        </div>
      ))}
    </div>
  ) : (
    <div className="p-3 text-xs text-muted-foreground text-center">
      {t("sftp.bookmark.empty")}
    </div>
  )
);

const menuItemClass =
  "flex items-center gap-2 px-2 py-1.5 text-xs rounded-sm hover:bg-secondary transition-colors w-full text-left";

export const SftpPaneToolbar: React.FC<SftpPaneToolbarProps> = React.memo(({
  t,
  pane,
  onNavigateTo,
  onSetFilter,
  onSetFilenameEncoding,
  onRefresh,
  showFilterBar,
  setShowFilterBar,
  filterInputRef,
  isEditingPath,
  editingPathValue,
  setEditingPathValue,
  setShowPathSuggestions,
  setPathSuggestionIndex,
  showPathSuggestions,
  pathSuggestions,
  pathSuggestionIndex,
  pathInputRef,
  pathDropdownRef,
  handlePathBlur,
  handlePathKeyDown,
  handlePathDoubleClick,
  handlePathSubmit,
  startTransition,
  getNextUntitledName,
  setNewFileName,
  setFileNameError,
  setShowNewFileDialog,
  setShowNewFolderDialog,
  setNewFolderName,
  bookmarks,
  isCurrentPathBookmarked,
  onToggleBookmark,
  onAddGlobalBookmark,
  isCurrentPathGlobalBookmarked,
  onNavigateToBookmark,
  onDeleteBookmark,
  showHiddenFiles,
  onToggleShowHiddenFiles,
  onGoToTerminalCwd,
  followTerminalCwd,
  onToggleFollowTerminalCwd,
  viewMode,
  onSetViewMode,
  onListDrives,
}) => {
  const [displayPath, setDisplayPath] = useState(pane.connection?.currentPath ?? "");
  const prevDisplayConnectionIdRef = useRef(pane.connection?.id);
  const toolbarLayout = useToolbarItemLayout(
    STORAGE_KEY_SFTP_TOOLBAR_LAYOUT,
    SFTP_TOOLBAR_LAYOUT_DEFAULTS,
  );

  useEffect(() => {
    const previousConnectionId = prevDisplayConnectionIdRef.current;
    prevDisplayConnectionIdRef.current = pane.connection?.id;
    setDisplayPath((previousDisplayPath) =>
      getNextSftpToolbarDisplayPath({
        previousDisplayPath,
        previousConnectionId,
        connectionId: pane.connection?.id,
        currentPath: pane.connection?.currentPath,
        loading: pane.loading,
      }),
    );
  }, [pane.connection?.currentPath, pane.connection?.id, pane.loading]);

  const handleNewFolder = useCallback(() => {
    setNewFolderName("");
    setShowNewFolderDialog(true);
  }, [setNewFolderName, setShowNewFolderDialog]);

  const handleNewFile = useCallback(() => {
    const defaultName = getNextUntitledName(pane.files.map((f) => f.name));
    setNewFileName(defaultName);
    setFileNameError(null);
    setShowNewFileDialog(true);
  }, [getNextUntitledName, pane.files, setNewFileName, setFileNameError, setShowNewFileDialog]);

  const handleToggleFilter = useCallback(() => {
    setShowFilterBar(!showFilterBar);
    if (!showFilterBar) {
      setTimeout(() => filterInputRef.current?.focus(), 0);
    }
  }, [showFilterBar, setShowFilterBar, filterInputRef]);

  const handleCopyCurrentPath = useCallback(async () => {
    await copySftpCurrentPathToClipboard({
      currentPath: displayPath,
      writeText: (text) => navigator.clipboard.writeText(text),
      onSuccess: (message) => toast.success(message, "SFTP"),
      onError: (message) => toast.error(message, "SFTP"),
      t,
    });
  }, [displayPath, t]);

  const isRemote = !pane.connection?.isLocal;
  const viewModeToggleTarget = getSftpViewModeToggleTarget(viewMode);
  const viewModeToggleLabel = t(viewModeToggleTarget.labelKey);
  const shouldToggleBookmarkFromButton = shouldToggleSftpBookmarkFromButton({
    bookmarkCount: bookmarks.length,
    isCurrentPathBookmarked,
  });
  const bookmarkButtonLabel = t(
    getSftpBookmarkButtonLabelKey({
      bookmarkCount: bookmarks.length,
      isCurrentPathBookmarked,
    }),
  );

  const availableIds = useMemo(() => {
    const ids: SftpToolbarItemId[] = [
      "bookmark",
      "copyPath",
      "viewMode",
      "filter",
      "newFolder",
      "newFile",
      "showHidden",
      "refresh",
    ];
    if (onGoToTerminalCwd) ids.push("goToTerminalCwd");
    if (onToggleFollowTerminalCwd) ids.push("followTerminalCwd");
    if (isRemote) ids.push("encoding");
    return ids;
  }, [isRemote, onGoToTerminalCwd, onToggleFollowTerminalCwd]);

  const itemLabels = useMemo(
    (): Record<SftpToolbarItemId, string> => ({
      bookmark: bookmarkButtonLabel,
      goToTerminalCwd: t("sftp.goToTerminalCwd"),
      followTerminalCwd: t("sftp.followTerminalCwd"),
      copyPath: t("sftp.copyCurrentPath"),
      viewMode: viewModeToggleLabel,
      filter: t("sftp.filter"),
      encoding: t("sftp.encoding.label"),
      newFolder: t("sftp.newFolder"),
      newFile: t("sftp.newFile"),
      showHidden: t("settings.sftp.showHiddenFiles"),
      refresh: t("common.refresh"),
    }),
    [bookmarkButtonLabel, t, viewModeToggleLabel],
  );

  const itemIcons = useMemo(
    (): Record<SftpToolbarItemId, React.ReactNode> => ({
      bookmark: <Bookmark size={14} />,
      goToTerminalCwd: <TerminalSquare size={14} />,
      followTerminalCwd: <FolderSync size={14} />,
      copyPath: <ClipboardCopy size={14} />,
      viewMode: viewMode === "list" ? <List size={14} /> : <ListTree size={14} />,
      filter: <Search size={14} />,
      encoding: <Languages size={14} />,
      newFolder: <FolderPlus size={14} />,
      newFile: <FilePlus size={14} />,
      showHidden: showHiddenFiles ? <EyeOff size={14} /> : <Eye size={14} />,
      refresh: <RefreshCw size={14} />,
    }),
    [showHiddenFiles, viewMode],
  );

  const customizeItems = useMemo(
    () =>
      toolbarLayout.layout.order
        .filter((id): id is SftpToolbarItemId => (availableIds as string[]).includes(id))
        .map((id) => ({
          id,
          label: itemLabels[id],
          icon: itemIcons[id],
          locked: id === "refresh",
        })),
    [availableIds, itemIcons, itemLabels, toolbarLayout.layout.order],
  );

  const setSftpPlacement = useCallback(
    (id: string, placement: "show" | "collapse" | "hide") => {
      toolbarLayout.setPlacement(id, placement, availableIds);
    },
    [availableIds, toolbarLayout],
  );

  const moveSftpItem = useCallback(
    (id: string, direction: "earlier" | "later") => {
      toolbarLayout.move(id, direction, availableIds);
    },
    [availableIds, toolbarLayout],
  );

  const { shown, collapsed } = toolbarLayout.partition(availableIds);

  const outerRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setNarrow(entry.contentRect.width < SFTP_TOOLBAR_NARROW_WIDTH);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { inlineIds, overflowIds } = useMemo(
    () => resolveSftpToolbarVisibleIds({ shown, collapsed, narrow }),
    [shown, collapsed, narrow],
  );

  const renderBookmarkPopoverBody = (onAfterLeafAction?: () => void) => (
    <SftpBookmarkPopoverBody
      t={t}
      bookmarks={bookmarks}
      isCurrentPathBookmarked={isCurrentPathBookmarked}
      isCurrentPathGlobalBookmarked={isCurrentPathGlobalBookmarked}
      currentPath={pane.connection?.currentPath}
      onToggleBookmark={onToggleBookmark}
      onAddGlobalBookmark={onAddGlobalBookmark}
      onNavigateToBookmark={onNavigateToBookmark}
      onDeleteBookmark={onDeleteBookmark}
      onAfterLeafAction={onAfterLeafAction}
    />
  );

  const renderBookmarkButton = (size: "sm" | "md" = "sm") => (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                size === "sm" ? "h-5 w-5" : "h-6 w-6",
                "shrink-0",
                isCurrentPathBookmarked ? "text-yellow-500" : bookmarks.length > 0 && "text-primary",
              )}
              aria-label={bookmarkButtonLabel}
              onClick={(e) => {
                if (shouldToggleBookmarkFromButton) {
                  e.preventDefault();
                  onToggleBookmark();
                }
              }}
            >
              <Bookmark size={12} fill={isCurrentPathBookmarked ? "currentColor" : "none"} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{bookmarkButtonLabel}</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-64 p-0" align="start">
        {renderBookmarkPopoverBody()}
      </PopoverContent>
    </Popover>
  );

  /** Collapsed (⋮) entry: same path list as the inline bookmark button. */
  const renderBookmarkMenuItem = () => (
    <SftpOverflowNestedBookmark
      menuItemClass={menuItemClass}
      bookmarkButtonLabel={bookmarkButtonLabel}
      isCurrentPathBookmarked={isCurrentPathBookmarked}
      bookmarksCount={bookmarks.length}
      shouldToggleBookmarkFromButton={shouldToggleBookmarkFromButton}
      onToggleBookmark={onToggleBookmark}
      renderBody={(closeOverflow) => renderBookmarkPopoverBody(closeOverflow)}
    />
  );

  const renderEncodingInline = () => (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6">
              <Languages size={14} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("sftp.encoding.label")}</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-36 p-1" align="end">
        {(["auto", "utf-8", "gb18030"] as const).map((encoding) => (
          <PopoverClose asChild key={encoding}>
            <button
              className={cn(
                menuItemClass,
                pane.filenameEncoding === encoding && "bg-secondary",
              )}
              onClick={() => onSetFilenameEncoding(encoding)}
            >
              <Check
                size={12}
                className={cn(
                  "shrink-0",
                  pane.filenameEncoding === encoding ? "opacity-100" : "opacity-0",
                )}
              />
              {t(`sftp.encoding.${encoding === "utf-8" ? "utf8" : encoding}`)}
            </button>
          </PopoverClose>
        ))}
      </PopoverContent>
    </Popover>
  );

  const renderEncodingMenu = () => (
    <SftpOverflowNestedEncoding
      menuItemClass={menuItemClass}
      label={t("sftp.encoding.label")}
      filenameEncoding={pane.filenameEncoding}
      onSetFilenameEncoding={onSetFilenameEncoding}
      t={t}
    />
  );

  const renderInline = (id: string): React.ReactNode => {
    switch (id as SftpToolbarItemId) {
      case "bookmark":
        return <React.Fragment key={id}>{renderBookmarkButton("sm")}</React.Fragment>;
      case "goToTerminalCwd":
        if (!onGoToTerminalCwd) return null;
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onGoToTerminalCwd}>
                <TerminalSquare size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("sftp.goToTerminalCwd")}</TooltipContent>
          </Tooltip>
        );
      case "followTerminalCwd":
        if (!onToggleFollowTerminalCwd) return null;
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn("h-6 w-6", followTerminalCwd && "bg-secondary text-primary")}
                aria-pressed={!!followTerminalCwd}
                aria-label={t("sftp.followTerminalCwd")}
                onClick={onToggleFollowTerminalCwd}
              >
                <FolderSync size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {followTerminalCwd
                ? t("sftp.followTerminalCwd.disable")
                : t("sftp.followTerminalCwd.enable")}
            </TooltipContent>
          </Tooltip>
        );
      case "copyPath":
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={t("sftp.copyCurrentPath")}
                disabled={!displayPath}
                onClick={handleCopyCurrentPath}
              >
                <ClipboardCopy size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("sftp.copyCurrentPath")}</TooltipContent>
          </Tooltip>
        );
      case "viewMode":
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 bg-secondary text-foreground"
                aria-label={viewModeToggleLabel}
                onClick={() => onSetViewMode(viewModeToggleTarget.nextViewMode)}
              >
                {viewMode === "list" ? <List size={14} /> : <ListTree size={14} />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{viewModeToggleLabel}</TooltipContent>
          </Tooltip>
        );
      case "filter":
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant={showFilterBar || pane.filter ? "secondary" : "ghost"}
                size="icon"
                className={cn("h-6 w-6", pane.filter && "text-primary")}
                onClick={handleToggleFilter}
              >
                <Search size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("sftp.filter")}</TooltipContent>
          </Tooltip>
        );
      case "encoding":
        return <React.Fragment key={id}>{renderEncodingInline()}</React.Fragment>;
      case "newFolder":
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleNewFolder}>
                <FolderPlus size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("sftp.newFolder")}</TooltipContent>
          </Tooltip>
        );
      case "newFile":
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleNewFile}>
                <FilePlus size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("sftp.newFile")}</TooltipContent>
          </Tooltip>
        );
      case "showHidden":
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant={showHiddenFiles ? "secondary" : "ghost"}
                size="icon"
                className={cn("h-6 w-6", showHiddenFiles && "text-primary")}
                onClick={onToggleShowHiddenFiles}
              >
                {showHiddenFiles ? <EyeOff size={14} /> : <Eye size={14} />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("settings.sftp.showHiddenFiles")}</TooltipContent>
          </Tooltip>
        );
      case "refresh":
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onRefresh}>
                <RefreshCw
                  size={14}
                  className={
                    pane.loading && !pane.connection?.reusedConnection && !pane.reconnecting
                      ? "animate-spin"
                      : ""
                  }
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("common.refresh")}</TooltipContent>
          </Tooltip>
        );
      default:
        return null;
    }
  };

  const renderCollapsed = (id: string): React.ReactNode => {
    switch (id as SftpToolbarItemId) {
      case "bookmark":
        return <React.Fragment key={id}>{renderBookmarkMenuItem()}</React.Fragment>;
      case "goToTerminalCwd":
        if (!onGoToTerminalCwd) return null;
        return (
          <button key={id} type="button" className={menuItemClass} onClick={onGoToTerminalCwd}>
            <TerminalSquare size={14} className="shrink-0" />
            {t("sftp.goToTerminalCwd")}
          </button>
        );
      case "followTerminalCwd":
        if (!onToggleFollowTerminalCwd) return null;
        return (
          <button
            key={id}
            type="button"
            className={cn(menuItemClass, followTerminalCwd && "text-primary")}
            onClick={onToggleFollowTerminalCwd}
          >
            <FolderSync size={14} className="shrink-0" />
            {followTerminalCwd
              ? t("sftp.followTerminalCwd.disable")
              : t("sftp.followTerminalCwd.enable")}
          </button>
        );
      case "copyPath":
        return (
          <button
            key={id}
            type="button"
            className={menuItemClass}
            disabled={!displayPath}
            onClick={handleCopyCurrentPath}
          >
            <ClipboardCopy size={14} className="shrink-0" />
            {t("sftp.copyCurrentPath")}
          </button>
        );
      case "viewMode":
        return (
          <button
            key={id}
            type="button"
            className={menuItemClass}
            onClick={() => onSetViewMode(viewModeToggleTarget.nextViewMode)}
          >
            {viewMode === "list" ? (
              <List size={14} className="shrink-0" />
            ) : (
              <ListTree size={14} className="shrink-0" />
            )}
            {viewModeToggleLabel}
          </button>
        );
      case "filter":
        return (
          <button key={id} type="button" className={menuItemClass} onClick={handleToggleFilter}>
            <Search size={14} className="shrink-0" />
            {t("sftp.filter")}
          </button>
        );
      case "encoding":
        return <React.Fragment key={id}>{renderEncodingMenu()}</React.Fragment>;
      case "newFolder":
        return (
          <button key={id} type="button" className={menuItemClass} onClick={handleNewFolder}>
            <FolderPlus size={14} className="shrink-0" />
            {t("sftp.newFolder")}
          </button>
        );
      case "newFile":
        return (
          <button key={id} type="button" className={menuItemClass} onClick={handleNewFile}>
            <FilePlus size={14} className="shrink-0" />
            {t("sftp.newFile")}
          </button>
        );
      case "showHidden":
        return (
          <button
            key={id}
            type="button"
            className={cn(menuItemClass, showHiddenFiles && "text-primary")}
            onClick={onToggleShowHiddenFiles}
          >
            {showHiddenFiles ? (
              <EyeOff size={14} className="shrink-0" />
            ) : (
              <Eye size={14} className="shrink-0" />
            )}
            {t("settings.sftp.showHiddenFiles")}
          </button>
        );
      case "refresh":
        return (
          <button key={id} type="button" className={menuItemClass} onClick={onRefresh}>
            <RefreshCw
              size={14}
              className={cn(
                "shrink-0",
                pane.loading &&
                  !pane.connection?.reusedConnection &&
                  !pane.reconnecting &&
                  "animate-spin",
              )}
            />
            {t("common.refresh")}
          </button>
        );
      default:
        return null;
    }
  };

  const overflowNodes = overflowIds.map(renderCollapsed).filter(Boolean);

  return (
    <TooltipProvider delayDuration={500} skipDelayDuration={100} disableHoverableContent>
      {/* Path chrome stays outside customize so path right-click keeps native/browser menus. */}
      <div
        ref={outerRef}
        className="h-7 px-2 flex items-center gap-1 border-b border-border/40 bg-secondary/20"
        data-section="terminal-sftp-toolbar"
      >
          {/* Editable Breadcrumb with autocomplete */}
          {isEditingPath ? (
            <div className="relative flex-1 min-w-0" data-section="terminal-sftp-path">
              <Input
                ref={pathInputRef}
                value={editingPathValue}
                onChange={(e) => {
                  setEditingPathValue(e.target.value);
                  setShowPathSuggestions(true);
                  setPathSuggestionIndex(-1);
                }}
                onBlur={handlePathBlur}
                onKeyDown={handlePathKeyDown}
                onFocus={() => setShowPathSuggestions(true)}
                className="h-5 w-full text-[10px] bg-background"
                autoFocus
              />
              {showPathSuggestions && pathSuggestions.length > 0 && (
                <div
                  ref={pathDropdownRef}
                  className="absolute top-full left-0 right-0 mt-1 bg-popover border border-border rounded-md shadow-lg z-50 max-h-48 overflow-auto"
                >
                  {pathSuggestions.map((suggestion, idx) => (
                    <button
                      key={suggestion.path}
                      type="button"
                      className={cn(
                        "w-full px-3 py-2 text-left text-xs flex items-center gap-2 hover:bg-secondary/60 transition-colors",
                        idx === pathSuggestionIndex && "bg-secondary/80",
                      )}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handlePathSubmit(suggestion.path);
                      }}
                    >
                      {suggestion.type === "folder" ? (
                        <Folder size={12} className="text-primary shrink-0" />
                      ) : (
                        <Home size={12} className="text-muted-foreground shrink-0" />
                      )}
                      <span className="truncate font-mono">{suggestion.path}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className="flex-1 min-w-0 cursor-text hover:bg-secondary/50 rounded px-1 transition-colors"
                  data-section="terminal-sftp-path"
                  onDoubleClick={handlePathDoubleClick}
                >
                  <SftpBreadcrumb
                    path={displayPath}
                    onNavigate={onNavigateTo}
                    onHome={() =>
                      pane.connection?.homeDir && onNavigateTo(pane.connection.homeDir)
                    }
                    isLocal={!isRemote}
                    onListDrives={onListDrives}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent>{t("sftp.path.doubleClickToEdit")}</TooltipContent>
            </Tooltip>
          )}

          <ToolbarCustomizeContextMenu
            items={customizeItems}
            placementOf={(id) => toolbarLayout.layout.placement[id] ?? "show"}
            onSetPlacement={setSftpPlacement}
            onMove={moveSftpItem}
            onReset={toolbarLayout.reset}
            t={t}
            className="ml-auto flex items-center gap-0.5 shrink-0"
          >
            {inlineIds.map(renderInline)}
            <ToolbarOverflowMenu
              hasItems={overflowNodes.length > 0}
              label={t("common.more")}
              orientation="horizontal"
              buttonClassName="h-6 w-6"
              contentClassName="min-w-[140px]"
            >
              <div className="flex flex-col min-w-[140px]">{overflowNodes}</div>
            </ToolbarOverflowMenu>
          </ToolbarCustomizeContextMenu>
      </div>

      {showFilterBar && (
        <div
          className="h-8 px-3 flex items-center gap-2 border-b border-border/40 bg-secondary/10"
          data-section="terminal-sftp-filter-bar"
        >
          <div className="relative flex-1">
            <Search
              size={12}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={filterInputRef}
              value={pane.filter}
              onChange={(e) => startTransition(() => onSetFilter(e.target.value))}
              placeholder={t("sftp.filter.placeholder")}
              className="h-6 w-full pl-7 pr-7 text-xs bg-background"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (pane.filter) {
                    startTransition(() => onSetFilter(""));
                  } else {
                    setShowFilterBar(false);
                  }
                }
              }}
            />
            {pane.filter && (
              <button
                onClick={() => startTransition(() => onSetFilter(""))}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X size={12} />
              </button>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => {
                  startTransition(() => onSetFilter(""));
                  setShowFilterBar(false);
                }}
              >
                <X size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("common.close")}</TooltipContent>
          </Tooltip>
        </div>
      )}
    </TooltipProvider>
  );
});

function SftpBookmarkPopoverBody({
  t,
  bookmarks,
  isCurrentPathBookmarked,
  isCurrentPathGlobalBookmarked,
  currentPath,
  onToggleBookmark,
  onAddGlobalBookmark,
  onNavigateToBookmark,
  onDeleteBookmark,
  onAfterLeafAction,
}: {
  t: (key: string, params?: Record<string, unknown>) => string;
  bookmarks: SftpBookmark[];
  isCurrentPathBookmarked: boolean;
  isCurrentPathGlobalBookmarked: boolean;
  currentPath?: string;
  onToggleBookmark: () => void;
  onAddGlobalBookmark: (path: string) => void;
  onNavigateToBookmark: (path: string) => void;
  onDeleteBookmark: (id: string) => void;
  onAfterLeafAction?: () => void;
}) {
  const runThenClose = (action: () => void) => {
    action();
    onAfterLeafAction?.();
  };

  return (
    <>
      <div className="px-3 py-2 border-b border-border/40">
        <div className="text-xs font-medium">{t("sftp.bookmark.list")}</div>
      </div>
      <div className="p-2 border-b border-border/40 flex gap-1">
        <Button
          variant={isCurrentPathBookmarked ? "secondary" : "ghost"}
          size="sm"
          className="flex-1 justify-start text-xs h-7"
          onClick={() => runThenClose(onToggleBookmark)}
        >
          <Bookmark
            size={12}
            fill={isCurrentPathBookmarked ? "currentColor" : "none"}
            className={cn("mr-2", isCurrentPathBookmarked && "text-yellow-500")}
          />
          {isCurrentPathBookmarked ? t("sftp.bookmark.remove") : t("sftp.bookmark.add")}
        </Button>
        {currentPath && !isCurrentPathGlobalBookmarked && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-7 px-2 shrink-0"
                onClick={() => runThenClose(() => onAddGlobalBookmark(currentPath))}
              >
                {t("sftp.bookmark.addGlobal")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("sftp.bookmark.addGlobalTooltip")}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <SftpBookmarkList
        bookmarks={bookmarks}
        onNavigateToBookmark={(path) => runThenClose(() => onNavigateToBookmark(path))}
        onDeleteBookmark={(id) => runThenClose(() => onDeleteBookmark(id))}
        t={t}
      />
    </>
  );
}

/** Nested bookmark opener inside ⋮ — keeps overflow open until a leaf action. */
function SftpOverflowNestedBookmark({
  menuItemClass,
  bookmarkButtonLabel,
  isCurrentPathBookmarked,
  bookmarksCount,
  shouldToggleBookmarkFromButton,
  onToggleBookmark,
  renderBody,
}: {
  menuItemClass: string;
  bookmarkButtonLabel: string;
  isCurrentPathBookmarked: boolean;
  bookmarksCount: number;
  shouldToggleBookmarkFromButton: boolean;
  onToggleBookmark: () => void;
  renderBody: (closeOverflow: () => void) => React.ReactNode;
}) {
  const closeOverflow = useToolbarOverflowClose();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-toolbar-overflow-keep-open="true"
          className={cn(
            menuItemClass,
            isCurrentPathBookmarked && "text-yellow-500",
            !isCurrentPathBookmarked && bookmarksCount > 0 && "text-primary",
          )}
          aria-label={bookmarkButtonLabel}
          onClick={(e) => {
            if (shouldToggleBookmarkFromButton) {
              e.preventDefault();
              onToggleBookmark();
              closeOverflow();
            }
          }}
        >
          <Bookmark
            size={14}
            className="shrink-0"
            fill={isCurrentPathBookmarked ? "currentColor" : "none"}
          />
          {bookmarkButtonLabel}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 p-0"
        align="start"
        side="left"
        sideOffset={6}
        data-toolbar-nested-menu="true"
      >
        {renderBody(closeOverflow)}
      </PopoverContent>
    </Popover>
  );
}

function SftpOverflowNestedEncoding({
  menuItemClass,
  label,
  filenameEncoding,
  onSetFilenameEncoding,
  t,
}: {
  menuItemClass: string;
  label: string;
  filenameEncoding: SftpFilenameEncoding;
  onSetFilenameEncoding: (encoding: SftpFilenameEncoding) => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  const closeOverflow = useToolbarOverflowClose();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-toolbar-overflow-keep-open="true" className={menuItemClass}>
          <Languages size={14} className="shrink-0" />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-36 p-1"
        align="start"
        side="left"
        sideOffset={6}
        data-toolbar-nested-menu="true"
      >
        {(["auto", "utf-8", "gb18030"] as const).map((encoding) => (
          <PopoverClose asChild key={encoding}>
            <button
              className={cn(
                menuItemClass,
                filenameEncoding === encoding && "bg-secondary",
              )}
              onClick={() => {
                onSetFilenameEncoding(encoding);
                closeOverflow();
              }}
            >
              <Check
                size={12}
                className={cn(
                  "shrink-0",
                  filenameEncoding === encoding ? "opacity-100" : "opacity-0",
                )}
              />
              {t(`sftp.encoding.${encoding === "utf-8" ? "utf8" : encoding}`)}
            </button>
          </PopoverClose>
        ))}
      </PopoverContent>
    </Popover>
  );
}
