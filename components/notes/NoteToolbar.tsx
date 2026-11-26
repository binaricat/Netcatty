import {
  Bold,
  Check,
  CheckSquare,
  Code,
  Eye,
  FileCode,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  PencilLine,
  Quote,
  Redo2,
  Search,
  Sigma,
  SquareCode,
  Strikethrough,
  Table as TableIcon,
  Type,
  Underline,
  Undo2,
} from "lucide-react";
import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { type MarkdownActionType } from "../../domain/notes";
import { useAvailableFonts } from "../../application/state/fontStore";
import { useI18n } from "../../application/i18n/I18nProvider";
import type { ActiveTextFormats, NoteEditorMode } from "./noteEditorTypes";
import { EMPTY_ACTIVE_FORMATS } from "./noteEditorTypes";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ToolbarOverflowMenu, useToolbarOverflowClose } from "../ui/toolbar-item-layout";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";

export interface NoteToolbarProps {
  editorMode: NoteEditorMode;
  onAction?: (action: MarkdownActionType) => void;
  onOpenHostPicker?: () => void;
  className?: string;
  noteFontFamily?: string;
  onChangeNoteFontFamily?: (font: string) => void;
  noteFontSize?: number;
  onChangeNoteFontSize?: (size: number) => void;
  noteCodeFontSize?: number;
  onChangeNoteCodeFontSize?: (size: number) => void;
  /** Active text-format toggles at the current selection (button highlight). */
  activeFormats?: ActiveTextFormats;
}

export interface NoteModeDropdownProps {
  editorMode: NoteEditorMode;
  onChangeMode: (mode: NoteEditorMode) => void;
  className?: string;
}

const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20];
const CODE_FONT_SIZES = [11, 12, 13, 14, 15, 16, 18];

const toolbarButtonClass = "flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors";
const overflowItemClass = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors";

// Preserve the format row's visual order, including the existing group boundaries.
const FORMAT_ITEMS = [
  { id: "undo", icon: Undo2, label: "undo" },
  { id: "redo", icon: Redo2, label: "redo" },
  { id: "typography", icon: Type, label: "typography", separator: true },
  { id: "heading", icon: Heading, label: "headingLevel" },
  { id: "bold", icon: Bold, label: "bold", format: "bold" },
  { id: "italic", icon: Italic, label: "italic", format: "italic" },
  { id: "strikethrough", icon: Strikethrough, label: "strikethrough", format: "strikethrough" },
  { id: "underline", icon: Underline, label: "underline", format: "underline" },
  { id: "code", icon: Code, label: "inlineCode", format: "code" },
  { id: "bullet", icon: List, label: "bulletList", separator: true },
  { id: "number", icon: ListOrdered, label: "orderedList" },
  { id: "task", icon: CheckSquare, label: "taskList" },
  { id: "quote", icon: Quote, label: "quote", separator: true },
  { id: "codeblock", icon: FileCode, label: "codeBlock" },
  { id: "math", icon: Sigma, label: "mathFormula" },
  { id: "table", icon: TableIcon, label: "table" },
  { id: "divider", icon: Minus, label: "divider" },
  { id: "link", icon: LinkIcon, label: "link" },
  { id: "image", icon: ImageIcon, label: "image" },
] as const;

// 26px icon buttons, 2px gaps; each separator adds 9px plus another gap.
const formatRowWidth = (count: number) =>
  count * 28 - 2 + FORMAT_ITEMS.slice(0, count).filter((item) => "separator" in item).length * 11;

/** Nested controls follow the same keep-open / leaf-close contract as SFTP. */
const NoteToolbarPopover: React.FC<{
  label: string;
  icon: React.ReactNode;
  collapsed: boolean;
  contentClassName: string;
  children: React.ReactNode;
}> = ({ label, icon, collapsed, contentClassName, children }) => {
  const closeOverflow = useToolbarOverflowClose();
  const triggerButton = (
    <button
      type="button"
      className={collapsed ? overflowItemClass : toolbarButtonClass}
      aria-label={label}
      data-toolbar-overflow-keep-open="true"
      onMouseDown={(event) => event.preventDefault()}
    >
      {icon}
      {collapsed && <span>{label}</span>}
    </button>
  );
  return (
    <Popover>
      {collapsed ? (
        <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
      )}
      <PopoverContent
        align="start"
        className={contentClassName}
        data-toolbar-nested-menu="true"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onClick={(event) => {
          if ((event.target as Element).closest("button")) closeOverflow();
        }}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
};

export const NoteModeDropdown: React.FC<NoteModeDropdownProps> = ({
  editorMode,
  onChangeMode,
  className = "",
}) => {
  const { t } = useI18n();
  const normalizedMode: "edit" | "source" | "preview" =
    editorMode === "live" ? "edit" : editorMode;
  const options = [
    {
      mode: "edit" as const,
      label: t("notes.toolbar.modeLive"),
      title: t("notes.toolbar.modeLiveTitle"),
      icon: PencilLine,
    },
    {
      mode: "source" as const,
      label: t("notes.toolbar.modeSource"),
      title: t("notes.toolbar.modeSourceTitle"),
      icon: SquareCode,
    },
    {
      mode: "preview" as const,
      label: t("notes.toolbar.modePreview"),
      title: t("notes.toolbar.modePreviewTitle"),
      icon: Eye,
    },
  ];
  const activeOption = options.find((option) => option.mode === normalizedMode) ?? options[0];
  const ActiveIcon = activeOption.icon;

  return (
    <Select value={normalizedMode} onValueChange={(mode) => onChangeMode(mode as NoteEditorMode)}>
        <SelectTrigger
          data-note-mode-dropdown-trigger
          aria-label={activeOption.title}
          className={cn(
            "app-no-drag h-8 w-auto shrink-0 gap-1.5 border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-secondary/70 hover:text-foreground focus:ring-0",
            className,
          )}
        >
          <ActiveIcon size={15} />
          <span>{activeOption.label}</span>
        </SelectTrigger>
      <SelectContent align="end" className="w-max min-w-[10rem]">
        {options.map((option) => {
          const Icon = option.icon;
          return (
            <SelectItem
              key={option.mode}
              value={option.mode}
              data-note-mode-option={option.mode}
              className="h-9 whitespace-nowrap"
            >
              <span className="flex items-center gap-2 whitespace-nowrap"><Icon size={14} />{option.label}</span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
};

export const NoteToolbar: React.FC<NoteToolbarProps> = ({
  editorMode,
  onAction,
  className = "",
  noteFontFamily = "",
  onChangeNoteFontFamily,
  noteFontSize = 14,
  onChangeNoteFontSize,
  noteCodeFontSize = 13,
  onChangeNoteCodeFontSize,
  activeFormats = EMPTY_ACTIVE_FORMATS,
}) => {
  const { t } = useI18n();
  const [fontSearch, setFontSearch] = useState("");

  // The font tool only controls code block / inline code fonts, so it lists
  // system monospace fonts (fontStore) rather than the UI font set.
  const availableSystemFonts = useAvailableFonts();

  const systemFontList = useMemo(() => {
    const defaultOption = { label: t("notes.toolbar.defaultFont"), value: "" };
    const list = availableSystemFonts.map((f) => ({
      label: f.name,
      value: f.family,
    }));
    return [defaultOption, ...list];
  }, [availableSystemFonts, t]);

  const filteredFonts = useMemo(() => {
    if (!fontSearch.trim()) return systemFontList;
    const query = fontSearch.trim().toLowerCase();
    return systemFontList.filter(
      (f) => f.label.toLowerCase().includes(query) || f.value.toLowerCase().includes(query),
    );
  }, [fontSearch, systemFontList]);

  const isEditing = editorMode === "edit" || editorMode === "live" || editorMode === "source";

  const formatRowRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(Infinity);

  useLayoutEffect(() => {
    const row = formatRowRef.current;
    if (!row) return;
    setAvailableWidth(row.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setAvailableWidth(entry.contentRect.width);
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [isEditing]);

  if (!isEditing) return null;

  let inlineCount = FORMAT_ITEMS.length;
  if (formatRowWidth(inlineCount) > availableWidth) {
    // Reserve a button and gap for the overflow trigger, then spill from the end.
    while (inlineCount > 0 && formatRowWidth(inlineCount) + 28 > availableWidth) {
      inlineCount -= 1;
    }
  }

  const renderItem = (item: (typeof FORMAT_ITEMS)[number], collapsed = false) => {
    const Icon = item.icon;
    const label = t(`notes.toolbar.${item.label}`);
    if (item.id === "typography") {
      return (
        <NoteToolbarPopover
          key={item.id}
          label={label}
          icon={<Icon size={14} />}
          collapsed={collapsed}
          contentClassName="w-64 p-2.5 space-y-2.5 text-xs shadow-lg"
        >
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
              <span>{t("notes.toolbar.customCodeFont")}</span>
              <span className="text-[10px] opacity-70">
                {t("notes.toolbar.fontsAvailable", { count: systemFontList.length })}
              </span>
            </div>

            {/* Search Bar */}
            <div className="relative flex items-center">
              <Search size={12} className="absolute left-2 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                placeholder={t("notes.toolbar.searchFont")}
                value={fontSearch}
                onChange={(e) => setFontSearch(e.target.value)}
                className="w-full pl-6 pr-2 py-1 rounded border border-border bg-background text-[11px] text-foreground outline-none focus:border-primary placeholder:text-muted-foreground/60"
              />
            </div>

            {/* Scrollable Font List */}
            <div className="space-y-0.5 max-h-52 overflow-y-auto pr-1">
              {filteredFonts.length === 0 ? (
                <div className="py-2 text-center text-muted-foreground text-[11px]">
                  {t("notes.toolbar.noFontsFound")}
                </div>
              ) : (
                filteredFonts.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    style={{ fontFamily: f.value || undefined }}
                    className={cn(
                      "w-full px-2 py-1 rounded text-left text-xs transition-colors flex items-center justify-between gap-1.5",
                      (noteFontFamily || "") === f.value
                        ? "bg-primary text-primary-foreground font-medium"
                        : "hover:bg-secondary text-foreground",
                    )}
                    onClick={() => onChangeNoteFontFamily?.(f.value)}
                  >
                    <span className="truncate">{f.label}</span>
                    {(noteFontFamily || "") === f.value && <Check size={12} className="shrink-0" />}
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="border-t border-border/60 pt-2">
            <div className="text-[11px] font-medium text-muted-foreground mb-1">{t("notes.toolbar.bodyFontSize")}</div>
            <div className="flex flex-wrap gap-1">
              {FONT_SIZES.map((sz) => (
                <button
                  key={sz}
                  type="button"
                  className={cn(
                    "px-2 py-0.5 rounded text-xs border transition-colors",
                    (noteFontSize || 14) === sz
                      ? "bg-primary text-primary-foreground border-primary font-medium"
                      : "border-border hover:bg-secondary text-foreground",
                  )}
                  onClick={() => onChangeNoteFontSize?.(sz)}
                >
                  {sz}px
                </button>
              ))}
            </div>
          </div>

          <div className="border-t border-border/60 pt-2">
            <div className="text-[11px] font-medium text-muted-foreground mb-1">{t("notes.toolbar.codeFontSize")}</div>
            <div className="flex flex-wrap gap-1">
              {CODE_FONT_SIZES.map((sz) => (
                <button
                  key={sz}
                  type="button"
                  className={cn(
                    "px-2 py-0.5 rounded text-xs border transition-colors font-mono",
                    (noteCodeFontSize || 13) === sz
                      ? "bg-primary text-primary-foreground border-primary font-medium"
                      : "border-border hover:bg-secondary text-foreground",
                  )}
                  onClick={() => onChangeNoteCodeFontSize?.(sz)}
                >
                  {sz}px
                </button>
              ))}
            </div>
          </div>
        </NoteToolbarPopover>
      );
    }
    if (item.id === "heading") {
      return (
        <NoteToolbarPopover
          key={item.id}
          label={label}
          icon={<Icon size={14} />}
          collapsed={collapsed}
          contentClassName="w-32 py-1 text-xs"
        >
          <button
            type="button"
            className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-secondary text-foreground transition-colors text-left"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("h1")}
          >
            <Heading1 size={14} className="text-primary" />
            <span>{t("notes.toolbar.h1")}</span>
          </button>
          <button
            type="button"
            className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-secondary text-foreground transition-colors text-left"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("h2")}
          >
            <Heading2 size={14} className="text-primary" />
            <span>{t("notes.toolbar.h2")}</span>
          </button>
          <button
            type="button"
            className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-secondary text-foreground transition-colors text-left"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("h3")}
          >
            <Heading3 size={14} className="text-primary" />
            <span>{t("notes.toolbar.h3")}</span>
          </button>
          <button
            type="button"
            className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-secondary text-foreground transition-colors text-left"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("h4")}
          >
            <Heading4 size={14} className="text-primary" />
            <span>{t("notes.toolbar.h4")}</span>
          </button>
        </NoteToolbarPopover>
      );
    }
    const active = "format" in item && activeFormats[item.format];
    const actionButton = (
      <button
        key={collapsed ? item.id : undefined}
        type="button"
        className={cn(
          collapsed ? overflowItemClass : toolbarButtonClass,
          active && "bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary",
        )}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onAction?.(item.id)}
        aria-label={label}
      >
        <Icon size={14} />
        {collapsed && <span>{label}</span>}
      </button>
    );
    if (collapsed) return actionButton;
    return (
      <Tooltip key={item.id}>
        <TooltipTrigger asChild>{actionButton}</TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    <div
      className={`flex items-center gap-1.5 px-3 py-1.5 border-b border-border/70 bg-card/40 text-xs select-none min-w-0 ${className}`}
    >
      <div
        ref={formatRowRef}
        data-note-format-toolbar
        className="flex flex-1 items-center gap-[2px] min-w-0 overflow-hidden"
      >
        {FORMAT_ITEMS.slice(0, inlineCount).map((item) => (
          <React.Fragment key={item.id}>
            {"separator" in item && <div className="h-4 w-px bg-border mx-[4px] shrink-0" />}
            {renderItem(item)}
          </React.Fragment>
        ))}
        <ToolbarOverflowMenu
          hasItems={inlineCount < FORMAT_ITEMS.length}
          label={t("terminal.toolbar.more")}
          orientation="vertical"
          buttonClassName={toolbarButtonClass}
          contentClassName="max-h-[min(32rem,var(--radix-popover-content-available-height))] overflow-y-auto"
          align="start"
        >
          <div className="flex min-w-[140px] flex-col">
            {FORMAT_ITEMS.slice(inlineCount).map((item) => renderItem(item, true))}
          </div>
        </ToolbarOverflowMenu>
      </div>
    </div>
  );
};
