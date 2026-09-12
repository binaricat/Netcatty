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
import React, { useMemo, useState } from "react";
import { type MarkdownActionType } from "../../domain/notes";
import { useAvailableFonts } from "../../application/state/fontStore";
import { useI18n } from "../../application/i18n/I18nProvider";
import type { ActiveTextFormats, NoteEditorMode } from "./noteEditorTypes";
import { EMPTY_ACTIVE_FORMATS } from "./noteEditorTypes";
import { Dropdown, DropdownContent, DropdownTrigger } from "../ui/dropdown";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select";
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

  if (!isEditing) return null;

  // Highlight style for toggles that are active at the current selection.
  const formatButtonClass = (active: boolean) =>
    cn(
      "p-1.5 rounded-md transition-colors",
      active
        ? "bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary"
        : "hover:bg-muted text-muted-foreground hover:text-foreground",
    );

  return (
    <div
      className={`flex items-center gap-1.5 px-3 py-1.5 border-b border-border/70 bg-card/40 text-xs select-none min-w-0 ${className}`}
    >
      {/* Formatting Tools (Available in Live Preview & Source Mode) */}
      <div className="flex flex-1 items-center gap-0.5 min-w-0 overflow-x-auto [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/70 [&::-webkit-scrollbar-track]:bg-transparent">

          {/* Undo / Redo */}
          <button
            type="button"
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("undo")}
            title={t("notes.toolbar.undo")}
          >
            <Undo2 size={14} />
          </button>

          <button
            type="button"
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("redo")}
            title={t("notes.toolbar.redo")}
          >
            <Redo2 size={14} />
          </button>

          <div className="h-4 w-px bg-border mx-1 shrink-0" />

          {/* Code Font & Typography Settings Dropdown */}
          <Dropdown>
            <DropdownTrigger asChild>
              <button
                type="button"
                className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
                title={t("notes.toolbar.typography")}
                onMouseDown={(e) => e.preventDefault()}
              >
                <Type size={14} />
              </button>
            </DropdownTrigger>
            <DropdownContent align="start" className="w-64 p-2.5 space-y-2.5 z-50 text-xs shadow-lg">
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
            </DropdownContent>
          </Dropdown>

          {/* Heading Dropdown (Using Portal Dropdown to avoid clipping) */}
          <Dropdown>
            <DropdownTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1 p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                onMouseDown={(e) => e.preventDefault()}
                title={t("notes.toolbar.headingLevel")}
              >
                <Heading size={14} />
              </button>
            </DropdownTrigger>
            <DropdownContent align="start" className="w-32 py-1 z-50 text-xs">
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
            </DropdownContent>
          </Dropdown>

          {/* Inline Styles */}
          <button
            type="button"
            className={formatButtonClass(activeFormats.bold)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("bold")}
            title={t("notes.toolbar.bold")}
          >
            <Bold size={14} />
          </button>

          <button
            type="button"
            className={formatButtonClass(activeFormats.italic)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("italic")}
            title={t("notes.toolbar.italic")}
          >
            <Italic size={14} />
          </button>

          <button
            type="button"
            className={formatButtonClass(activeFormats.strikethrough)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("strikethrough")}
            title={t("notes.toolbar.strikethrough")}
          >
            <Strikethrough size={14} />
          </button>

          <button
            type="button"
            className={formatButtonClass(activeFormats.underline)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("underline")}
            title={t("notes.toolbar.underline")}
          >
            <Underline size={14} />
          </button>

          <button
            type="button"
            className={formatButtonClass(activeFormats.code)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("code")}
            title={t("notes.toolbar.inlineCode")}
          >
            <Code size={14} />
          </button>

          <div className="h-4 w-px bg-border mx-1 shrink-0" />

          {/* Lists */}
          <button
            type="button"
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("bullet")}
            title={t("notes.toolbar.bulletList")}
          >
            <List size={14} />
          </button>

          <button
            type="button"
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("number")}
            title={t("notes.toolbar.orderedList")}
          >
            <ListOrdered size={14} />
          </button>

          <button
            type="button"
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("task")}
            title={t("notes.toolbar.taskList")}
          >
            <CheckSquare size={14} />
          </button>

          <div className="h-4 w-px bg-border mx-1 shrink-0" />

          {/* Blocks */}
          <button
            type="button"
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("quote")}
            title={t("notes.toolbar.quote")}
          >
            <Quote size={14} />
          </button>

          <button
            type="button"
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("codeblock")}
            title={t("notes.toolbar.codeBlock")}
          >
            <FileCode size={14} />
          </button>

          <button
            type="button"
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("math")}
            title={t("notes.toolbar.mathFormula")}
          >
            <Sigma size={14} />
          </button>

          <button
            type="button"
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("table")}
            title={t("notes.toolbar.table")}
          >
            <TableIcon size={14} />
          </button>

          <button
            type="button"
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("divider")}
            title={t("notes.toolbar.divider")}
          >
            <Minus size={14} />
          </button>

          <button
            type="button"
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("link")}
            title={t("notes.toolbar.link")}
          >
            <LinkIcon size={14} />
          </button>

          <button
            type="button"
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction?.("image")}
            title={t("notes.toolbar.image")}
          >
            <ImageIcon size={14} />
          </button>
      </div>
    </div>
  );
};
