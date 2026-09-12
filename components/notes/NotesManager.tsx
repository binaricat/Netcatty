import {
  ArrowLeft,
  Download,
  Edit2,
  Expand,
  FileText,
  Folder,
  FolderPlus,
  Hash,
  ListTree,
  MoreHorizontal,
  Minimize2,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import React, { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { useApplicationBackend } from "../../application/state/useApplicationBackend";
import { useStoredNumber } from "../../application/state/useStoredNumber";
import { useStoredString } from "../../application/state/useStoredString";
import { useAvailableFonts } from "../../application/state/fontStore";
import { resolveNoteFontFamily } from "../../domain/noteFonts";
import { NoteOutline } from "./NoteOutline";
import { NoteExportMenu } from "./NoteExportMenu";
import { NoteModeDropdown, NoteToolbar } from "./NoteToolbar";
import type { NoteSourceEditorHandle } from "./NoteSourceEditor";
import {
  ancestorNoteGroupPaths,
  buildVaultNoteMarkdownExportFiles,
  cleanNoteGroupPath,
  getNoteGroupParentPath,
  isNoteGroupInside,
  joinNoteGroupPath,
  matchesVaultNoteSearch,
  importMarkdownPayloadsToVaultNotes,
  normalizeNoteGroups,
  normalizeVaultNotes,
  remapExpandedNoteGroupPaths,
  replaceNoteGroupPrefix,
  resolveMovedNoteGroupPath,
  sanitizeNoteExportFileNamePart,
  type MarkdownActionType,
  type NoteHeadingItem,
  type VaultNotesExportScope,
} from "../../domain/notes";
import { getNextVaultOrder, reorderVaultItems, reorderVaultStrings, sortByVaultOrder } from "../../domain/vaultOrder";
import {
  STORAGE_KEY_VAULT_NOTES_EDITOR_MODE,
  STORAGE_KEY_VAULT_NOTES_FONT_FAMILY,
  STORAGE_KEY_VAULT_NOTES_FONT_SIZE,
  STORAGE_KEY_VAULT_NOTES_CODE_FONT_SIZE,
  STORAGE_KEY_VAULT_NOTES_TREE_WIDTH,
} from "../../infrastructure/config/storageKeys";
import { logger } from "../../lib/logger";
import { cn } from "../../lib/utils";
import { TERMINAL_SIDE_PANEL_INNER_HEADER_CLASS } from "../terminalLayer/terminalSidePanelChrome";
import { readTextFile } from "../../lib/readTextFile";
import { buildTextFilesZipBlob } from "../../lib/textZip";
import type { Host, VaultNote } from "../../types";
import { Button } from "../ui/button";
import { LazyLoadBoundary } from "../ui/lazy-load-boundary";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { Dropdown, DropdownContent, DropdownTrigger } from "../ui/dropdown";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { toast } from "../ui/toast";
import {
  VaultTreeGroupRow,
  VaultTreeInlineRenameInput,
  VaultTreeItemRow,
} from "../vault/VaultTreeRow";
import { VaultDeleteConfirmDialog } from "../vault/VaultDeleteConfirmDialog";
import {
  clearVaultDropIndicator,
  getVaultDropIntent,
  getVaultDropPosition,
  type VaultDropPosition,
  hasVaultDragType,
  markVaultDropIndicator,
  markVaultInsideDropIndicator,
} from "../vault/vaultReorderDrag";
import type {
  ActiveTextFormats,
  InlineMarkdownEditorHandle,
  NoteEditorMode,
} from "./noteEditorTypes";
import { EMPTY_ACTIVE_FORMATS } from "./noteEditorTypes";
import { NoteTitleInput } from "./NoteTitleInput";

const InlineMarkdownEditor = lazy(() =>
  import("./InlineMarkdownEditor.lazy").then((module) => ({ default: module.InlineMarkdownEditor })),
);

/** Warm the MDXEditor chunk before Suspense. */
export function prefetchInlineMarkdownEditor(): void {
  void import("./InlineMarkdownEditor.lazy");
}

interface NoteFolderNode {
  name: string;
  path: string;
  children: NoteFolderNode[];
  notes: VaultNote[];
}

type NotesToolbarPanel = "search" | null;

const toolbarIconButtonClass = "netcatty-tab h-6 w-6 shrink-0 rounded-md p-0 hover:bg-transparent";
const menuItemClass = "flex h-8 w-full items-center rounded-md px-3 text-left text-sm hover:bg-secondary";
const noteMetadataPillClass = "inline-flex h-5 items-center gap-1 rounded-md bg-muted/70 px-2 text-[11px] font-medium leading-none";
const noteMetadataLabelClass = "translate-y-px";
const NOTES_TREE_DEFAULT_WIDTH = 300;
/** Narrow enough for nested folders + ellipsis; toolbar scrolls if needed. */
const NOTES_TREE_MIN_WIDTH = 160;
const NOTES_TREE_MAX_WIDTH = 520;
const NOTE_DRAG_TYPE = "application/x-netcatty-note-id";
const NOTE_GROUP_DRAG_TYPE = "application/x-netcatty-note-group-path";

export function clampNotesTreeWidth(value: number): number {
  return Math.max(NOTES_TREE_MIN_WIDTH, Math.min(NOTES_TREE_MAX_WIDTH, value));
}

export const normalizeNoteEditorMode = (value: string | null): NoteEditorMode | null =>
  value === "live"
    ? "edit"
    : value === "edit" || value === "preview" || value === "source"
      ? value
      : null;

export const isNoteEditorMode = (value: string | null): value is NoteEditorMode =>
  value === "edit" || value === "preview" || value === "source";

const InlineMarkdownEditorFallback = () => (
  <div
    className="min-h-[420px] bg-background"
    data-notes-editor-loading="true"
    aria-hidden="true"
  />
);

export interface NotesManagerProps {
  notes: VaultNote[];
  noteGroups: string[];
  hosts: Host[];
  onUpdateNotes: (notes: VaultNote[]) => void;
  onUpdateNoteGroups: (groups: string[]) => void;
  onOpenHost?: (host: Host, source?: { noteId: string }) => void;
  displayMode?: "full" | "sidebar";
  /** When false (hidden retained mount), flush any pending draft immediately. */
  isActive?: boolean;
  openNoteId?: string | null;
  openNoteRequestId?: number | null;
  /** Called after a one-shot openNoteId focus request has been applied. */
  onOpenNoteIdHandled?: () => void;
}

type HoverActionMenuProps = {
  children: React.ReactNode | ((closeMenu: () => void) => React.ReactNode);
  className?: string;
};

const HoverActionMenu: React.FC<HoverActionMenuProps> = ({ children, className }) => {
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 140);
  };

  useEffect(() => () => cancelClose(), []);

  const closeMenu = () => {
    cancelClose();
    setOpen(false);
  };

  return (
    <Dropdown open={open} onOpenChange={setOpen}>
      <DropdownTrigger asChild toggleOnClick={false}>
        <button
          type="button"
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-secondary/80 hover:text-foreground group-hover:opacity-100 data-[open=true]:opacity-100",
            className,
          )}
          data-open={open ? "true" : "false"}
          onMouseEnter={() => {
            cancelClose();
            setOpen(true);
          }}
          onMouseLeave={scheduleClose}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            cancelClose();
            setOpen(true);
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </DropdownTrigger>
      <DropdownContent
        align="end"
        className="min-w-[148px]"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
      >
        {typeof children === "function" ? children(closeMenu) : children}
      </DropdownContent>
    </Dropdown>
  );
};

const createNote = (group: string | null, order: number): VaultNote => {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "",
    content: "",
    group: group || undefined,
    createdAt: now,
    updatedAt: now,
    order,
  };
};

const sortNoteItems = (items: VaultNote[]): VaultNote[] => sortByVaultOrder(items);

const sortFolderNodes = (
  items: NoteFolderNode[],
  groupOrderByPath: ReadonlyMap<string, number>,
): NoteFolderNode[] =>
  [...items]
    .sort((a, b) => {
      const orderA = groupOrderByPath.get(a.path);
      const orderB = groupOrderByPath.get(b.path);
      if (typeof orderA === "number" && typeof orderB === "number" && orderA !== orderB) {
        return orderA - orderB;
      }
      if (typeof orderA === "number") return -1;
      if (typeof orderB === "number") return 1;
      return a.name.localeCompare(b.name);
    })
    .map((node) => ({
      ...node,
      children: sortFolderNodes(node.children, groupOrderByPath),
      notes: sortNoteItems(node.notes),
    }));

const buildNoteTree = (groups: string[], notes: VaultNote[]): { children: NoteFolderNode[]; rootNotes: VaultNote[] } => {
  const nodes = new Map<string, NoteFolderNode>();
  const ensureNode = (path: string): NoteFolderNode => {
    const cleanPath = cleanNoteGroupPath(path);
    const existing = nodes.get(cleanPath);
    if (existing) return existing;

    const name = cleanPath.split("/").pop() || cleanPath;
    const node: NoteFolderNode = { name, path: cleanPath, children: [], notes: [] };
    nodes.set(cleanPath, node);

    const parentPath = cleanPath.split("/").slice(0, -1).join("/");
    if (parentPath) {
      ensureNode(parentPath).children.push(node);
    }
    return node;
  };

  const allGroups = normalizeNoteGroups([
    ...groups,
    ...notes.map((note) => note.group).filter((group): group is string => Boolean(group)),
  ]);
  allGroups.flatMap(ancestorNoteGroupPaths).forEach(ensureNode);

  const rootNotes: VaultNote[] = [];
  notes.forEach((note) => {
    const group = note.group ? cleanNoteGroupPath(note.group) : "";
    if (!group) {
      rootNotes.push(note);
      return;
    }
    ensureNode(group).notes.push(note);
  });

  return {
    children: Array.from(nodes.values()).filter((node) => !node.path.includes("/")),
    rootNotes,
  };
};

export const getSelectedVaultNote = (notes: VaultNote[], selectedNoteId: string | null): VaultNote | null =>
  selectedNoteId ? notes.find((note) => note.id === selectedNoteId) ?? null : null;

export const isNoteFolderTreeSelected = (
  selectedGroup: string | null,
  selectedNoteId: string | null,
  groupPath: string,
): boolean => selectedNoteId === null && selectedGroup === groupPath;

export const getNoteActionTargetGroup = (
  selectedNote: VaultNote | null,
  selectedGroup: string | null,
): string | null => selectedNote?.group || selectedGroup || null;

export const getNoteSelectionState = (
  note: VaultNote,
  isSidebarMode: boolean,
): { selectedNoteId: string; selectedGroup: null; overlayNoteId: string | null } => ({
  selectedNoteId: note.id,
  selectedGroup: null,
  overlayNoteId: isSidebarMode ? note.id : null,
});

export const getNoteGroupSelectionState = (
  groupPath: string,
): { selectedNoteId: null; selectedGroup: string; overlayNoteId: null } => ({
  selectedNoteId: null,
  selectedGroup: groupPath,
  overlayNoteId: null,
});

export const getFallbackNoteSelectionState = (
  remainingNotes: VaultNote[],
  isSidebarMode: boolean,
): { selectedNoteId: string | null; selectedGroup: null; overlayNoteId: null } => ({
  selectedNoteId: isSidebarMode ? null : remainingNotes[0]?.id ?? null,
  selectedGroup: null,
  overlayNoteId: null,
});

export const getValidatedNoteSelectionState = (
  notes: VaultNote[],
  selectedNoteId: string | null,
  selectedGroup: string | null,
  isSidebarMode: boolean,
): { selectedNoteId: string | null; selectedGroup: null; overlayNoteId: null } | null => {
  if (selectedNoteId && notes.some((note) => note.id === selectedNoteId)) return null;
  if (selectedNoteId || (!isSidebarMode && !selectedGroup && notes.length > 0)) {
    return getFallbackNoteSelectionState(notes, isSidebarMode);
  }
  return null;
};

export const getNotesGroupDropAction = (
  sourceGroup: string | null,
  targetGroup: string,
  intent: VaultDropPosition | "inside",
): "ignore" | "inside" | "reorder" => {
  if (!sourceGroup || sourceGroup === targetGroup || targetGroup.startsWith(`${sourceGroup}/`)) {
    return "ignore";
  }
  return intent === "inside" ? "inside" : "reorder";
};

export const NotesManager: React.FC<NotesManagerProps> = ({
  notes,
  noteGroups,
  hosts,
  onUpdateNotes,
  onUpdateNoteGroups,
  onOpenHost,
  displayMode = "full",
  isActive = true,
  openNoteId = null,
  openNoteRequestId = null,
  onOpenNoteIdHandled,
}) => {
  const { t } = useI18n();
  const { openExternal } = useApplicationBackend();
  const isSidebarMode = displayMode === "sidebar";
  const initialOpenNoteId = openNoteId && notes.some((note) => note.id === openNoteId)
    ? openNoteId
    : null;
  const [query, setQuery] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(() => initialOpenNoteId ?? (isSidebarMode ? null : notes[0]?.id ?? null));
  const [noteEditorMode, setNoteEditorMode] = useStoredString<NoteEditorMode>(
    STORAGE_KEY_VAULT_NOTES_EDITOR_MODE,
    "edit",
    isNoteEditorMode,
  );
  const [activeFormats, setActiveFormats] = useState<ActiveTextFormats>(EMPTY_ACTIVE_FORMATS);
  const [overlayNoteId, setOverlayNoteId] = useState<string | null>(() => initialOpenNoteId);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(notes.flatMap((note) => note.group ? ancestorNoteGroupPaths(note.group) : [])),
  );
  const [expandedPanel, setExpandedPanel] = useState<NotesToolbarPanel>(null);
  const [creatingGroupParent, setCreatingGroupParent] = useState<string | null | undefined>(undefined);
  const [editingGroupPath, setEditingGroupPath] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [isTreeResizing, setIsTreeResizing] = useState(false);
  const [draggingNoteId, setDraggingNoteId] = useState<string | null>(null);
  const [draggingGroupPath, setDraggingGroupPath] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    type: "note" | "group";
    id: string;
    name: string;
  } | null>(null);
  const [showOutline, setShowOutline] = useState(false);
  const [tagInputOpen, setTagInputOpen] = useState(false);
  const [newTagText, setNewTagText] = useState("");
  const [treeWidth, setTreeWidth, persistTreeWidth] = useStoredNumber(
    STORAGE_KEY_VAULT_NOTES_TREE_WIDTH,
    NOTES_TREE_DEFAULT_WIDTH,
    { min: NOTES_TREE_MIN_WIDTH, max: NOTES_TREE_MAX_WIDTH },
  );
  const [noteFontFamily, setNoteFontFamily] = useStoredString<string>(
    STORAGE_KEY_VAULT_NOTES_FONT_FAMILY,
    "",
  );
  const availableNoteFonts = useAvailableFonts();
  const resolvedNoteFontFamily = useMemo(
    () => resolveNoteFontFamily(availableNoteFonts, noteFontFamily),
    [availableNoteFonts, noteFontFamily],
  );
  const [noteFontSize, setNoteFontSize, persistNoteFontSize] = useStoredNumber(
    STORAGE_KEY_VAULT_NOTES_FONT_SIZE,
    14,
    { min: 10, max: 32 },
  );
  const handleSetNoteFontSize = useCallback((size: number) => {
    setNoteFontSize(size);
    persistNoteFontSize(size);
  }, [persistNoteFontSize, setNoteFontSize]);
  const [noteCodeFontSize, setNoteCodeFontSize, persistNoteCodeFontSize] = useStoredNumber(
    STORAGE_KEY_VAULT_NOTES_CODE_FONT_SIZE,
    13,
    { min: 10, max: 32 },
  );
  const handleSetNoteCodeFontSize = useCallback((size: number) => {
    setNoteCodeFontSize(size);
    persistNoteCodeFontSize(size);
  }, [persistNoteCodeFontSize, setNoteCodeFontSize]);
  const treeAsideRef = useRef<HTMLElement | null>(null);
  const treeWidthRef = useRef(treeWidth);
  treeWidthRef.current = treeWidth;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);
  const isImportingMarkdownRef = useRef(false);
  const importTargetGroupRef = useRef<string | null | undefined>(undefined);
  const sortedNotesRef = useRef<VaultNote[]>([]);
  const activeDownloadUrlsRef = useRef<Set<string>>(new Set());

  const groups = useMemo(() => normalizeNoteGroups(noteGroups), [noteGroups]);
  const groupOrderByPath = useMemo(
    () => new Map(groups.map((group, index) => [group, index])),
    [groups],
  );
  const sortedNotes = useMemo(() => sortNoteItems(normalizeVaultNotes(notes)), [notes]);
  sortedNotesRef.current = sortedNotes;

  const commitNotes = useCallback((nextNotes: VaultNote[]) => {
    const cleaned = normalizeVaultNotes(nextNotes);
    sortedNotesRef.current = cleaned;
    onUpdateNotes(cleaned);
    return cleaned;
  }, [onUpdateNotes]);

  const addTagToNote = useCallback((noteId: string, tag: string) => {
    const clean = tag.trim();
    if (!clean) return;
    commitNotes(sortedNotesRef.current.map((n) => {
      if (n.id !== noteId) return n;
      const existing = n.tags ?? [];
      if (existing.includes(clean)) return n;
      return { ...n, tags: [...existing, clean], updatedAt: Date.now() };
    }));
  }, [commitNotes]);

  const removeTagFromNote = useCallback((noteId: string, tagToRemove: string) => {
    commitNotes(sortedNotesRef.current.map((n) => {
      if (n.id !== noteId) return n;
      const existing = n.tags ?? [];
      const nextTags = existing.filter((t) => t !== tagToRemove);
      return { ...n, tags: nextTags.length ? nextTags : undefined, updatedAt: Date.now() };
    }));
  }, [commitNotes]);

  const NOTE_DRAFT_DEBOUNCE_MS = 300;
  const draftNoteIdRef = useRef<string | null>(null);
  const draftTitleRef = useRef<string | null>(null);
  const draftContentRef = useRef<string | null>(null);
  const draftTimerRef = useRef<number | null>(null);
  const [draftNoteId, setDraftNoteId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState<string | null>(null);

  const clearDraftTimer = useCallback(() => {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
  }, []);

  const flushNoteDraft = useCallback(() => {
    clearDraftTimer();
    const noteId = draftNoteIdRef.current;
    if (!noteId) return;
    const title = draftTitleRef.current;
    const content = draftContentRef.current;
    draftNoteIdRef.current = null;
    draftTitleRef.current = null;
    draftContentRef.current = null;
    setDraftNoteId(null);
    setDraftTitle(null);
    if (title === null && content === null) return;
    commitNotes(sortedNotesRef.current.map((note) => {
      if (note.id !== noteId) return note;
      return {
        ...note,
        ...(title !== null ? { title } : {}),
        ...(content !== null ? { content } : {}),
        updatedAt: Date.now(),
      };
    }));
  }, [clearDraftTimer, commitNotes]);

  const scheduleNoteDraftFlush = useCallback(() => {
    clearDraftTimer();
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null;
      flushNoteDraft();
    }, NOTE_DRAFT_DEBOUNCE_MS);
  }, [clearDraftTimer, flushNoteDraft]);

  const updateNoteDraft = useCallback((noteId: string, fields: { title?: string; content?: string }) => {
    if (draftNoteIdRef.current && draftNoteIdRef.current !== noteId) {
      flushNoteDraft();
    }
    draftNoteIdRef.current = noteId;
    if (fields.title !== undefined) {
      draftTitleRef.current = fields.title;
      setDraftNoteId(noteId);
      setDraftTitle(fields.title);
    }
    if (fields.content !== undefined) {
      draftContentRef.current = fields.content;
    }
    scheduleNoteDraftFlush();
  }, [flushNoteDraft, scheduleNoteDraftFlush]);

  const flushNoteDraftRef = useRef(flushNoteDraft);
  flushNoteDraftRef.current = flushNoteDraft;

  useEffect(() => () => {
    flushNoteDraftRef.current();
  }, []);

  useLayoutEffect(() => {
    if (isActive) return;
    flushNoteDraft();
  }, [flushNoteDraft, isActive]);

  useEffect(() => {
    if (!isActive) return;
    prefetchInlineMarkdownEditor();
  }, [isActive]);

  useEffect(() => {
    const flushOnTeardown = () => {
      flushNoteDraft();
    };
    const flushOnHidden = () => {
      if (document.visibilityState === "hidden") flushNoteDraft();
    };
    window.addEventListener("pagehide", flushOnTeardown);
    window.addEventListener("beforeunload", flushOnTeardown);
    document.addEventListener("visibilitychange", flushOnHidden);
    return () => {
      window.removeEventListener("pagehide", flushOnTeardown);
      window.removeEventListener("beforeunload", flushOnTeardown);
      document.removeEventListener("visibilitychange", flushOnHidden);
    };
  }, [flushNoteDraft]);

  const noteTree = useMemo(() => {
    const tree = buildNoteTree(groups, sortedNotes);
    return {
      children: sortFolderNodes(tree.children, groupOrderByPath),
      rootNotes: sortNoteItems(tree.rootNotes),
    };
  }, [groupOrderByPath, groups, sortedNotes]);
  const selectedNote = getSelectedVaultNote(sortedNotes, selectedNoteId);
  const overlayNote = sortedNotes.find((note) => note.id === overlayNoteId) ?? null;
  const selectedNoteView = useMemo(() => {
    if (!selectedNote) return null;
    if (draftNoteId === selectedNote.id && draftTitle !== null) {
      return { ...selectedNote, title: draftTitle };
    }
    return selectedNote;
  }, [draftNoteId, draftTitle, selectedNote]);

  const overlayNoteView = useMemo(() => {
    if (!overlayNote) return null;
    if (draftNoteId === overlayNote.id && draftTitle !== null) {
      return { ...overlayNote, title: draftTitle };
    }
    return overlayNote;
  }, [draftNoteId, draftTitle, overlayNote]);

  useEffect(() => {
    if (!draftNoteIdRef.current) return;
    if (draftNoteIdRef.current === selectedNoteId || draftNoteIdRef.current === overlayNoteId) return;
    flushNoteDraft();
  }, [flushNoteDraft, overlayNoteId, selectedNoteId]);

  useEffect(() => {
    const urls = activeDownloadUrlsRef.current;
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, []);

  const queryText = query.trim();
  const queryLower = queryText.toLowerCase();
  const noteMatches = (note: VaultNote) => matchesVaultNoteSearch(note, queryText, hosts);
  const groupMatches = (node: NoteFolderNode) =>
    !queryLower || node.name.toLowerCase().includes(queryLower) || node.path.toLowerCase().includes(queryLower);

  useEffect(() => {
    const nextSelection = getValidatedNoteSelectionState(sortedNotes, selectedNoteId, selectedGroup, isSidebarMode);
    if (!nextSelection) return;
    setSelectedNoteId(nextSelection.selectedNoteId);
    setSelectedGroup(nextSelection.selectedGroup);
    setOverlayNoteId(nextSelection.overlayNoteId);
  }, [isSidebarMode, selectedGroup, selectedNoteId, sortedNotes]);

  useEffect(() => {
    if (!overlayNoteId || sortedNotes.some((note) => note.id === overlayNoteId)) return;
    setOverlayNoteId(null);
  }, [overlayNoteId, sortedNotes]);

  useEffect(() => {
    if (!selectedNote?.group) return;
    setExpandedGroups((current) => new Set([...current, ...ancestorNoteGroupPaths(selectedNote.group || "")]));
  }, [selectedNote?.group]);

  useEffect(() => {
    if (!openNoteId) return;
    const note = sortedNotes.find((item) => item.id === openNoteId);
    if (!note) return;
    const nextSelection = getNoteSelectionState(note, isSidebarMode);
    setSelectedNoteId(nextSelection.selectedNoteId);
    setSelectedGroup(nextSelection.selectedGroup);
    setOverlayNoteId(nextSelection.overlayNoteId);
    if (note.group) {
      setExpandedGroups((current) => new Set([...current, ...ancestorNoteGroupPaths(note.group || "")]));
    }
    onOpenNoteIdHandled?.();
  }, [isSidebarMode, onOpenNoteIdHandled, openNoteId, openNoteRequestId, sortedNotes]);

  useEffect(() => {
    if (expandedPanel !== "search") return;
    const frame = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [expandedPanel]);

  const expandPath = (path: string) => {
    setExpandedGroups((current) => new Set([...current, ...ancestorNoteGroupPaths(path)]));
  };

  const toggleGroup = (path: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const allGroupPaths = useMemo(() => {
    const paths: string[] = [];
    const visit = (nodes: NoteFolderNode[]) => {
      nodes.forEach((node) => {
        paths.push(node.path);
        visit(node.children);
      });
    };
    visit(noteTree.children);
    return paths;
  }, [noteTree.children]);

  const expandAllGroups = () => setExpandedGroups(new Set(allGroupPaths));
  const collapseAllGroups = () => setExpandedGroups(new Set());

  /** Flush pending draft, then mutate from the post-flush ref snapshot. */
  const commitNotesAfterFlush = useCallback((mutator: (notes: VaultNote[]) => VaultNote[]) => {
    flushNoteDraft();
    return commitNotes(mutator(sortedNotesRef.current));
  }, [commitNotes, flushNoteDraft]);

  /** Rename from the tree row: merge title into the post-flush note so an
   *  unflushed body edit is not discarded by a stale tree-row snapshot. */
  const renameNoteFromTree = (noteId: string, title: string) => {
    const nextTitle = title.trim();
    const updatedAt = Date.now();
    commitNotesAfterFlush((notes) => notes.map((note) => (
      note.id === noteId ? { ...note, title: nextTitle, updatedAt } : note
    )));
  };

  const saveNoteTitleDraft = (note: VaultNote, title: string) => {
    updateNoteDraft(note.id, { title });
  };

  /** Ref-only title stash for IME composition — avoids controlled value rewrite. */
  const stashNoteTitleDraft = (note: VaultNote, title: string) => {
    if (draftNoteIdRef.current && draftNoteIdRef.current !== note.id) {
      flushNoteDraft();
    }
    // Cancel any idle-commit debounce so a prior ASCII commit cannot flush
    // mid-composition and rewrite the controlled title.
    clearDraftTimer();
    draftNoteIdRef.current = note.id;
    draftTitleRef.current = title;
  };

  const saveNoteContentDraft = useCallback((noteId: string, content: string) => {
    updateNoteDraft(noteId, { content });
  }, [updateNoteDraft]);

  const handleOpenHostFromNote = useCallback((host: Host, noteId: string) => {
    onOpenHost?.(host, { noteId });
  }, [onOpenHost]);

  const sourceEditorRef = useRef<NoteSourceEditorHandle>(null);
  const inlineEditorRef = useRef<InlineMarkdownEditorHandle>(null);
  const overlayEditorRef = useRef<InlineMarkdownEditorHandle>(null);

  const handleToolbarAction = useCallback((action: MarkdownActionType) => {
    if (isSidebarMode && overlayNoteView) {
      overlayEditorRef.current?.executeAction(action);
    } else {
      inlineEditorRef.current?.executeAction(action);
    }
  }, [isSidebarMode, overlayNoteView]);

  const handleOutlineHeadingSelect = useCallback((heading: NoteHeadingItem, index: number) => {
    inlineEditorRef.current?.scrollToHeading(heading, index);
  }, []);

  const addNoteToGroup = (group: string | null) => {
    let created: VaultNote | null = null;
    commitNotesAfterFlush((notes) => {
      created = createNote(group, getNextVaultOrder(notes));
      return [...notes, created];
    });
    if (!created) return;
    if (group) expandPath(group);
    const nextSelection = getNoteSelectionState(created, isSidebarMode);
    setSelectedNoteId(nextSelection.selectedNoteId);
    setSelectedGroup(nextSelection.selectedGroup);
    setOverlayNoteId(nextSelection.overlayNoteId);
  };

  const addNote = () => {
    addNoteToGroup(getNoteActionTargetGroup(selectedNote, selectedGroup));
  };

  const openImportMarkdownPicker = useCallback((targetGroupOverride?: string | null) => {
    importTargetGroupRef.current = targetGroupOverride;
    importFileInputRef.current?.click();
  }, []);

  const handleImportMarkdownFiles = useCallback(async (fileList: FileList | null) => {
    const resetImportInput = () => {
      if (importFileInputRef.current) {
        importFileInputRef.current.value = "";
      }
    };

    if (!fileList || fileList.length === 0) {
      resetImportInput();
      return;
    }
    if (isImportingMarkdownRef.current) {
      toast.info(t("notes.import.toast.inProgress"));
      resetImportInput();
      return;
    }

    const files = Array.from(fileList);
    const markdownFiles = files.filter((file) => /\.(md|markdown|txt)$/i.test(file.name));
    const skippedCount = files.length - markdownFiles.length;
    const pendingTargetGroup = importTargetGroupRef.current;
    importTargetGroupRef.current = undefined;
    const targetGroup = pendingTargetGroup !== undefined
      ? pendingTargetGroup
      : getNoteActionTargetGroup(selectedNote, selectedGroup);
    isImportingMarkdownRef.current = true;

    try {
      if (markdownFiles.length === 0) {
        toast.error(t("notes.import.toast.noNotes"));
        return;
      }

      const payloads = await Promise.all(
        markdownFiles.map(async (file) => ({
          fileName: file.name,
          content: await readTextFile(file),
        })),
      );

      const result = importMarkdownPayloadsToVaultNotes(
        payloads,
        (() => {
          flushNoteDraft();
          return sortedNotesRef.current;
        })(),
        targetGroup,
      );

      if (result.importedCount === 0) {
        toast.error(t("notes.import.toast.noNotes"));
        return;
      }

      const mergedNotes = commitNotes(result.notes);
      if (targetGroup) expandPath(targetGroup);

      const lastImported = mergedNotes[mergedNotes.length - 1];
      const nextSelection = getNoteSelectionState(lastImported, isSidebarMode);
      setSelectedNoteId(nextSelection.selectedNoteId);
      setSelectedGroup(nextSelection.selectedGroup);
      setOverlayNoteId(nextSelection.overlayNoteId);

      toast.success(t("notes.import.toast.success", { count: result.importedCount }));
      if (skippedCount > 0) {
        toast.info(t("notes.import.toast.skipped", { count: skippedCount }));
      }
    } catch (err) {
      logger.error("Failed to import markdown files:", err);
      toast.error(t("notes.import.toast.failed"));
    } finally {
      isImportingMarkdownRef.current = false;
      resetImportInput();
    }
  }, [
    isSidebarMode,
    commitNotes,
    flushNoteDraft,
    selectedGroup,
    selectedNote,
    t,
  ]);

  const downloadNotesBlob = useCallback((blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    activeDownloadUrlsRef.current.add(url);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    window.setTimeout(() => {
      URL.revokeObjectURL(url);
      activeDownloadUrlsRef.current.delete(url);
    }, 60_000);
  }, []);

  const exportNoteToMarkdown = useCallback((note: VaultNote) => {
    flushNoteDraft();
    const latest = sortedNotesRef.current.find((item) => item.id === note.id) ?? note;
    try {
      const fileName = `${sanitizeNoteExportFileNamePart(latest.title, "note")}.md`;
      downloadNotesBlob(
        new Blob([latest.content], { type: "text/markdown;charset=utf-8" }),
        fileName,
      );
      toast.success(t("notes.export.toast.success", { count: 1 }));
    } catch (err) {
      logger.error("Failed to export note:", err);
      toast.error(t("notes.export.toast.failed"));
    }
  }, [downloadNotesBlob, flushNoteDraft, t]);

  const exportNotesToZip = useCallback((scope: VaultNotesExportScope, fileNamePart: string) => {
    flushNoteDraft();
    try {
      const files = buildVaultNoteMarkdownExportFiles(sortedNotesRef.current, scope);
      if (files.length === 0) {
        toast.warning(t("notes.export.toast.empty"));
        return;
      }

      const blob = buildTextFilesZipBlob(files);
      const safeName = sanitizeNoteExportFileNamePart(fileNamePart, "notes");
      downloadNotesBlob(blob, `netcatty-notes-${safeName}.zip`);
      toast.success(t("notes.export.toast.success", { count: files.length }));
    } catch (err) {
      logger.error("Failed to export notes:", err);
      toast.error(t("notes.export.toast.failed"));
    }
  }, [downloadNotesBlob, flushNoteDraft, t]);

  const exportAllNotes = useCallback(() => {
    exportNotesToZip({ type: "all" }, "all");
  }, [exportNotesToZip]);

  const exportGroupNotes = useCallback((groupPath: string) => {
    exportNotesToZip({ type: "group", group: groupPath }, groupPath);
  }, [exportNotesToZip]);

  const duplicateNoteById = (noteId: string) => {
    flushNoteDraft();
    const source = sortedNotesRef.current.find((note) => note.id === noteId);
    if (!source) return;
    const now = Date.now();
    const copy: VaultNote = {
      ...source,
      id: crypto.randomUUID(),
      title: `${source.title} (${t("action.copy")})`,
      createdAt: now,
      updatedAt: now,
      order: getNextVaultOrder(sortedNotesRef.current),
    };
    commitNotes([...sortedNotesRef.current, copy]);
    if (copy.group) expandPath(copy.group);
    const nextSelection = getNoteSelectionState(copy, isSidebarMode);
    setSelectedNoteId(nextSelection.selectedNoteId);
    setSelectedGroup(nextSelection.selectedGroup);
    setOverlayNoteId(nextSelection.overlayNoteId);
  };

  const performDeleteNoteById = (noteId: string) => {
    const next = commitNotesAfterFlush((notes) => notes.filter((note) => note.id !== noteId));
    if (selectedNoteId === noteId) {
      const nextSelection = getFallbackNoteSelectionState(next, isSidebarMode);
      setSelectedNoteId(nextSelection.selectedNoteId);
      setSelectedGroup(nextSelection.selectedGroup);
      setOverlayNoteId(nextSelection.overlayNoteId);
      setEditingNoteId(null);
    }
    if (overlayNoteId === noteId) setOverlayNoteId(null);
  };

  const requestDeleteNoteById = (noteId: string) => {
    const note = sortedNotes.find((item) => item.id === noteId);
    setDeleteTarget({
      type: "note",
      id: noteId,
      name: note?.title || t("notes.title.placeholder"),
    });
  };

  const startCreateGroup = () => {
    const targetGroup = getNoteActionTargetGroup(selectedNote, selectedGroup);
    setCreatingGroupParent(targetGroup);
    if (targetGroup) expandPath(targetGroup);
  };

  const commitCreateGroup = (name: string) => {
    const nextPath = joinNoteGroupPath(creatingGroupParent ?? null, name);
    setCreatingGroupParent(undefined);
    if (!nextPath) return;

    const next = normalizeNoteGroups([...groups, ...ancestorNoteGroupPaths(nextPath)]);
    onUpdateNoteGroups(next);
    expandPath(nextPath);
    const nextSelection = getNoteGroupSelectionState(nextPath);
    setSelectedNoteId(nextSelection.selectedNoteId);
    setSelectedGroup(nextSelection.selectedGroup);
    setOverlayNoteId(nextSelection.overlayNoteId);
  };

  const renameGroup = (group: string, nextName: string) => {
    setEditingGroupPath(null);
    const nextPath = joinNoteGroupPath(getNoteGroupParentPath(group), nextName);
    if (!nextPath || nextPath === group) return;

    const nextGroups = normalizeNoteGroups(
      groups.map((item) => replaceNoteGroupPrefix(item, group, nextPath) || ""),
    );
    onUpdateNoteGroups(nextGroups);
    commitNotesAfterFlush((notes) => notes.map((note) => ({
      ...note,
      group: replaceNoteGroupPrefix(note.group, group, nextPath),
    })));
    setExpandedGroups((current) => {
      const next = new Set<string>();
      current.forEach((item) => {
        const renamed = replaceNoteGroupPrefix(item, group, nextPath);
        if (renamed) next.add(renamed);
      });
      ancestorNoteGroupPaths(nextPath).forEach((path) => next.add(path));
      return next;
    });
    if (selectedGroup && isNoteGroupInside(selectedGroup, group)) {
      setSelectedGroup(replaceNoteGroupPrefix(selectedGroup, group, nextPath) ?? null);
    }
  };

  const performDeleteGroup = (group: string) => {
    onUpdateNoteGroups(groups.filter((item) => !isNoteGroupInside(item, group)));
    commitNotesAfterFlush((notes) => notes.map((note) => (
      isNoteGroupInside(note.group, group) ? { ...note, group: undefined } : note
    )));
    if (selectedGroup && isNoteGroupInside(selectedGroup, group)) setSelectedGroup(null);
    setEditingGroupPath(null);
  };

  const requestDeleteGroup = (group: string) => {
    setDeleteTarget({
      type: "group",
      id: group,
      name: group,
    });
  };

  const confirmDeleteTarget = () => {
    if (!deleteTarget) return;
    if (deleteTarget.type === "note") {
      performDeleteNoteById(deleteTarget.id);
    } else {
      performDeleteGroup(deleteTarget.id);
    }
    setDeleteTarget(null);
  };

  const resetTreeDragState = () => {
    setDraggingNoteId(null);
    setDraggingGroupPath(null);
    clearVaultDropIndicator();
  };

  const getDraggedNoteId = (dataTransfer: DataTransfer) =>
    dataTransfer.getData(NOTE_DRAG_TYPE) || dataTransfer.getData("note-id");

  const getDraggedGroupPath = (dataTransfer: DataTransfer) =>
    dataTransfer.getData(NOTE_GROUP_DRAG_TYPE) || dataTransfer.getData("note-group-path");

  const hasNotesTreeDrag = (dataTransfer: DataTransfer) =>
    draggingNoteId
    || draggingGroupPath
    || hasVaultDragType(dataTransfer, NOTE_DRAG_TYPE)
    || hasVaultDragType(dataTransfer, NOTE_GROUP_DRAG_TYPE)
    || hasVaultDragType(dataTransfer, "note-id")
    || hasVaultDragType(dataTransfer, "note-group-path");

  const handleTreeRowDragLeave = (event: React.DragEvent<HTMLElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    clearVaultDropIndicator();
  };

  const moveNoteToGroup = (noteId: string, group: string | null) => {
    flushNoteDraft();
    const source = sortedNotesRef.current.find((note) => note.id === noteId);
    if (!source) return;
    const nextGroup = group || undefined;
    if ((source.group || undefined) === nextGroup) return;

    commitNotes(sortedNotesRef.current.map((note) => (
      note.id === noteId ? { ...note, group: nextGroup, updatedAt: Date.now() } : note
    )));
    if (group) expandPath(group);
  };

  const reorderNoteToNote = (sourceId: string, targetNote: VaultNote, event: React.DragEvent<HTMLElement>) => {
    if (!sourceId || sourceId === targetNote.id) return;
    const position = getVaultDropPosition(event.currentTarget, event.clientX, event.clientY);
    commitNotesAfterFlush((notes) => {
      const movedNotes = notes.map((note) => (
        note.id === sourceId
          ? { ...note, group: targetNote.group, updatedAt: Date.now() }
          : note
      ));
      return reorderVaultItems(movedNotes, sourceId, targetNote.id, position);
    });
    if (targetNote.group) expandPath(targetNote.group);
  };

  const moveGroupToParent = (group: string, parent: string | null) => {
    flushNoteDraft();
    const knownGroups = normalizeNoteGroups([
      ...groups,
      ...sortedNotesRef.current.map((note) => note.group).filter((item): item is string => Boolean(item)),
    ]);
    const nextPath = resolveMovedNoteGroupPath(group, parent, knownGroups);
    if (!nextPath) return;
    const nextGroups = normalizeNoteGroups(groups.map((item) => replaceNoteGroupPrefix(item, group, nextPath) || ""));
    onUpdateNoteGroups(nextGroups);
    commitNotes(sortedNotesRef.current.map((note) => ({
      ...note,
      group: replaceNoteGroupPrefix(note.group, group, nextPath),
    })));
    setExpandedGroups((current) => remapExpandedNoteGroupPaths(current, group, nextPath));
    if (selectedGroup && isNoteGroupInside(selectedGroup, group)) {
      setSelectedGroup(replaceNoteGroupPrefix(selectedGroup, group, nextPath) ?? null);
    }
  };

  const reorderGroupToGroup = (
    sourceGroup: string,
    targetGroup: string,
    position: VaultDropPosition,
  ) => {
    if (!sourceGroup || !targetGroup || sourceGroup === targetGroup) return;
    if (targetGroup.startsWith(`${sourceGroup}/`)) return;

    flushNoteDraft();
    const targetParent = getNoteGroupParentPath(targetGroup);
    const knownGroups = normalizeNoteGroups([
      ...groups,
      ...sortedNotesRef.current.map((note) => note.group).filter((item): item is string => Boolean(item)),
    ]);
    const nextSourceGroup = getNoteGroupParentPath(sourceGroup) === targetParent
      ? cleanNoteGroupPath(sourceGroup)
      : resolveMovedNoteGroupPath(sourceGroup, targetParent, knownGroups);
    if (!nextSourceGroup) return;

    const nextGroupsBeforeReorder = normalizeNoteGroups([
      ...groups.map((item) => replaceNoteGroupPrefix(item, sourceGroup, nextSourceGroup) || ""),
      ...ancestorNoteGroupPaths(nextSourceGroup),
      ...ancestorNoteGroupPaths(targetGroup),
    ]);
    const nextGroups = reorderVaultStrings(
      nextGroupsBeforeReorder,
      nextSourceGroup,
      targetGroup,
      position,
    );

    onUpdateNoteGroups(nextGroups);
    if (nextSourceGroup !== sourceGroup) {
      commitNotes(sortedNotesRef.current.map((note) => ({
        ...note,
        group: replaceNoteGroupPrefix(note.group, sourceGroup, nextSourceGroup),
      })));
      setExpandedGroups((current) => remapExpandedNoteGroupPaths(current, sourceGroup, nextSourceGroup));
      if (selectedGroup && isNoteGroupInside(selectedGroup, sourceGroup)) {
        setSelectedGroup(replaceNoteGroupPrefix(selectedGroup, sourceGroup, nextSourceGroup) ?? null);
      }
    }
  };

  const handleGroupDrop = (targetGroup: string | null, event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const noteId = getDraggedNoteId(event.dataTransfer);
    const groupPath = getDraggedGroupPath(event.dataTransfer);
    if (noteId) moveNoteToGroup(noteId, targetGroup);
    if (groupPath) moveGroupToParent(groupPath, targetGroup);
    resetTreeDragState();
  };

  const renderNoteActions = (note: VaultNote, mode: "dropdown" | "context", closeMenu?: () => void) => {
    const actions = [
      {
        label: t("common.rename"),
        action: () => setEditingNoteId(note.id),
      },
      {
        label: t("action.copy"),
        action: () => duplicateNoteById(note.id),
      },
      {
        label: t("notes.action.exportNote"),
        action: () => exportNoteToMarkdown(note),
      },
      {
        label: t("action.delete"),
        action: () => requestDeleteNoteById(note.id),
        destructive: true,
      },
    ];

    if (mode === "context") {
      return actions.map((action) => (
        <ContextMenuItem
          key={action.label}
          className={action.destructive ? "text-destructive focus:text-destructive" : undefined}
          onSelect={() => {
            action.action();
          }}
        >
          {action.label}
        </ContextMenuItem>
      ));
    }

    return actions.map((action) => (
      <button
        key={action.label}
        type="button"
        className={cn(menuItemClass, action.destructive && "text-destructive hover:bg-destructive/10")}
        onClick={(event) => {
          event.stopPropagation();
          closeMenu?.();
          action.action();
        }}
      >
        {action.label}
      </button>
    ));
  };

  const renderGroupActions = (groupPath: string, mode: "dropdown" | "context", closeMenu?: () => void) => {
    const actions = [
      {
        label: t("notes.action.newNote"),
        action: () => addNoteToGroup(groupPath),
      },
      {
        label: t("notes.action.newGroup"),
        action: () => {
          setCreatingGroupParent(groupPath);
          expandPath(groupPath);
        },
      },
      {
        label: t("notes.action.importMarkdown"),
        action: () => openImportMarkdownPicker(groupPath),
      },
      {
        label: t("notes.action.exportGroup"),
        action: () => exportGroupNotes(groupPath),
      },
      {
        label: t("common.rename"),
        action: () => setEditingGroupPath(groupPath),
      },
      {
        label: t("action.delete"),
        action: () => requestDeleteGroup(groupPath),
        destructive: true,
      },
    ];

    if (mode === "context") {
      return actions.map((action) => (
        <ContextMenuItem
          key={action.label}
          className={action.destructive ? "text-destructive focus:text-destructive" : undefined}
          onSelect={() => {
            action.action();
          }}
        >
          {action.label}
        </ContextMenuItem>
      ));
    }

    return actions.map((action) => (
      <button
        key={action.label}
        type="button"
        className={cn(menuItemClass, action.destructive && "text-destructive hover:bg-destructive/10")}
        onClick={(event) => {
          event.stopPropagation();
          closeMenu?.();
          action.action();
        }}
      >
        {action.label}
      </button>
    ));
  };

  const renderCreateGroupRow = (parent: string | null, depth: number) => {
    if (creatingGroupParent !== parent) return null;
    return (
      <div
        key={`new-folder-${parent || "root"}`}
        className="flex h-7 min-w-0 items-center px-2 text-sm"
        style={{ paddingLeft: depth * 16 + 4 }}
      >
        <div className="mr-1 h-5 w-4 shrink-0" />
        <div className="mr-1 flex shrink-0 items-center text-current">
          <Folder size={16} strokeWidth={1.9} />
        </div>
        <VaultTreeInlineRenameInput
          initialName={t("notes.action.newGroup")}
          onCommit={commitCreateGroup}
          onCancel={() => setCreatingGroupParent(undefined)}
        />
      </div>
    );
  };

  const noteDisplayTitle = (title: string) => title || t("notes.title.placeholder");

  const renderNoteRow = (note: VaultNote, depth: number) => {
    if (!noteMatches(note)) return null;
    return (
      <ContextMenu key={note.id}>
        <ContextMenuTrigger asChild>
            <VaultTreeItemRow
            label={noteDisplayTitle(note.title)}
            depth={depth}
            selected={selectedNoteId === note.id}
            editing={editingNoteId === note.id}
            editingInitialName={note.title}
            onRenameCommit={(name) => {
              setEditingNoteId(null);
              renameNoteFromTree(note.id, name);
            }}
            onRenameCancel={() => setEditingNoteId(null)}
            icon={<FileText size={16} className="shrink-0 text-muted-foreground" />}
            iconClassName="mr-1"
            data-note-id={note.id}
            data-notes-drag-kind="note"
            data-notes-context-menu="note"
            data-vault-reorder-dragging={draggingNoteId === note.id ? "true" : undefined}
            draggable={editingNoteId !== note.id}
            onDragStart={(event) => {
              event.dataTransfer.setData(NOTE_DRAG_TYPE, note.id);
              event.dataTransfer.setData("note-id", note.id);
              event.dataTransfer.effectAllowed = "move";
              setDraggingNoteId(note.id);
            }}
            onDragOver={(event) => {
              const sourceNoteId = draggingNoteId || getDraggedNoteId(event.dataTransfer);
              if (!sourceNoteId || sourceNoteId === note.id) {
                clearVaultDropIndicator();
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "move";
              markVaultDropIndicator(
                event.currentTarget,
                getVaultDropPosition(event.currentTarget, event.clientX, event.clientY),
              );
            }}
            onDragLeave={handleTreeRowDragLeave}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              reorderNoteToNote(draggingNoteId || getDraggedNoteId(event.dataTransfer), note, event);
              resetTreeDragState();
            }}
            onDragEnd={resetTreeDragState}
            onClick={() => {
              const nextSelection = getNoteSelectionState(note, isSidebarMode);
              setSelectedNoteId(nextSelection.selectedNoteId);
              setSelectedGroup(nextSelection.selectedGroup);
              setOverlayNoteId(nextSelection.overlayNoteId);
            }}
              actions={(
                <HoverActionMenu>
                  {(closeMenu) => renderNoteActions(note, "dropdown", closeMenu)}
                </HoverActionMenu>
              )}
          />
        </ContextMenuTrigger>
        <ContextMenuContent data-notes-context-menu="note">
          {renderNoteActions(note, "context")}
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  const renderFolderRow = (node: NoteFolderNode, depth: number): React.ReactNode => {
    const folderMatchesQuery = groupMatches(node);
    const visibleNotes = folderMatchesQuery ? node.notes : node.notes.filter(noteMatches);
    const visibleChildren = node.children
      .map((child) => renderFolderRow(child, depth + 1))
      .filter(Boolean);
    if (queryText && !folderMatchesQuery && visibleNotes.length === 0 && visibleChildren.length === 0) {
      return null;
    }

    const expanded = queryText ? true : expandedGroups.has(node.path);
    const hasChildren = node.children.length > 0 || node.notes.length > 0;
    return (
      <React.Fragment key={node.path}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <VaultTreeGroupRow
              name={node.name}
              depth={depth}
              expanded={expanded}
              selected={isNoteFolderTreeSelected(selectedGroup, selectedNoteId, node.path)}
              hasChildren={hasChildren}
              iconSize={16}
              iconClassName="mr-1"
              editing={editingGroupPath === node.path}
              editingInitialName={node.name}
              onRenameCommit={(name) => renameGroup(node.path, name)}
              onRenameCancel={() => setEditingGroupPath(null)}
              data-note-group-path={node.path}
              data-notes-drag-kind="group"
              data-notes-context-menu="group"
              data-vault-reorder-dragging={draggingGroupPath === node.path ? "true" : undefined}
              draggable={editingGroupPath !== node.path}
              onDragStart={(event) => {
                event.dataTransfer.setData(NOTE_GROUP_DRAG_TYPE, node.path);
                event.dataTransfer.setData("note-group-path", node.path);
                event.dataTransfer.effectAllowed = "move";
                setDraggingGroupPath(node.path);
              }}
              onDragOver={(event) => {
                const sourceNoteId = draggingNoteId || getDraggedNoteId(event.dataTransfer);
                const sourceGroupPath = draggingGroupPath || getDraggedGroupPath(event.dataTransfer);
                if (!sourceNoteId && !sourceGroupPath) {
                  clearVaultDropIndicator();
                  return;
                }
                if (sourceGroupPath && (sourceGroupPath === node.path || node.path.startsWith(`${sourceGroupPath}/`))) {
                  clearVaultDropIndicator();
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
                if (sourceGroupPath) {
                  const intent = getVaultDropIntent(event.currentTarget, event.clientX, event.clientY, false);
                  if (intent === "inside") {
                    markVaultInsideDropIndicator(event.currentTarget);
                  } else {
                    markVaultDropIndicator(event.currentTarget, intent);
                  }
                  return;
                }
                markVaultInsideDropIndicator(event.currentTarget);
              }}
              onDragLeave={handleTreeRowDragLeave}
              onDrop={(event) => {
                const sourceGroupPath = draggingGroupPath || getDraggedGroupPath(event.dataTransfer);
                if (sourceGroupPath) {
                  const intent = getVaultDropIntent(event.currentTarget, event.clientX, event.clientY, false);
                  const dropAction = getNotesGroupDropAction(sourceGroupPath, node.path, intent);
                  if (dropAction === "reorder" && intent !== "inside") {
                    event.preventDefault();
                    event.stopPropagation();
                    reorderGroupToGroup(sourceGroupPath, node.path, intent);
                    resetTreeDragState();
                    return;
                  }
                  if (dropAction === "ignore") return;
                }
                handleGroupDrop(node.path, event);
              }}
              onDragEnd={resetTreeDragState}
              onClick={() => {
                const nextSelection = getNoteGroupSelectionState(node.path);
                setSelectedNoteId(nextSelection.selectedNoteId);
                setSelectedGroup(nextSelection.selectedGroup);
                setOverlayNoteId(nextSelection.overlayNoteId);
                if (hasChildren) toggleGroup(node.path);
              }}
                actions={(
                  <HoverActionMenu>
                    {(closeMenu) => renderGroupActions(node.path, "dropdown", closeMenu)}
                  </HoverActionMenu>
                )}
            />
          </ContextMenuTrigger>
          <ContextMenuContent data-notes-context-menu="group">
            {renderGroupActions(node.path, "context")}
          </ContextMenuContent>
        </ContextMenu>
        {expanded && (
          <>
            {renderCreateGroupRow(node.path, depth + 1)}
            {visibleChildren}
            {visibleNotes.map((note) => renderNoteRow(note, depth + 1))}
          </>
        )}
      </React.Fragment>
    );
  };

  const visibleRootNotes = noteTree.rootNotes.filter(noteMatches);
  const visibleTree = noteTree.children
    .map((child) => renderFolderRow(child, 0))
    .filter(Boolean);
  const treeIsEmpty = visibleRootNotes.length === 0 && visibleTree.length === 0;
  const hasSearch = query.trim().length > 0;
  const canExpandCollapse = allGroupPaths.length > 0 && !hasSearch;
  const shouldShowNotesTree = isSidebarMode || sortedNotes.length > 0;

  const handleTreeResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = treeWidthRef.current;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const aside = treeAsideRef.current;
    let frame = 0;
    let latestWidth = startWidth;

    // Avoid setState on every pointermove — NotesManager owns the MDX editor and
    // re-rendering it per pixel makes sidebar resize feel stuck.
    setIsTreeResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    if (aside) {
      aside.style.willChange = "width";
    }

    const applyWidth = (width: number) => {
      latestWidth = width;
      if (aside) {
        aside.style.width = `${width}px`;
      }
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = clampNotesTreeWidth(startWidth + moveEvent.clientX - startX);
      if (frame) {
        latestWidth = nextWidth;
        return;
      }
      latestWidth = nextWidth;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        applyWidth(latestWidth);
      });
    };

    const handlePointerUp = () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      const nextWidth = clampNotesTreeWidth(latestWidth);
      applyWidth(nextWidth);
      if (aside) {
        aside.style.willChange = "";
      }
      treeWidthRef.current = nextWidth;
      setTreeWidth(nextWidth);
      persistTreeWidth(nextWidth);
      setIsTreeResizing(false);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  }, [persistTreeWidth, setTreeWidth]);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <input
        ref={importFileInputRef}
        type="file"
        accept=".md,.markdown,.txt"
        multiple
        className="hidden"
        onChange={(event) => {
          void handleImportMarkdownFiles(event.target.files);
        }}
      />
      <div className="flex min-h-0 flex-1">
        {shouldShowNotesTree && (
          <aside
            ref={treeAsideRef}
            className={cn(
              // min-w-0 on the aside; overflow-hidden stays on the inner tree shell
              // so the resize separator's translate-x-1/2 hit area is not clipped.
              "relative flex min-w-0 flex-col bg-background",
              isSidebarMode ? "flex-1" : "shrink-0 border-r border-border/60",
            )}
            style={isSidebarMode ? undefined : { width: treeWidth }}
          >
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="min-w-0 flex-shrink-0 overflow-hidden">
            <div className={cn(
              TERMINAL_SIDE_PANEL_INNER_HEADER_CLASS,
              "flex min-w-0 items-center gap-1 overflow-x-auto border-b border-border/60 px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            )}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={toolbarIconButtonClass}
                    onClick={() => setExpandedPanel(expandedPanel === "search" ? null : "search")}
                  >
                    <Search size={14} className={expandedPanel === "search" || hasSearch ? "text-foreground" : "text-muted-foreground"} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("notes.search.placeholder")}</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={toolbarIconButtonClass}
                    onClick={addNote}
                  >
                    <FileText size={14} className="text-muted-foreground" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("notes.action.newNote")}</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={toolbarIconButtonClass}
                    onClick={startCreateGroup}
                  >
                    <FolderPlus size={14} className="text-muted-foreground" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("notes.action.newGroup")}</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={toolbarIconButtonClass}
                    onClick={() => openImportMarkdownPicker()}
                  >
                    <Upload size={14} className="text-muted-foreground" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("notes.action.importMarkdown")}</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={toolbarIconButtonClass}
                    disabled={sortedNotes.length === 0}
                    onClick={exportAllNotes}
                  >
                    <Download size={14} className="text-muted-foreground" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("notes.action.exportAll")}</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={toolbarIconButtonClass}
                    disabled={!canExpandCollapse}
                    onClick={expandAllGroups}
                  >
                    <Expand size={14} className="text-muted-foreground" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("vault.tree.expandAll")}</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={toolbarIconButtonClass}
                    disabled={!canExpandCollapse}
                    onClick={collapseAllGroups}
                  >
                    <Minimize2 size={14} className="text-muted-foreground" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("vault.tree.collapseAll")}</TooltipContent>
              </Tooltip>
            </div>

            <div
              className={cn(
                "overflow-hidden transition-[max-height,opacity] duration-200 ease-out",
                expandedPanel === "search" ? "max-h-9 border-b border-border/60 opacity-100" : "max-h-0 opacity-0",
              )}
            >
              <div className="flex h-9 items-center gap-0.5 px-1.5">
                <div className="relative min-w-0 flex-1">
                  <Search
                    size={12}
                    className="pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    ref={searchInputRef}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t("notes.search.placeholder")}
                    className="h-7 border-0 bg-transparent pl-6 pr-1 text-xs shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                  />
                </div>
                {hasSearch && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={toolbarIconButtonClass}
                        onClick={() => {
                          setQuery("");
                          searchInputRef.current?.focus();
                        }}
                      >
                        <X size={14} className="text-muted-foreground" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{t("common.clear")}</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          </div>
          {/* Radix ScrollArea viewport child defaults to display:table, which
              expands to content width and blocks title ellipsis on narrow trees.
              Force block + min-w-0 so rows shrink with the sidebar (same pattern
              as AsidePanelContent). */}
          <ScrollArea className="min-w-0 flex-1 [&>[data-radix-scroll-area-viewport]>div]:!block [&>[data-radix-scroll-area-viewport]>div]:!min-w-0">
            <div
              className="min-h-full min-w-0 space-y-1 overflow-hidden px-1.5 pt-1.5 pb-4"
              data-notes-drop-zone="root"
              onDragOver={(event) => {
                if (!hasNotesTreeDrag(event.dataTransfer)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => handleGroupDrop(null, event)}
            >
              {renderCreateGroupRow(null, 0)}
              {visibleTree}
              {visibleRootNotes.map((note) => renderNoteRow(note, 0))}
              {treeIsEmpty && (
                <div className="rounded-lg border border-dashed border-border/70 p-4 text-center text-sm text-muted-foreground">
                  <Search size={20} className="mx-auto mb-2 opacity-60" />
                  {query.trim() ? t("notes.search.noResults") : t("notes.empty.group")}
                </div>
              )}
            </div>
          </ScrollArea>
          </div>
          {!isSidebarMode && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t("vault.sidebar.resize")}
              className={cn(
                "app-no-drag absolute right-0 top-0 z-20 h-full w-2 translate-x-1/2 cursor-col-resize",
                "after:absolute after:right-1/2 after:top-2 after:h-[calc(100%-16px)] after:w-px after:translate-x-1/2 after:bg-border/0 after:transition-colors",
                "hover:after:bg-border/70",
                isTreeResizing && "after:bg-primary/70",
              )}
              onPointerDown={handleTreeResizeStart}
            />
          )}
          </aside>
        )}

        {!isSidebarMode && (
        <main
          className={cn(
            "flex min-w-0 flex-1 flex-col bg-background",
            // Keep the editor out of hit-testing / paint thrash while the tree
            // width is driven from the DOM during resize.
            isTreeResizing && "pointer-events-none",
          )}
        >
          {selectedNoteView ? (
            <>
              <div className="flex min-h-[54px] shrink-0 items-center gap-2 px-8 pt-6 pb-1" data-note-title-row>
                <div className="min-w-0 flex-1">
                  <NoteTitleInput
                    noteId={selectedNoteView.id}
                    className="h-8 w-full bg-transparent text-lg font-semibold leading-8 outline-none placeholder:text-muted-foreground"
                    value={selectedNoteView.title}
                    placeholder={t("notes.title.placeholder")}
                    onCommit={(title) => saveNoteTitleDraft(selectedNoteView, title)}
                    onLiveDraft={(title) => stashNoteTitleDraft(selectedNoteView, title)}
                    onBlur={() => flushNoteDraft()}
                  />
                </div>

                <NoteModeDropdown
                  editorMode={noteEditorMode}
                  onChangeMode={(mode) => {
                    flushNoteDraft();
                    setNoteEditorMode(mode);
                  }}
                />

                {/* Outline Toggle */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("notes.outline.title")}
                      className={cn(
                        "app-no-drag h-8 w-8 shrink-0 rounded-md p-0 transition-colors hover:bg-secondary/70",
                        showOutline ? "bg-secondary text-primary font-medium" : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setShowOutline((prev) => !prev)}
                    >
                      <ListTree size={16} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t("notes.outline.title")}</TooltipContent>
                </Tooltip>

                {/* Export Menu */}
                <NoteExportMenu
                  note={selectedNoteView}
                  allNotes={sortedNotes}
                  onExportNote={exportNoteToMarkdown}
                  onExportAll={exportAllNotes}
                />

                {/* Delete Note */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t("action.delete")}
                      className="app-no-drag h-8 w-8 shrink-0 rounded-md p-0 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => requestDeleteNoteById(selectedNoteView.id)}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t("action.delete")}</TooltipContent>
                </Tooltip>
              </div>

              {/* Tags & Folder Breadcrumb Header */}
              <div className="flex flex-wrap items-center gap-1.5 px-8 pb-2 text-xs text-muted-foreground">
                {selectedNoteView.group && (
                  <span
                    data-note-metadata-pill="folder"
                    className={cn(noteMetadataPillClass, "text-foreground")}
                  >
                    <Folder size={12} className="text-amber-500" />
                    <span className={noteMetadataLabelClass}>{selectedNoteView.group}</span>
                  </span>
                )}

                {selectedNoteView.tags?.map((tag) => (
                  <span
                    key={tag}
                    data-note-metadata-pill="tag"
                    className={cn(noteMetadataPillClass, "text-foreground")}
                  >
                    <Hash size={12} className="opacity-70" />
                    <span className={noteMetadataLabelClass}>{tag}</span>
                    <button
                      type="button"
                      className="-mr-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                      onClick={() => removeTagFromNote(selectedNoteView.id, tag)}
                      title={t("notes.tag.remove")}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}

                {tagInputOpen ? (
                  <div className="inline-flex h-5 items-center gap-1 rounded-md border border-primary/60 bg-background px-1.5 leading-none">
                    <Hash size={12} className="text-muted-foreground" />
                    <input
                      type="text"
                      autoFocus
                      value={newTagText}
                      onChange={(e) => setNewTagText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          if (newTagText.trim()) {
                            addTagToNote(selectedNoteView.id, newTagText.trim());
                            setNewTagText("");
                            setTagInputOpen(false);
                          }
                        } else if (e.key === "Escape") {
                          setTagInputOpen(false);
                          setNewTagText("");
                        }
                      }}
                      onBlur={() => {
                        if (newTagText.trim()) {
                          addTagToNote(selectedNoteView.id, newTagText.trim());
                        }
                        setTagInputOpen(false);
                        setNewTagText("");
                      }}
                      placeholder={t("notes.tag.placeholder")}
                      className="w-20 translate-y-px bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground/60"
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    data-note-metadata-pill="add-tag"
                    className={cn(noteMetadataPillClass, "text-foreground transition-colors hover:bg-muted")}
                    onClick={() => setTagInputOpen(true)}
                  >
                    <Plus size={12} />
                    <span className={noteMetadataLabelClass}>{t("notes.tag.add")}</span>
                  </button>
                )}
              </div>

              {/* Cherry Studio Style Note Toolbar */}
              <NoteToolbar
                editorMode={noteEditorMode}
                onAction={handleToolbarAction}
                activeFormats={activeFormats}
                noteFontFamily={resolvedNoteFontFamily}
                onChangeNoteFontFamily={(font) => setNoteFontFamily(font)}
                noteFontSize={noteFontSize}
                onChangeNoteFontSize={handleSetNoteFontSize}
                noteCodeFontSize={noteCodeFontSize}
                onChangeNoteCodeFontSize={handleSetNoteCodeFontSize}
              />

              <div className="flex flex-1 min-h-0 min-w-0">
                {noteEditorMode === "source" ? (
                  <div
                    className="flex-1 min-h-0 min-w-0 h-full"
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        flushNoteDraft();
                      }
                    }}
                  >
                    <LazyLoadBoundary name="Notes editor" resetKey="notes-editor">
                      <Suspense fallback={<InlineMarkdownEditorFallback />}>
                        <InlineMarkdownEditor
                          ref={inlineEditorRef}
                          noteId={selectedNoteView.id}
                          value={selectedNoteView.content}
                          placeholder={t("notes.editor.placeholder")}
                          editorMode={noteEditorMode}
                          previewEmptyLabel={t("notes.preview.empty")}
                          onChange={(content) => saveNoteContentDraft(selectedNoteView.id, content)}
                          hosts={hosts}
                          onOpenHost={(host) => handleOpenHostFromNote(host, selectedNoteView.id)}
                          onOpenExternalLink={openExternal}
                          sourceEditorRef={sourceEditorRef}
                          noteFontFamily={resolvedNoteFontFamily}
                          noteFontSize={noteFontSize}
                          noteCodeFontSize={noteCodeFontSize}
                          onActiveFormatsChange={setActiveFormats}
                        />
                      </Suspense>
                    </LazyLoadBoundary>
                  </div>
                ) : (
                  <ScrollArea className="min-h-0 flex-1">
                    <div
                      className="min-h-full w-full px-8 pt-2 pb-6"
                      onBlur={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                          flushNoteDraft();
                        }
                      }}
                    >
                      <LazyLoadBoundary name="Notes editor" resetKey="notes-editor">
                        <Suspense fallback={<InlineMarkdownEditorFallback />}>
                          <InlineMarkdownEditor
                            ref={inlineEditorRef}
                            noteId={selectedNoteView.id}
                            value={selectedNoteView.content}
                            placeholder={t("notes.editor.placeholder")}
                            editorMode={noteEditorMode}
                            previewEmptyLabel={t("notes.preview.empty")}
                            onChange={(content) => saveNoteContentDraft(selectedNoteView.id, content)}
                            hosts={hosts}
                            onOpenHost={(host) => handleOpenHostFromNote(host, selectedNoteView.id)}
                            onOpenExternalLink={openExternal}
                            sourceEditorRef={sourceEditorRef}
                            noteFontFamily={resolvedNoteFontFamily}
                            noteFontSize={noteFontSize}
                            noteCodeFontSize={noteCodeFontSize}
                            onActiveFormatsChange={setActiveFormats}
                          />
                        </Suspense>
                      </LazyLoadBoundary>
                    </div>
                  </ScrollArea>
                )}

                {showOutline && (
                  <div className="h-full w-64 shrink-0">
                    <NoteOutline
                      content={selectedNoteView.content}
                      onSelectHeading={handleOutlineHeadingSelect}
                      onClose={() => setShowOutline(false)}
                    />
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center px-4">
              <div className="flex max-w-sm flex-col items-center text-center text-muted-foreground">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-secondary/80">
                  <Edit2 size={30} className="opacity-60" />
                </div>
                <h3 className="mb-2 text-lg font-semibold text-foreground">{t("notes.empty.title")}</h3>
                <p className="mb-4 text-sm">{t("notes.empty.desc")}</p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button onClick={addNote}>
                    <Plus size={14} className="mr-2" />
                    {t("notes.action.newNote")}
                  </Button>
                  <Button variant="outline" onClick={() => openImportMarkdownPicker()}>
                    <Upload size={14} className="mr-2" />
                    {t("notes.action.importMarkdown")}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </main>
        )}
      </div>

      {isSidebarMode && overlayNoteView && (
        <div className="absolute inset-0 z-30 flex min-h-0 flex-col bg-background text-foreground">
          <div className={cn(
            TERMINAL_SIDE_PANEL_INNER_HEADER_CLASS,
            "flex items-center gap-1 border-b border-border/60 px-1.5",
          )}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={toolbarIconButtonClass}
                  onClick={() => setOverlayNoteId(null)}
                >
                  <ArrowLeft size={14} className="text-muted-foreground" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("common.back")}</TooltipContent>
            </Tooltip>
            <div className="min-w-0 flex-1 truncate px-1 text-xs font-medium leading-4 text-foreground">
              {overlayNoteView.title || t("notes.title.placeholder")}
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col bg-background">
            <div className="flex min-h-[54px] shrink-0 items-center gap-2 px-4 pt-5 pb-1" data-note-title-row>
              <div className="min-w-0 flex-1">
                <NoteTitleInput
                  noteId={overlayNoteView.id}
                  className="h-8 w-full bg-transparent text-lg font-semibold leading-8 outline-none placeholder:text-muted-foreground"
                  value={overlayNoteView.title}
                  placeholder={t("notes.title.placeholder")}
                  onCommit={(title) => saveNoteTitleDraft(overlayNoteView, title)}
                  onLiveDraft={(title) => stashNoteTitleDraft(overlayNoteView, title)}
                  onBlur={() => flushNoteDraft()}
                />
              </div>

              <NoteModeDropdown
                editorMode={noteEditorMode}
                onChangeMode={(mode) => {
                  flushNoteDraft();
                  setNoteEditorMode(mode);
                }}
              />

              <NoteExportMenu
                note={overlayNoteView}
                allNotes={sortedNotes}
                onExportNote={exportNoteToMarkdown}
                onExportAll={exportAllNotes}
              />
            </div>

            {/* Note Toolbar in Overlay */}
            <NoteToolbar
              editorMode={noteEditorMode}
              onAction={handleToolbarAction}
              activeFormats={activeFormats}
              noteFontFamily={resolvedNoteFontFamily}
              onChangeNoteFontFamily={(font) => setNoteFontFamily(font)}
              noteFontSize={noteFontSize}
              onChangeNoteFontSize={handleSetNoteFontSize}
              noteCodeFontSize={noteCodeFontSize}
              onChangeNoteCodeFontSize={handleSetNoteCodeFontSize}
            />

            {noteEditorMode === "source" ? (
              <div
                className="flex-1 min-h-0 min-w-0 h-full"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    flushNoteDraft();
                  }
                }}
              >
                <LazyLoadBoundary name="Notes editor" resetKey="notes-overlay-editor">
                  <Suspense fallback={<InlineMarkdownEditorFallback />}>
                    <InlineMarkdownEditor
                      ref={overlayEditorRef}
                      noteId={overlayNoteView.id}
                      value={overlayNoteView.content}
                      placeholder={t("notes.editor.placeholder")}
                      editorMode={noteEditorMode}
                      onChange={(content) => saveNoteContentDraft(overlayNoteView.id, content)}
                      previewEmptyLabel={t("notes.preview.empty")}
                      hosts={hosts}
                      onOpenHost={(host) => handleOpenHostFromNote(host, overlayNoteView.id)}
                      onOpenExternalLink={openExternal}
                      sourceEditorRef={sourceEditorRef}
                      noteFontFamily={resolvedNoteFontFamily}
                      noteFontSize={noteFontSize}
                      noteCodeFontSize={noteCodeFontSize}
                      onActiveFormatsChange={setActiveFormats}
                    />
                  </Suspense>
                </LazyLoadBoundary>
              </div>
            ) : (
              <ScrollArea className="min-h-0 flex-1">
                <div
                  className="min-h-full w-full px-4 pt-2 pb-6"
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      flushNoteDraft();
                    }
                  }}
                >
                  <LazyLoadBoundary name="Notes editor" resetKey="notes-overlay-editor">
                    <Suspense fallback={<InlineMarkdownEditorFallback />}>
                      <InlineMarkdownEditor
                        ref={overlayEditorRef}
                        noteId={overlayNoteView.id}
                        value={overlayNoteView.content}
                        placeholder={t("notes.editor.placeholder")}
                        editorMode={noteEditorMode}
                        onChange={(content) => saveNoteContentDraft(overlayNoteView.id, content)}
                        previewEmptyLabel={t("notes.preview.empty")}
                        hosts={hosts}
                        onOpenHost={(host) => handleOpenHostFromNote(host, overlayNoteView.id)}
                        onOpenExternalLink={openExternal}
                        sourceEditorRef={sourceEditorRef}
                        noteFontFamily={resolvedNoteFontFamily}
                        noteFontSize={noteFontSize}
                        noteCodeFontSize={noteCodeFontSize}
                        onActiveFormatsChange={setActiveFormats}
                      />
                    </Suspense>
                  </LazyLoadBoundary>
                </div>
              </ScrollArea>
            )}
          </div>
        </div>
      )}
      <VaultDeleteConfirmDialog
        open={Boolean(deleteTarget)}
        title={t("vault.deleteConfirm.title", {
          name: deleteTarget?.name ?? "",
        })}
        description={
          deleteTarget?.type === "group"
            ? t("vault.deleteConfirm.noteGroupDesc")
            : t("vault.deleteConfirm.desc")
        }
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={confirmDeleteTarget}
      />
    </div>
  );
};
