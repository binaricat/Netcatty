import React, { useEffect, useState } from "react";
import { ArrowUp, Bookmark, Check, ChevronRight, Eye, EyeOff, FilePlus, FolderPlus, FolderUp, Home, Languages, MoreHorizontal, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { cn } from "../../lib/utils";
import type { Host, SftpFilenameEncoding } from "../../types";
import { useSftpBookmarks } from "../sftp/hooks/useSftpBookmarks";
import { DistroAvatar } from "../DistroAvatar";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

interface BreadcrumbPart {
  part: string;
  originalIndex: number;
}

interface SftpModalHeaderProps {
  t: (key: string, params?: Record<string, unknown>) => string;
  host: Host;
  credentials: { username?: string; hostname: string; port?: number };
  showEncoding: boolean;
  filenameEncoding: SftpFilenameEncoding;
  onFilenameEncodingChange: (encoding: SftpFilenameEncoding) => void;
  currentPath: string;
  isEditingPath: boolean;
  editingPathValue: string;
  setEditingPathValue: (value: string) => void;
  handlePathSubmit: () => void;
  handlePathKeyDown: (e: React.KeyboardEvent) => void;
  handlePathDoubleClick: () => void;
  isAtRoot: boolean;
  rootLabel: string;
  isRefreshing: boolean;
  onUp: () => void;
  onHome: () => void;
  onRefresh: () => void;
  visibleBreadcrumbs: BreadcrumbPart[];
  hiddenBreadcrumbs: BreadcrumbPart[];
  needsBreadcrumbTruncation: boolean;
  breadcrumbs: string[];
  onBreadcrumbSelect: (index: number) => void;
  onRootSelect: () => void;
  inputRef: React.RefObject<HTMLInputElement>;
  folderInputRef: React.RefObject<HTMLInputElement>;
  pathInputRef: React.RefObject<HTMLInputElement>;
  uploading: boolean;
  onTriggerUpload: () => void;
  onTriggerFolderUpload: () => void;
  onCreateFolder: () => void;
  onCreateFile: () => void;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onFolderSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  showHiddenFiles: boolean;
  onToggleShowHiddenFiles: () => void;
  onUpdateHost?: (host: Host) => void;
  onNavigateToBookmark?: (path: string) => void;
  onClose?: () => void;
}

export const SftpModalHeader: React.FC<SftpModalHeaderProps> = ({
  t,
  host,
  credentials,
  showEncoding,
  filenameEncoding,
  onFilenameEncodingChange,
  currentPath,
  isEditingPath,
  editingPathValue,
  setEditingPathValue,
  handlePathSubmit,
  handlePathKeyDown,
  handlePathDoubleClick,
  isAtRoot,
  rootLabel,
  isRefreshing,
  onUp,
  onHome,
  onRefresh,
  visibleBreadcrumbs,
  hiddenBreadcrumbs,
  needsBreadcrumbTruncation,
  breadcrumbs,
  onBreadcrumbSelect,
  onRootSelect,
  inputRef,
  folderInputRef,
  pathInputRef,
  uploading,
  onTriggerUpload,
  onTriggerFolderUpload,
  onCreateFolder,
  onCreateFile,
  onFileSelect,
  onFolderSelect,
  showHiddenFiles,
  onToggleShowHiddenFiles,
  onUpdateHost,
  onNavigateToBookmark,
  onClose,
}) => {
  // Delay tooltip activation to prevent flickering when modal opens
  const [tooltipsReady, setTooltipsReady] = useState(false);
  const [openTooltip, setOpenTooltip] = useState<string | null>(null);

  // Bookmarks
  const {
    bookmarks,
    isCurrentPathBookmarked,
    toggleBookmark,
    deleteBookmark,
  } = useSftpBookmarks({
    host,
    currentPath,
    onUpdateHost,
  });

  useEffect(() => {
    const timer = setTimeout(() => setTooltipsReady(true), 500);
    return () => clearTimeout(timer);
  }, []);

  const handleTooltipOpenChange = (id: string) => (open: boolean) => {
    if (!tooltipsReady) return;
    setOpenTooltip(open ? id : null);
  };

  return (
    <>
      <div className="px-4 py-3 border-b border-border/60 flex-shrink-0">
        <div className="flex items-center gap-3">
          <DistroAvatar
            host={host}
            fallback={host.label.slice(0, 2).toUpperCase()}
            className="h-8 w-8"
            size="sm"
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold">
              {host.label}
            </div>
            <div className="text-xs text-muted-foreground font-mono">
              {credentials.username || "root"}@{credentials.hostname}:
              {credentials.port || 22}
            </div>
          </div>
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={onClose}
            >
              <X size={14} />
            </Button>
          )}
        </div>
      </div>

      <TooltipProvider delayDuration={500} skipDelayDuration={800} disableHoverableContent>
        <div className="px-4 py-2 border-b border-border/60 flex items-center gap-2 flex-shrink-0 bg-muted/30">
          <Tooltip open={openTooltip === 'up'} onOpenChange={handleTooltipOpenChange('up')}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onUp}
                disabled={isAtRoot}
              >
                <ArrowUp size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("sftp.nav.up")}</TooltipContent>
          </Tooltip>
          <Tooltip open={openTooltip === 'home'} onOpenChange={handleTooltipOpenChange('home')}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onHome}
              >
                <Home size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("sftp.nav.home")}</TooltipContent>
          </Tooltip>
          <Tooltip open={openTooltip === 'refresh'} onOpenChange={handleTooltipOpenChange('refresh')}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onRefresh}
              >
                <RefreshCw
                  size={14}
                  className={cn(isRefreshing && "animate-spin")}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("sftp.nav.refresh")}</TooltipContent>
          </Tooltip>
          {/* Bookmark button */}
          {onUpdateHost && (
            <Popover>
              <Tooltip open={openTooltip === 'bookmark'} onOpenChange={handleTooltipOpenChange('bookmark')}>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                    >
                      <Bookmark
                        size={14}
                        className={cn(
                          isCurrentPathBookmarked && "fill-yellow-500 text-yellow-500"
                        )}
                      />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  {isCurrentPathBookmarked ? t("sftp.bookmark.remove") : t("sftp.bookmark.add")}
                </TooltipContent>
              </Tooltip>
              <PopoverContent className="w-56 p-1" align="start">
                {/* Toggle button */}
                <button
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-sm hover:bg-secondary transition-colors"
                  onClick={toggleBookmark}
                >
                  <Bookmark
                    size={12}
                    className={cn(
                      "shrink-0",
                      isCurrentPathBookmarked && "fill-yellow-500 text-yellow-500"
                    )}
                  />
                  {isCurrentPathBookmarked ? t("sftp.bookmark.remove") : t("sftp.bookmark.add")}
                </button>
                {/* Divider + list */}
                {bookmarks.length > 0 && (
                  <>
                    <div className="my-1 border-t border-border/60" />
                    {bookmarks.map((bm) => (
                      <div
                        key={bm.id}
                        className="group flex items-center gap-1 px-2 py-1.5 text-xs rounded-sm hover:bg-secondary transition-colors cursor-pointer"
                        onClick={() => onNavigateToBookmark?.(bm.path)}
                        title={bm.path}
                      >
                        <Bookmark size={10} className="shrink-0 text-muted-foreground" />
                        <span className="flex-1 truncate">{bm.label}</span>
                        <span className="flex-1 truncate text-muted-foreground text-[10px]">{bm.path}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-4 w-4 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteBookmark(bm.id);
                          }}
                        >
                          <Trash2 size={10} />
                        </Button>
                      </div>
                    ))}
                  </>
                )}
                {bookmarks.length === 0 && (
                  <div className="p-2 text-xs text-muted-foreground text-center">
                    {t("sftp.bookmark.empty")}
                  </div>
                )}
              </PopoverContent>
            </Popover>
          )}
          {showEncoding && (
            <Popover>
              <Tooltip open={openTooltip === 'encoding'} onOpenChange={handleTooltipOpenChange('encoding')}>
                <TooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                    >
                      <Languages size={14} />
                    </Button>
                  </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>{t("sftp.encoding.label")}</TooltipContent>
              </Tooltip>
              <PopoverContent className="w-36 p-1" align="start">
                {(["auto", "utf-8", "gb18030"] as const).map((encoding) => (
                  <PopoverClose asChild key={encoding}>
                    <button
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm hover:bg-secondary transition-colors",
                        filenameEncoding === encoding && "bg-secondary"
                      )}
                      onClick={() => onFilenameEncodingChange(encoding)}
                    >
                      <Check
                        size={14}
                        className={cn(
                          "shrink-0",
                          filenameEncoding === encoding ? "opacity-100" : "opacity-0"
                        )}
                      />
                      {t(`sftp.encoding.${encoding === "utf-8" ? "utf8" : encoding}`)}
                    </button>
                  </PopoverClose>
                ))}
              </PopoverContent>
            </Popover>
          )}
          <Tooltip
            open={openTooltip === 'showHiddenFiles'}
            onOpenChange={handleTooltipOpenChange('showHiddenFiles')}
          >
            <TooltipTrigger asChild>
              <Button
                variant={showHiddenFiles ? "secondary" : "ghost"}
                size="icon"
                className={cn("h-7 w-7", showHiddenFiles && "text-primary")}
                onClick={onToggleShowHiddenFiles}
              >
                {showHiddenFiles ? <EyeOff size={14} /> : <Eye size={14} />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("settings.sftp.showHiddenFiles")}</TooltipContent>
          </Tooltip>

          <div className="flex items-center gap-1 text-sm flex-1 min-w-0 overflow-hidden">
            {isEditingPath ? (
              <Input
                ref={pathInputRef}
                value={editingPathValue}
                onChange={(e) => setEditingPathValue(e.target.value)}
                onBlur={handlePathSubmit}
                onKeyDown={handlePathKeyDown}
                className="h-7 text-sm bg-background"
                autoFocus
              />
            ) : (
              <div
                className="flex items-center gap-1 flex-1 min-w-0 cursor-text hover:bg-secondary/50 rounded px-1 py-0.5 transition-colors"
                onDoubleClick={handlePathDoubleClick}
                title={currentPath}
              >
                <button
                  className="text-muted-foreground hover:text-foreground px-1 shrink-0"
                  onClick={onRootSelect}
                >
                  {rootLabel}
                </button>
                {visibleBreadcrumbs.map(({ part, originalIndex }, displayIdx) => {
                  const isLast = originalIndex === breadcrumbs.length - 1;
                  const showEllipsisBefore =
                    needsBreadcrumbTruncation && displayIdx === 1;

                  return (
                    <React.Fragment key={originalIndex}>
                      {showEllipsisBefore && (
                        <>
                          <ChevronRight
                            size={12}
                            className="text-muted-foreground flex-shrink-0"
                          />
                          <span
                            className="text-muted-foreground px-1 shrink-0 flex items-center cursor-default"
                            title={`${t("sftp.showHiddenPaths")}: ${hiddenBreadcrumbs
                              .map((h) => h.part)
                              .join(" > ")}`}
                          >
                            <MoreHorizontal size={14} />
                          </span>
                        </>
                      )}
                      <ChevronRight
                        size={12}
                        className="text-muted-foreground flex-shrink-0"
                      />
                      <button
                        className={cn(
                          "text-muted-foreground hover:text-foreground truncate px-1 max-w-[100px]",
                          isLast && "text-foreground font-medium",
                        )}
                        onClick={() => onBreadcrumbSelect(originalIndex)}
                        title={part}
                      >
                        {part}
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 ml-auto">
            <Tooltip open={openTooltip === 'upload'} onOpenChange={handleTooltipOpenChange('upload')}>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  onClick={onTriggerUpload}
                  disabled={uploading}
                >
                  <Upload size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("sftp.upload")}</TooltipContent>
            </Tooltip>
            <Tooltip open={openTooltip === 'uploadFolder'} onOpenChange={handleTooltipOpenChange('uploadFolder')}>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  onClick={onTriggerFolderUpload}
                  disabled={uploading}
                >
                  <FolderUp size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("sftp.uploadFolder")}</TooltipContent>
            </Tooltip>
            <Tooltip open={openTooltip === 'newFolder'} onOpenChange={handleTooltipOpenChange('newFolder')}>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  onClick={onCreateFolder}
                >
                  <FolderPlus size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("sftp.newFolder")}</TooltipContent>
            </Tooltip>
            <Tooltip open={openTooltip === 'newFile'} onOpenChange={handleTooltipOpenChange('newFile')}>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  onClick={onCreateFile}
                >
                  <FilePlus size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("sftp.newFile")}</TooltipContent>
            </Tooltip>
            <input
              type="file"
              className="hidden"
              ref={inputRef}
              onChange={onFileSelect}
              multiple
            />
            <input
              type="file"
              className="hidden"
              ref={folderInputRef}
              onChange={onFolderSelect}
              webkitdirectory=""
              multiple
            />
          </div>
        </div>
      </TooltipProvider>
    </>
  );
};
