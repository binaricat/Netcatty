import React, { useCallback, useEffect, useRef, useState } from "react";
import { Bookmark, Check, Eye, EyeOff, FilePlus, Folder, FolderPlus, Globe, Home, Languages, MoreHorizontal, RefreshCw, Search, TerminalSquare, Trash2, X } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Dropdown, DropdownContent, DropdownTrigger } from "../ui/dropdown";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { SftpBreadcrumb } from "./index";
import type { SftpFilenameEncoding } from "../../types";
import type { SftpPane } from "../../application/state/sftp/types";
import type { SftpBookmark } from "../../domain/models";

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
}

// Prioritize breadcrumb path display. 6 action buttons need ~156px,
// bookmark ~20px, padding ~16px. Collapse early so the breadcrumb
// always gets at least ~200px of space.
const COLLAPSE_WIDTH = 400;

export const SftpPaneToolbar: React.FC<SftpPaneToolbarProps> = ({
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
}) => {
  const outerRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Observe the overall toolbar width to decide whether to collapse action buttons
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCollapsed(entry.contentRect.width < COLLAPSE_WIDTH);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleNewFolder = useCallback(() => {
    setNewFolderName("");
    setShowNewFolderDialog(true);
  }, [setNewFolderName, setShowNewFolderDialog]);

  const handleNewFile = useCallback(() => {
    const defaultName = getNextUntitledName(pane.files.map(f => f.name));
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

  const isRemote = !pane.connection?.isLocal;

  // Buttons that always remain visible (not collapsed)
  const pinnedButtons = (
    <>
      {onGoToTerminalCwd && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onGoToTerminalCwd}
            >
              <TerminalSquare size={14} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("sftp.goToTerminalCwd")}</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
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
    </>
  );

  // Collapsible action buttons (shown inline when space allows)
  const collapsibleButtons = (
    <>
      {isRemote && (
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                >
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
                    "w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-sm hover:bg-secondary transition-colors",
                    pane.filenameEncoding === encoding && "bg-secondary"
                  )}
                  onClick={() => onSetFilenameEncoding(encoding)}
                >
                  <Check
                    size={12}
                    className={cn(
                      "shrink-0",
                      pane.filenameEncoding === encoding ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {t(`sftp.encoding.${encoding === "utf-8" ? "utf8" : encoding}`)}
                </button>
              </PopoverClose>
            ))}
          </PopoverContent>
        </Popover>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={handleNewFolder}
          >
            <FolderPlus size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("sftp.newFolder")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={handleNewFile}
          >
            <FilePlus size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("sftp.newFile")}</TooltipContent>
      </Tooltip>
      <Tooltip>
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
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onRefresh}
          >
            <RefreshCw
              size={14}
              className={
                pane.loading || pane.reconnecting ? "animate-spin" : ""
              }
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("common.refresh")}</TooltipContent>
      </Tooltip>
    </>
  );

  // Overflow dropdown menu items (same collapsible actions as menu items)
  const overflowMenuItems = (
    <div className="flex flex-col min-w-[140px]">
      {isRemote && (
        <Popover>
          <PopoverTrigger asChild>
            <button className="flex items-center gap-2 px-2 py-1.5 text-xs rounded-sm hover:bg-secondary transition-colors w-full text-left">
              <Languages size={14} className="shrink-0" />
              {t("sftp.encoding.label")}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-36 p-1" align="start" side="right">
            {(["auto", "utf-8", "gb18030"] as const).map((encoding) => (
              <PopoverClose asChild key={encoding}>
                <button
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-sm hover:bg-secondary transition-colors",
                    pane.filenameEncoding === encoding && "bg-secondary"
                  )}
                  onClick={() => onSetFilenameEncoding(encoding)}
                >
                  <Check
                    size={12}
                    className={cn(
                      "shrink-0",
                      pane.filenameEncoding === encoding ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {t(`sftp.encoding.${encoding === "utf-8" ? "utf8" : encoding}`)}
                </button>
              </PopoverClose>
            ))}
          </PopoverContent>
        </Popover>
      )}
      <button
        className="flex items-center gap-2 px-2 py-1.5 text-xs rounded-sm hover:bg-secondary transition-colors w-full text-left"
        onClick={handleNewFolder}
      >
        <FolderPlus size={14} className="shrink-0" />
        {t("sftp.newFolder")}
      </button>
      <button
        className="flex items-center gap-2 px-2 py-1.5 text-xs rounded-sm hover:bg-secondary transition-colors w-full text-left"
        onClick={handleNewFile}
      >
        <FilePlus size={14} className="shrink-0" />
        {t("sftp.newFile")}
      </button>
      <button
        className={cn(
          "flex items-center gap-2 px-2 py-1.5 text-xs rounded-sm hover:bg-secondary transition-colors w-full text-left",
          showHiddenFiles && "text-primary",
        )}
        onClick={onToggleShowHiddenFiles}
      >
        {showHiddenFiles ? <EyeOff size={14} className="shrink-0" /> : <Eye size={14} className="shrink-0" />}
        {t("settings.sftp.showHiddenFiles")}
      </button>
      <button
        className="flex items-center gap-2 px-2 py-1.5 text-xs rounded-sm hover:bg-secondary transition-colors w-full text-left"
        onClick={onRefresh}
      >
        <RefreshCw
          size={14}
          className={cn("shrink-0", (pane.loading || pane.reconnecting) && "animate-spin")}
        />
        {t("common.refresh")}
      </button>
    </div>
  );

  return (
    <TooltipProvider delayDuration={500} skipDelayDuration={100} disableHoverableContent>
      {/* Toolbar - always visible when connected */}
      <div ref={outerRef} className="h-7 px-2 flex items-center gap-1 border-b border-border/40 bg-secondary/20">
        {/* Editable Breadcrumb with autocomplete */}
        {isEditingPath ? (
          <div className="relative flex-1">
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
                      <Home
                        size={12}
                        className="text-muted-foreground shrink-0"
                      />
                    )}
                    <span className="truncate font-mono">
                      {suggestion.path}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div
            className="flex-1 min-w-0 cursor-text hover:bg-secondary/50 rounded px-1 transition-colors"
            onDoubleClick={handlePathDoubleClick}
            title={t("sftp.path.doubleClickToEdit")}
          >
            <SftpBreadcrumb
              path={pane.connection.currentPath}
              onNavigate={onNavigateTo}
              onHome={() =>
                pane.connection?.homeDir &&
                onNavigateTo(pane.connection.homeDir)
              }
            />
          </div>
        )}

        {/* Bookmark button with dropdown */}
        <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("h-5 w-5 shrink-0", isCurrentPathBookmarked && "text-yellow-500")}
                    onClick={(e) => {
                  // If not bookmarked, toggle directly instead of opening popover
                  if (!isCurrentPathBookmarked && bookmarks.length === 0) {
                    e.preventDefault();
                    onToggleBookmark();
                  }
                }}
              >
                <Bookmark size={12} fill={isCurrentPathBookmarked ? "currentColor" : "none"} />
              </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>{isCurrentPathBookmarked ? t("sftp.bookmark.remove") : t("sftp.bookmark.add")}</TooltipContent>
            </Tooltip>
            <PopoverContent className="w-64 p-0" align="start">
              <div className="p-2 border-b border-border/40 flex gap-1">
                <Button
                  variant={isCurrentPathBookmarked ? "secondary" : "ghost"}
                  size="sm"
                  className="flex-1 justify-start text-xs h-7"
                  onClick={onToggleBookmark}
                >
                  <Bookmark size={12} fill={isCurrentPathBookmarked ? "currentColor" : "none"} className={cn("mr-2", isCurrentPathBookmarked && "text-yellow-500")} />
                  {isCurrentPathBookmarked ? t("sftp.bookmark.remove") : t("sftp.bookmark.add")}
                </Button>
                {pane.connection?.currentPath && !isCurrentPathGlobalBookmarked && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7 px-2 shrink-0"
                        onClick={() => pane.connection?.currentPath && onAddGlobalBookmark(pane.connection.currentPath)}
                      >
                        {t("sftp.bookmark.addGlobal")}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t("sftp.bookmark.addGlobalTooltip")}</TooltipContent>
                  </Tooltip>
                )}
              </div>
              {bookmarks.length > 0 ? (
                <div className="max-h-48 overflow-auto py-1">
                  {bookmarks.map((bm) => (
                    <div
                      key={bm.id}
                      className="flex items-center gap-1 px-2 py-1 hover:bg-secondary/60 group"
                    >
                      {bm.global && (
                        <Globe size={10} className="shrink-0 text-primary" />
                      )}
                      <button
                        type="button"
                        className="flex-1 text-left text-xs truncate font-mono"
                        onClick={() => onNavigateToBookmark(bm.path)}
                        title={bm.path}
                      >
                        {bm.label}
                        <span className="ml-1.5 text-muted-foreground text-[10px]">{bm.path}</span>
                      </button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 opacity-0 group-hover:opacity-100 shrink-0 text-muted-foreground hover:text-destructive"
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
              )}
            </PopoverContent>
          </Popover>

        {/* Action buttons area - observed for overflow */}
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          {collapsed ? (
            <>
              {pinnedButtons}
              <Dropdown>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                      >
                    <MoreHorizontal size={14} />
                  </Button>
                    </DropdownTrigger>
                  </TooltipTrigger>
                  <TooltipContent>{t("common.more")}</TooltipContent>
                </Tooltip>
                <DropdownContent align="end">
                  {overflowMenuItems}
                </DropdownContent>
              </Dropdown>
            </>
          ) : (
            <>
              {pinnedButtons}
              {collapsibleButtons}
            </>
          )}
        </div>
      </div>

      {/* Inline filter bar - appears below toolbar when search is active */}
      {showFilterBar && (
        <div className="h-8 px-3 flex items-center gap-2 border-b border-border/40 bg-secondary/10">
          <div className="relative flex-1">
            <Search
              size={12}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={filterInputRef}
              value={pane.filter}
              onChange={(e) =>
                startTransition(() => onSetFilter(e.target.value))
              }
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
};
