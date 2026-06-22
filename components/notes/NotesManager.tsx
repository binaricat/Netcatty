import {
  ArrowLeft,
  Edit2,
  Expand,
  FileText,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Minimize2,
  Plus,
  Search,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { useApplicationBackend } from "../../application/state/useApplicationBackend";
import { useStoredNumber } from "../../application/state/useStoredNumber";
import { matchesVaultNoteSearch, normalizeNoteGroups, normalizeVaultNotes } from "../../domain/notes";
import { getNextVaultOrder, reorderVaultItems, sortByVaultOrder } from "../../domain/vaultOrder";
import { STORAGE_KEY_VAULT_NOTES_TREE_WIDTH } from "../../infrastructure/config/storageKeys";
import { cn } from "../../lib/utils";
import type { Host, VaultNote } from "../../types";
import { Button } from "../ui/button";
import { Dropdown, DropdownContent, DropdownTrigger } from "../ui/dropdown";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
  VaultTreeGroupRow,
  VaultTreeInlineRenameInput,
  VaultTreeItemRow,
} from "../vault/VaultTreeRow";
import { InlineMarkdownEditor } from "./InlineMarkdownEditor";

interface NoteFolderNode {
  name: string;
  path: string;
  children: NoteFolderNode[];
  notes: VaultNote[];
}

type NotesToolbarPanel = "search" | null;

const toolbarIconButtonClass = "netcatty-tab h-7 w-7 shrink-0 rounded-md p-0 hover:bg-transparent";
const menuItemClass = "flex h-8 w-full items-center rounded-md px-3 text-left text-sm hover:bg-secondary";
const NOTES_TREE_DEFAULT_WIDTH = 300;
const NOTES_TREE_MIN_WIDTH = 220;
const NOTES_TREE_MAX_WIDTH = 520;

export interface NotesManagerProps {
  notes: VaultNote[];
  noteGroups: string[];
  hosts: Host[];
  onUpdateNotes: (notes: VaultNote[]) => void;
  onUpdateNoteGroups: (groups: string[]) => void;
  onOpenHost?: (host: Host, source?: { noteId: string }) => void;
  displayMode?: "full" | "sidebar";
  openNoteId?: string | null;
}

type HoverActionMenuProps = {
  children: React.ReactNode;
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

  return (
    <Dropdown open={open} onOpenChange={setOpen}>
      <DropdownTrigger asChild>
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
          onClick={(event) => event.stopPropagation()}
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
        {children}
      </DropdownContent>
    </Dropdown>
  );
};

const createNote = (group: string | null, order: number): VaultNote => {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "Untitled note",
    content: "",
    group: group || undefined,
    createdAt: now,
    updatedAt: now,
    order,
  };
};

const cleanGroupPath = (value: string): string =>
  value
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");

const ancestorPaths = (path: string): string[] => {
  const parts = cleanGroupPath(path).split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
};

const getLeafName = (path: string): string => cleanGroupPath(path).split("/").pop() || cleanGroupPath(path);

const getParentPath = (path: string): string | null => {
  const parts = cleanGroupPath(path).split("/").filter(Boolean);
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join("/");
};

const joinGroupPath = (parent: string | null, name: string): string => {
  const cleanName = cleanGroupPath(name);
  if (!cleanName) return "";
  return parent ? `${cleanGroupPath(parent)}/${cleanName}` : cleanName;
};

const isInsideGroup = (path: string | undefined, group: string): boolean =>
  path === group || Boolean(path?.startsWith(`${group}/`));

const replaceGroupPrefix = (path: string | undefined, from: string, to: string): string | undefined => {
  if (!path) return path;
  if (path === from) return to || undefined;
  if (path.startsWith(`${from}/`)) return `${to}/${path.slice(from.length + 1)}`;
  return path;
};

const getDropPosition = (element: HTMLElement, clientY: number): "before" | "after" => {
  const rect = element.getBoundingClientRect();
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
};

const sortNoteItems = (items: VaultNote[]): VaultNote[] => sortByVaultOrder(items);

const sortFolderNodes = (items: NoteFolderNode[]): NoteFolderNode[] =>
  [...items]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((node) => ({
      ...node,
      children: sortFolderNodes(node.children),
      notes: sortNoteItems(node.notes),
    }));

const buildNoteTree = (groups: string[], notes: VaultNote[]): { children: NoteFolderNode[]; rootNotes: VaultNote[] } => {
  const nodes = new Map<string, NoteFolderNode>();
  const ensureNode = (path: string): NoteFolderNode => {
    const cleanPath = cleanGroupPath(path);
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
  allGroups.flatMap(ancestorPaths).forEach(ensureNode);

  const rootNotes: VaultNote[] = [];
  notes.forEach((note) => {
    const group = note.group ? cleanGroupPath(note.group) : "";
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

export const NotesManager: React.FC<NotesManagerProps> = ({
  notes,
  noteGroups,
  hosts,
  onUpdateNotes,
  onUpdateNoteGroups,
  onOpenHost,
  displayMode = "full",
  openNoteId = null,
}) => {
  const { t } = useI18n();
  const { openExternal } = useApplicationBackend();
  const isSidebarMode = displayMode === "sidebar";
  const [query, setQuery] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<string | null>(() => notes[0]?.group ?? null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(() => isSidebarMode ? null : notes[0]?.id ?? null);
  const [overlayNoteId, setOverlayNoteId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(notes.flatMap((note) => note.group ? ancestorPaths(note.group) : [])),
  );
  const [expandedPanel, setExpandedPanel] = useState<NotesToolbarPanel>(null);
  const [creatingGroupParent, setCreatingGroupParent] = useState<string | null | undefined>(undefined);
  const [editingGroupPath, setEditingGroupPath] = useState<string | null>(null);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [isTreeResizing, setIsTreeResizing] = useState(false);
  const [treeWidth, setTreeWidth, persistTreeWidth] = useStoredNumber(
    STORAGE_KEY_VAULT_NOTES_TREE_WIDTH,
    NOTES_TREE_DEFAULT_WIDTH,
    { min: NOTES_TREE_MIN_WIDTH, max: NOTES_TREE_MAX_WIDTH },
  );
  const searchInputRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => normalizeNoteGroups(noteGroups), [noteGroups]);
  const sortedNotes = useMemo(() => sortNoteItems(normalizeVaultNotes(notes)), [notes]);
  const noteTree = useMemo(() => {
    const tree = buildNoteTree(groups, sortedNotes);
    return {
      children: sortFolderNodes(tree.children),
      rootNotes: sortNoteItems(tree.rootNotes),
    };
  }, [groups, sortedNotes]);
  const selectedNote = sortedNotes.find((note) => note.id === selectedNoteId)
    ?? (isSidebarMode ? null : sortedNotes[0] ?? null);
  const overlayNote = sortedNotes.find((note) => note.id === overlayNoteId) ?? null;

  const queryText = query.trim();
  const queryLower = queryText.toLowerCase();
  const noteMatches = (note: VaultNote) => matchesVaultNoteSearch(note, queryText, hosts);
  const groupMatches = (node: NoteFolderNode) =>
    !queryLower || node.name.toLowerCase().includes(queryLower) || node.path.toLowerCase().includes(queryLower);

  useEffect(() => {
    if (!selectedNoteId || sortedNotes.some((note) => note.id === selectedNoteId)) return;
    setSelectedNoteId(isSidebarMode ? null : sortedNotes[0]?.id ?? null);
  }, [isSidebarMode, selectedNoteId, sortedNotes]);

  useEffect(() => {
    if (!overlayNoteId || sortedNotes.some((note) => note.id === overlayNoteId)) return;
    setOverlayNoteId(null);
  }, [overlayNoteId, sortedNotes]);

  useEffect(() => {
    if (!selectedNote?.group) return;
    setExpandedGroups((current) => new Set([...current, ...ancestorPaths(selectedNote.group || "")]));
  }, [selectedNote?.group]);

  useEffect(() => {
    if (!isSidebarMode || !openNoteId) return;
    const note = sortedNotes.find((item) => item.id === openNoteId);
    if (!note) return;
    setSelectedNoteId(note.id);
    setOverlayNoteId(note.id);
    setSelectedGroup(note.group || null);
    if (note.group) {
      setExpandedGroups((current) => new Set([...current, ...ancestorPaths(note.group || "")]));
    }
  }, [isSidebarMode, openNoteId, sortedNotes]);

  useEffect(() => {
    if (expandedPanel !== "search") return;
    const frame = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [expandedPanel]);

  const expandPath = (path: string) => {
    setExpandedGroups((current) => new Set([...current, ...ancestorPaths(path)]));
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

  const saveNote = (nextNote: VaultNote) => {
    const cleaned = normalizeVaultNotes(
      sortedNotes.map((note) => (note.id === nextNote.id ? nextNote : note)),
    );
    onUpdateNotes(cleaned);
  };

  const handleOpenHostFromNote = useCallback((host: Host, noteId: string) => {
    onOpenHost?.(host, { noteId });
  }, [onOpenHost]);

  const addNoteToGroup = (group: string | null) => {
    const note = createNote(group, getNextVaultOrder(sortedNotes));
    onUpdateNotes(normalizeVaultNotes([...sortedNotes, note]));
    if (group) expandPath(group);
    setSelectedNoteId(note.id);
    if (isSidebarMode) setOverlayNoteId(note.id);
    setSelectedGroup(group);
  };

  const addNote = () => {
    addNoteToGroup(selectedGroup);
  };

  const duplicateNoteById = (noteId: string) => {
    const source = sortedNotes.find((note) => note.id === noteId);
    if (!source) return;
    const now = Date.now();
    const copy: VaultNote = {
      ...source,
      id: crypto.randomUUID(),
      title: `${source.title} (${t("action.copy")})`,
      createdAt: now,
      updatedAt: now,
      order: getNextVaultOrder(sortedNotes),
    };
    onUpdateNotes(normalizeVaultNotes([...sortedNotes, copy]));
    if (copy.group) expandPath(copy.group);
    setSelectedNoteId(copy.id);
    if (isSidebarMode) setOverlayNoteId(copy.id);
  };

  const deleteNoteById = (noteId: string) => {
    const next = sortedNotes.filter((note) => note.id !== noteId);
    onUpdateNotes(next);
    if (selectedNoteId === noteId) {
      setSelectedNoteId(isSidebarMode ? null : next[0]?.id ?? null);
      setEditingNoteId(null);
    }
    if (overlayNoteId === noteId) setOverlayNoteId(null);
  };

  const startCreateGroup = () => {
    setCreatingGroupParent(selectedGroup);
    if (selectedGroup) expandPath(selectedGroup);
  };

  const commitCreateGroup = (name: string) => {
    const nextPath = joinGroupPath(creatingGroupParent ?? null, name);
    setCreatingGroupParent(undefined);
    if (!nextPath) return;

    const next = normalizeNoteGroups([...groups, ...ancestorPaths(nextPath)]);
    onUpdateNoteGroups(next);
    expandPath(nextPath);
    setSelectedGroup(nextPath);
  };

  const renameGroup = (group: string, nextName: string) => {
    setEditingGroupPath(null);
    const nextPath = joinGroupPath(getParentPath(group), nextName);
    if (!nextPath || nextPath === group) return;

    const nextGroups = normalizeNoteGroups(
      groups.map((item) => replaceGroupPrefix(item, group, nextPath) || ""),
    );
    const nextNotes = sortedNotes.map((note) => ({
      ...note,
      group: replaceGroupPrefix(note.group, group, nextPath),
    }));
    onUpdateNoteGroups(nextGroups);
    onUpdateNotes(normalizeVaultNotes(nextNotes));
    setExpandedGroups((current) => {
      const next = new Set<string>();
      current.forEach((item) => {
        const renamed = replaceGroupPrefix(item, group, nextPath);
        if (renamed) next.add(renamed);
      });
      ancestorPaths(nextPath).forEach((path) => next.add(path));
      return next;
    });
    if (selectedGroup && isInsideGroup(selectedGroup, group)) {
      setSelectedGroup(replaceGroupPrefix(selectedGroup, group, nextPath) ?? null);
    }
  };

  const deleteGroup = (group: string) => {
    onUpdateNoteGroups(groups.filter((item) => !isInsideGroup(item, group)));
    onUpdateNotes(sortedNotes.map((note) => isInsideGroup(note.group, group) ? { ...note, group: undefined } : note));
    if (selectedGroup && isInsideGroup(selectedGroup, group)) setSelectedGroup(null);
    setEditingGroupPath(null);
  };

  const moveNoteToGroup = (noteId: string, group: string | null) => {
    onUpdateNotes(normalizeVaultNotes(sortedNotes.map((note) => (
      note.id === noteId ? { ...note, group: group || undefined, updatedAt: Date.now() } : note
    ))));
  };

  const reorderNoteToNote = (sourceId: string, targetNote: VaultNote, event: React.DragEvent<HTMLElement>) => {
    if (!sourceId || sourceId === targetNote.id) return;
    const position = getDropPosition(event.currentTarget, event.clientY);
    const movedNotes = sortedNotes.map((note) => (
      note.id === sourceId
        ? { ...note, group: targetNote.group, updatedAt: Date.now() }
        : note
    ));
    onUpdateNotes(normalizeVaultNotes(reorderVaultItems(movedNotes, sourceId, targetNote.id, position)));
  };

  const moveGroupToParent = (group: string, parent: string | null) => {
    if (parent && (parent === group || parent.startsWith(`${group}/`))) return;
    const nextPath = joinGroupPath(parent, getLeafName(group));
    if (!nextPath || nextPath === group) return;
    const nextGroups = normalizeNoteGroups(groups.map((item) => replaceGroupPrefix(item, group, nextPath) || ""));
    const nextNotes = sortedNotes.map((note) => ({
      ...note,
      group: replaceGroupPrefix(note.group, group, nextPath),
    }));
    onUpdateNoteGroups(nextGroups);
    onUpdateNotes(normalizeVaultNotes(nextNotes));
    expandPath(nextPath);
    if (selectedGroup && isInsideGroup(selectedGroup, group)) {
      setSelectedGroup(replaceGroupPrefix(selectedGroup, group, nextPath) ?? null);
    }
  };

  const handleGroupDrop = (targetGroup: string | null, event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const noteId = event.dataTransfer.getData("note-id");
    const groupPath = event.dataTransfer.getData("note-group-path");
    if (noteId) moveNoteToGroup(noteId, targetGroup);
    if (groupPath) moveGroupToParent(groupPath, targetGroup);
  };

  const renderCreateGroupRow = (parent: string | null, depth: number) => {
    if (creatingGroupParent !== parent) return null;
    return (
      <div
        key={`new-folder-${parent || "root"}`}
        className="flex h-7 items-center px-2 text-sm"
        style={{ paddingLeft: depth * 16 + 4 }}
      >
        <div className="mr-1 h-5 w-4 shrink-0" />
        <div className="mr-2 flex h-5 shrink-0 items-center text-primary">
          <Folder size={14} />
        </div>
        <VaultTreeInlineRenameInput
          initialName={t("notes.action.newGroup")}
          onCommit={commitCreateGroup}
          onCancel={() => setCreatingGroupParent(undefined)}
        />
      </div>
    );
  };

  const renderNoteRow = (note: VaultNote, depth: number) => {
    if (!noteMatches(note)) return null;
    return (
      <VaultTreeItemRow
        key={note.id}
        label={note.title}
        depth={depth}
        selected={selectedNote?.id === note.id}
        editing={editingNoteId === note.id}
        editingInitialName={note.title}
        onRenameCommit={(name) => {
          setEditingNoteId(null);
          const title = name.trim();
          if (!title) return;
          saveNote({ ...note, title, updatedAt: Date.now() });
        }}
        onRenameCancel={() => setEditingNoteId(null)}
        icon={<FileText size={14} className="mr-2 shrink-0 text-muted-foreground" />}
        data-note-id={note.id}
        draggable={editingNoteId !== note.id}
        onDragStart={(event) => {
          event.dataTransfer.setData("note-id", note.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          reorderNoteToNote(event.dataTransfer.getData("note-id"), note, event);
        }}
        onClick={() => {
          setSelectedNoteId(note.id);
          setSelectedGroup(note.group || null);
          if (isSidebarMode) setOverlayNoteId(note.id);
        }}
        actions={(
          <HoverActionMenu>
            <button
              type="button"
              className={menuItemClass}
              onClick={(event) => {
                event.stopPropagation();
                setEditingNoteId(note.id);
              }}
            >
              {t("common.rename")}
            </button>
            <button
              type="button"
              className={menuItemClass}
              onClick={(event) => {
                event.stopPropagation();
                duplicateNoteById(note.id);
              }}
            >
              {t("action.copy")}
            </button>
            <button
              type="button"
              className={cn(menuItemClass, "text-destructive hover:bg-destructive/10")}
              onClick={(event) => {
                event.stopPropagation();
                deleteNoteById(note.id);
              }}
            >
              {t("action.delete")}
            </button>
          </HoverActionMenu>
        )}
      />
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
        <VaultTreeGroupRow
          name={node.name}
          depth={depth}
          expanded={expanded}
          selected={selectedGroup === node.path}
          hasChildren={hasChildren}
          editing={editingGroupPath === node.path}
          editingInitialName={node.name}
          onRenameCommit={(name) => renameGroup(node.path, name)}
          onRenameCancel={() => setEditingGroupPath(null)}
          data-note-group-path={node.path}
          draggable={editingGroupPath !== node.path}
          onDragStart={(event) => {
            event.dataTransfer.setData("note-group-path", node.path);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onDrop={(event) => handleGroupDrop(node.path, event)}
          onClick={() => {
            setSelectedGroup(node.path);
            if (hasChildren) toggleGroup(node.path);
          }}
          actions={(
            <HoverActionMenu>
              <button
                type="button"
                className={menuItemClass}
                onClick={(event) => {
                  event.stopPropagation();
                  addNoteToGroup(node.path);
                }}
              >
                {t("notes.action.newNote")}
              </button>
              <button
                type="button"
                className={menuItemClass}
                onClick={(event) => {
                  event.stopPropagation();
                  setCreatingGroupParent(node.path);
                  expandPath(node.path);
                }}
              >
                {t("notes.action.newGroup")}
              </button>
              <button
                type="button"
                className={menuItemClass}
                onClick={(event) => {
                  event.stopPropagation();
                  setEditingGroupPath(node.path);
                }}
              >
                {t("common.rename")}
              </button>
              <button
                type="button"
                className={cn(menuItemClass, "text-destructive hover:bg-destructive/10")}
                onClick={(event) => {
                  event.stopPropagation();
                  deleteGroup(node.path);
                }}
              >
                {t("action.delete")}
              </button>
            </HoverActionMenu>
          )}
        />
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

  const handleTreeResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = treeWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    setIsTreeResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const clampWidth = (value: number) =>
      Math.max(NOTES_TREE_MIN_WIDTH, Math.min(NOTES_TREE_MAX_WIDTH, value));

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setTreeWidth(clampWidth(startWidth + moveEvent.clientX - startX));
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      const nextWidth = clampWidth(startWidth + upEvent.clientX - startX);
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
  }, [persistTreeWidth, setTreeWidth, treeWidth]);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "relative flex flex-col bg-background",
            isSidebarMode ? "min-w-0 flex-1" : "shrink-0 border-r border-border/60",
          )}
          style={isSidebarMode ? undefined : { width: treeWidth }}
        >
          <div className="flex-shrink-0">
            <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-1.5 py-1">
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
          <ScrollArea className="flex-1">
            <div
              className="space-y-1 px-1.5 pb-4"
              onDragOver={(event) => {
                event.preventDefault();
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

        {!isSidebarMode && (
        <main className="flex min-w-0 flex-1 flex-col bg-background">
          {selectedNote ? (
            <>
              <div className="flex min-h-[54px] shrink-0 items-center gap-3 px-8 pt-6 pb-1">
                <div className="min-w-0 flex-1">
                  <input
                    className="h-7 w-full bg-transparent text-lg font-semibold outline-none placeholder:text-muted-foreground"
                    value={selectedNote.title}
                    placeholder={t("notes.title.placeholder")}
                    onChange={(event) => saveNote({
                      ...selectedNote,
                      title: event.target.value,
                      updatedAt: Date.now(),
                    })}
                  />
                </div>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="min-h-full w-full px-8 pt-2 pb-6">
                  <InlineMarkdownEditor
                    key={selectedNote.id}
                    value={selectedNote.content}
                    placeholder={t("notes.editor.placeholder")}
                    onChange={(content) => saveNote({
                      ...selectedNote,
                      content,
                      updatedAt: Date.now(),
                    })}
                    hosts={hosts}
                    onOpenHost={(host) => handleOpenHostFromNote(host, selectedNote.id)}
                    onOpenExternalLink={openExternal}
                  />
                </div>
              </ScrollArea>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center px-4">
              <div className="flex max-w-sm flex-col items-center text-center text-muted-foreground">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-secondary/80">
                  <Edit2 size={30} className="opacity-60" />
                </div>
                <h3 className="mb-2 text-lg font-semibold text-foreground">{t("notes.empty.title")}</h3>
                <p className="mb-4 text-sm">{t("notes.empty.desc")}</p>
                <Button onClick={addNote}>
                  <Plus size={14} className="mr-2" />
                  {t("notes.action.newNote")}
                </Button>
              </div>
            </div>
          )}
        </main>
        )}
      </div>

      {isSidebarMode && overlayNote && (
        <div className="absolute inset-0 z-30 flex min-h-0 flex-col bg-background text-foreground">
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-1.5 py-1">
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
            <div className="min-w-0 flex-1 truncate px-1 text-xs font-medium text-foreground">
              {overlayNote.title || t("notes.title.placeholder")}
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col bg-background">
            <div className="flex min-h-[54px] shrink-0 items-center px-4 pt-5 pb-1">
              <input
                className="h-7 w-full bg-transparent text-lg font-semibold outline-none placeholder:text-muted-foreground"
                value={overlayNote.title}
                placeholder={t("notes.title.placeholder")}
                onChange={(event) => saveNote({
                  ...overlayNote,
                  title: event.target.value,
                  updatedAt: Date.now(),
                })}
              />
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="min-h-full w-full px-4 pt-2 pb-6">
                <InlineMarkdownEditor
                  key={overlayNote.id}
                  value={overlayNote.content}
                  placeholder={t("notes.editor.placeholder")}
                  onChange={(content) => saveNote({
                    ...overlayNote,
                    content,
                    updatedAt: Date.now(),
                  })}
                  hosts={hosts}
                  onOpenHost={(host) => handleOpenHostFromNote(host, overlayNote.id)}
                  onOpenExternalLink={openExternal}
                />
              </div>
            </ScrollArea>
          </div>
        </div>
      )}
    </div>
  );
};
