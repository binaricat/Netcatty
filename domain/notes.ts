import type { Host, VaultNote } from "./models.ts";
import { getNextVaultOrder, normalizeVaultOrder, sortByVaultOrder } from "./vaultOrder.ts";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { toString as markdownNodeToString } from "mdast-util-to-string";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";

export type { Host, VaultNote };

const cleanStringArray = (values: unknown): string[] | undefined => {
  if (!Array.isArray(values)) return undefined;
  const cleaned = Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  return cleaned.length ? cleaned : undefined;
};

export const sanitizeNoteTitle = (title: unknown): string =>
  typeof title === "string" ? title.trim() : "";

export const sanitizeVaultNote = (note: Partial<VaultNote>): VaultNote => {
  const now = Date.now();
  const createdAt =
    typeof note.createdAt === "number" && Number.isFinite(note.createdAt)
      ? note.createdAt
      : now;
  const updatedAt =
    typeof note.updatedAt === "number" && Number.isFinite(note.updatedAt)
      ? note.updatedAt
      : createdAt;

  return {
    id: typeof note.id === "string" && note.id.trim() ? note.id : crypto.randomUUID(),
    title: sanitizeNoteTitle(note.title),
    content: typeof note.content === "string" ? note.content : "",
    group: typeof note.group === "string" && note.group.trim() ? note.group.trim() : undefined,
    tags: cleanStringArray(note.tags),
    linkedHostIds: cleanStringArray(note.linkedHostIds),
    createdAt,
    updatedAt,
    order: typeof note.order === "number" && Number.isFinite(note.order) ? note.order : undefined,
    isPinned: note.isPinned ? true : undefined,
  };
};

export const normalizeVaultNotes = (notes: Partial<VaultNote>[]): VaultNote[] =>
  normalizeVaultOrder(notes.map(sanitizeVaultNote));

export const normalizeNoteGroups = (groups: unknown): string[] =>
  Array.isArray(groups)
    ? Array.from(
      new Set(
        groups
          .filter((value): value is string => typeof value === "string")
          .map((value) => cleanNoteGroupPath(value))
          .filter(Boolean),
      ),
    )
    : [];

export const cleanNoteGroupPath = (value: string): string =>
  value
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");

export const ancestorNoteGroupPaths = (path: string): string[] => {
  const parts = cleanNoteGroupPath(path).split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
};

export const getNoteGroupLeafName = (path: string): string =>
  cleanNoteGroupPath(path).split("/").pop() || cleanNoteGroupPath(path);

export const getNoteGroupParentPath = (path: string): string | null => {
  const parts = cleanNoteGroupPath(path).split("/").filter(Boolean);
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join("/");
};

export const joinNoteGroupPath = (parent: string | null, name: string): string => {
  const cleanName = cleanNoteGroupPath(name);
  if (!cleanName) return "";
  const cleanParent = parent ? cleanNoteGroupPath(parent) : "";
  return cleanParent ? `${cleanParent}/${cleanName}` : cleanName;
};

export const isNoteGroupInside = (path: string | undefined, group: string): boolean => {
  const cleanPath = path ? cleanNoteGroupPath(path) : "";
  const cleanGroup = cleanNoteGroupPath(group);
  return cleanPath === cleanGroup || Boolean(cleanPath.startsWith(`${cleanGroup}/`));
};

export const replaceNoteGroupPrefix = (path: string | undefined, from: string, to: string): string | undefined => {
  if (!path) return path;
  const cleanPath = cleanNoteGroupPath(path);
  const cleanFrom = cleanNoteGroupPath(from);
  const cleanTo = cleanNoteGroupPath(to);
  if (cleanPath === cleanFrom) return cleanTo || undefined;
  if (cleanPath.startsWith(`${cleanFrom}/`)) return cleanTo ? `${cleanTo}/${cleanPath.slice(cleanFrom.length + 1)}` : undefined;
  return cleanPath;
};

export const resolveMovedNoteGroupPath = (
  group: string,
  parent: string | null,
  groups: string[],
): string | null => {
  const source = cleanNoteGroupPath(group);
  const targetParent = parent ? cleanNoteGroupPath(parent) : null;
  if (!source) return null;
  if (targetParent && (targetParent === source || targetParent.startsWith(`${source}/`))) return null;

  const leafName = getNoteGroupLeafName(source);
  const basePath = joinNoteGroupPath(targetParent, leafName);
  if (!basePath || basePath === source) return null;

  const existingGroups = normalizeNoteGroups(groups)
    .filter((item) => !isNoteGroupInside(item, source));
  const hasConflict = (candidate: string) =>
    existingGroups.some((item) => item === candidate || item.startsWith(`${candidate}/`));

  if (!hasConflict(basePath)) return basePath;

  for (let index = 2; index < 1000; index += 1) {
    const candidate = joinNoteGroupPath(targetParent, `${leafName} ${index}`);
    if (!hasConflict(candidate)) return candidate;
  }

  return null;
};

export const remapExpandedNoteGroupPaths = (
  expandedPaths: Set<string>,
  from: string,
  to: string,
): Set<string> => {
  const next = new Set<string>();
  expandedPaths.forEach((item) => {
    const replaced = replaceNoteGroupPrefix(item, from, to);
    if (replaced) next.add(replaced);
  });
  ancestorNoteGroupPaths(to).forEach((path) => next.add(path));
  return next;
};

export const sortVaultNotes = (notes: VaultNote[]): VaultNote[] => sortByVaultOrder(notes);

export type VaultNotesExportScope =
  | { type: "all" }
  | { type: "group"; group: string };

export interface VaultNoteMarkdownExportFile {
  name: string;
  content: string;
}

const NOTE_EXPORT_UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*]/g;
const NOTE_EXPORT_RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const replaceControlFilenameChars = (value: string): string => {
  let output = "";
  for (const char of value) {
    output += char.charCodeAt(0) < 32 ? "-" : char;
  }
  return output;
};

export const sanitizeNoteExportFileNamePart = (value: string | undefined, fallback: string): string => {
  const cleaned = replaceControlFilenameChars((value ?? "").trim())
    .replace(NOTE_EXPORT_UNSAFE_FILENAME_CHARS, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim();
  const safe = cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
  const firstDotIndex = safe.indexOf(".");
  const windowsStem = (firstDotIndex >= 0 ? safe.slice(0, firstDotIndex) : safe).trimEnd();
  const extension = firstDotIndex >= 0 ? safe.slice(firstDotIndex) : "";
  const withoutReservedName = NOTE_EXPORT_RESERVED_WINDOWS_NAMES.test(windowsStem)
    ? `${windowsStem}_${extension}`
    : safe;
  return withoutReservedName.slice(0, 120) || fallback;
};

export const getVaultNotesForExportScope = (
  notes: VaultNote[],
  scope: VaultNotesExportScope = { type: "all" },
): VaultNote[] => {
  const normalized = sortVaultNotes(normalizeVaultNotes(notes));
  if (scope.type === "all") return normalized;

  const group = cleanNoteGroupPath(scope.group);
  if (!group) return [];
  return normalized.filter((note) => isNoteGroupInside(note.group, group));
};

export const buildVaultNoteMarkdownExportFiles = (
  notes: VaultNote[],
  scope: VaultNotesExportScope = { type: "all" },
): VaultNoteMarkdownExportFile[] => {
  const notesForExport = getVaultNotesForExportScope(notes, scope);
  const groupPaths = Array.from(new Set(
  notesForExport.flatMap((note) => note.group ? ancestorNoteGroupPaths(note.group) : []),
  )).sort((left, right) => {
    return left.split("/").length - right.split("/").length;
  });
  const exportedGroupSegments = new Map<string, string[]>();
  const usedDirectoryNamesByParent = new Map<string, Set<string>>();

  for (const groupPath of groupPaths) {
    const parentPath = getNoteGroupParentPath(groupPath);
    const parentSegments = parentPath ? exportedGroupSegments.get(parentPath) ?? [] : [];
    const parentKey = parentSegments.join("/").toLowerCase();
    const usedDirectoryNames = usedDirectoryNamesByParent.get(parentKey) ?? new Set<string>();
    const baseName = sanitizeNoteExportFileNamePart(getNoteGroupLeafName(groupPath), "folder");
    let candidate = baseName;
    let suffix = 2;
    while (usedDirectoryNames.has(candidate.toLowerCase())) {
      candidate = `${baseName}-${suffix}`;
      suffix += 1;
    }
    usedDirectoryNames.add(candidate.toLowerCase());
    usedDirectoryNamesByParent.set(parentKey, usedDirectoryNames);
    exportedGroupSegments.set(groupPath, [...parentSegments, candidate]);
  }

  const exportEntries = notesForExport.map((note, index) => ({
    note,
    groupSegments: note.group
      ? exportedGroupSegments.get(cleanNoteGroupPath(note.group)) ?? []
      : [],
    baseName: sanitizeNoteExportFileNamePart(note.title, `note-${index + 1}`),
  }));
  const directoryNames = new Set<string>();
  for (const { groupSegments } of exportEntries) {
    for (let depth = 1; depth <= groupSegments.length; depth += 1) {
      directoryNames.add(groupSegments.slice(0, depth).join("/").toLowerCase());
    }
  }
  const usedNames = new Set<string>();

  return exportEntries.map(({ note, groupSegments, baseName }) => {
    const basePath = [...groupSegments, baseName].join("/");
    let candidate = `${basePath}.md`;
    let suffix = 2;

    while (usedNames.has(candidate.toLowerCase()) || directoryNames.has(candidate.toLowerCase())) {
      candidate = `${basePath}-${suffix}.md`;
      suffix += 1;
    }
    usedNames.add(candidate.toLowerCase());

    return {
      name: candidate,
      content: note.content,
    };
  });
};

export const matchesVaultNoteSearch = (
  note: VaultNote,
  query: string,
  hosts: Host[] = [],
): boolean => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const linkedHosts = hosts
    .filter((host) => note.linkedHostIds?.includes(host.id))
    .map((host) => `${host.label} ${host.hostname}`)
    .join(" ");

  return [
    note.title,
    note.content,
    note.group ?? "",
    ...(note.tags ?? []),
    linkedHosts,
  ].some((value) => value.toLowerCase().includes(needle));
};

/** Build once per note-list snapshot, so typing does not lowercase full bodies. */
export const createVaultNoteSearchIndex = (notes: readonly VaultNote[]) => {
  const entries = notes.map((note) => ({
    note,
    fields: [note.title, note.content, note.group ?? "", ...(note.tags ?? [])]
      .map((value) => value.toLowerCase()),
  }));
  return (query: string): VaultNote[] => {
    const needle = query.trim().toLowerCase();
    return entries
      .filter((entry) => !needle || entry.fields.some((field) => field.includes(needle)))
      .map((entry) => entry.note);
  };
};

const isSanitizedRenderedLink = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "about:" && url.pathname === "blank";
  } catch {
    return value.trim() === "about:blank";
  }
};

const unescapeMarkdownText = (value: string): string =>
  value.replace(/\\([\\`*_[\]{}()#+\-.!|>])/g, "$1").trim();

const findInlineMarkdownLinkMatches = (markdown: string, label: string): string[] => {
  const matches: string[] = [];
  const targetLabel = label.trim();
  if (!targetLabel) return matches;

  let index = 0;
  while (index < markdown.length) {
    const labelStart = markdown.indexOf("[", index);
    if (labelStart === -1) break;
    if (labelStart > 0 && markdown[labelStart - 1] === "!") {
      index = labelStart + 1;
      continue;
    }

    let cursor = labelStart + 1;
    let escaped = false;
    let labelEnd = -1;
    for (; cursor < markdown.length; cursor += 1) {
      const char = markdown[cursor];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "]") {
        labelEnd = cursor;
        break;
      }
    }

    if (labelEnd === -1 || markdown[labelEnd + 1] !== "(") {
      index = labelStart + 1;
      continue;
    }

    const rawLabel = markdown.slice(labelStart + 1, labelEnd);
    if (unescapeMarkdownText(rawLabel) !== targetLabel) {
      index = labelEnd + 1;
      continue;
    }

    cursor = labelEnd + 2;
    while (cursor < markdown.length && /\s/.test(markdown[cursor])) cursor += 1;

    let href = "";
    if (markdown[cursor] === "<") {
      cursor += 1;
      const hrefStart = cursor;
      while (cursor < markdown.length && markdown[cursor] !== ">") cursor += 1;
      href = markdown.slice(hrefStart, cursor).trim();
    } else {
      const hrefStart = cursor;
      let depth = 0;
      escaped = false;
      for (; cursor < markdown.length; cursor += 1) {
        const char = markdown[cursor];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "(") {
          depth += 1;
          continue;
        }
        if (char === ")") {
          if (depth === 0) break;
          depth -= 1;
          continue;
        }
        if (/\s/.test(char) && depth === 0) break;
      }
      href = markdown.slice(hrefStart, cursor).trim();
    }

    if (href) matches.push(href);
    index = cursor + 1;
  }

  return matches;
};

export const resolveRenderedMarkdownLinkHref = (
  markdown: string,
  label: string,
  renderedHref: string,
): string => {
  if (!isSanitizedRenderedLink(renderedHref)) return renderedHref;

  const matches = findInlineMarkdownLinkMatches(markdown, label);
  const uniqueMatches = Array.from(new Set(matches));
  return uniqueMatches.length === 1 ? uniqueMatches[0] : renderedHref;
};

const NOTE_IMPORT_TITLE_EXTENSIONS = /\.(md|markdown|txt)$/i;

export const deriveNoteImportTitle = (fileName: string, content: string): string => {
  const heading = extractNoteHeadings(content).find((item) => item.level === 1);
  if (heading) return heading.text;

  const baseName = fileName.replace(NOTE_IMPORT_TITLE_EXTENSIONS, "").trim();
  return baseName || "Untitled note";
};

export const buildVaultNoteFromMarkdownImport = ({
  fileName,
  content,
  group,
  order,
}: {
  fileName: string;
  content: string;
  group: string | null;
  order: number;
}): VaultNote => {
  const now = Date.now();
  return sanitizeVaultNote({
    title: deriveNoteImportTitle(fileName, content),
    content,
    group: group || undefined,
    createdAt: now,
    updatedAt: now,
    order,
  });
};

export const importMarkdownPayloadsToVaultNotes = (
  payloads: Array<{ fileName: string; content: string }>,
  existingNotes: VaultNote[],
  targetGroup: string | null,
): { notes: VaultNote[]; importedCount: number } => {
  const imported: VaultNote[] = [];
  let orderBase = existingNotes;

  for (const { fileName, content } of payloads) {
    const note = buildVaultNoteFromMarkdownImport({
      fileName,
      content,
      group: targetGroup,
      order: getNextVaultOrder([...orderBase, ...imported]),
    });
    imported.push(note);
    orderBase = [...orderBase, note];
  }

  return {
    notes: normalizeVaultNotes([...existingNotes, ...imported]),
    importedCount: imported.length,
  };
};

export const importMarkdownFilesToVaultNotes = async (
  files: File[],
  existingNotes: VaultNote[],
  targetGroup: string | null,
  readFile: (file: File) => Promise<string>,
): Promise<{ notes: VaultNote[]; importedCount: number; skippedCount: number }> => {
  const payloads: Array<{ fileName: string; content: string }> = [];
  let skippedCount = 0;

  for (const file of files) {
    if (!/\.(md|markdown|txt)$/i.test(file.name)) {
      skippedCount += 1;
      continue;
    }

    payloads.push({
      fileName: file.name,
      content: await readFile(file),
    });
  }

  const { notes, importedCount } = importMarkdownPayloadsToVaultNotes(
    payloads,
    existingNotes,
    targetGroup,
  );

  return {
    notes,
    importedCount,
    skippedCount,
  };
};

export interface NoteHeadingItem {
  id: string;
  level: number;
  text: string;
  line: number;
}

export const normalizeNoteHeadingText = (value: string): string => value.replace(/\s+/g, " ").trim();

export const extractNoteHeadings = (content: string): NoteHeadingItem[] => {
  if (!content) return [];
  const headings: NoteHeadingItem[] = [];
  type AstNode = {
    type: string;
    depth?: number;
    children?: AstNode[];
    position?: { start?: { line?: number } };
  };
  const visit = (node: AstNode) => {
    if (node.type === "heading" && node.depth) {
      const text = normalizeNoteHeadingText(
        markdownNodeToString(node as Parameters<typeof markdownNodeToString>[0]),
      );
      const line = node.position?.start?.line ?? 1;
      if (text) {
        headings.push({
          id: `heading-${line - 1}-${text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")}`,
          level: node.depth,
          text,
          line,
        });
      }
    }
    node.children?.forEach(visit);
  };
  visit(
    fromMarkdown(content, {
      extensions: [gfmStrikethrough()],
      mdastExtensions: [gfmStrikethroughFromMarkdown()],
    }) as AstNode,
  );
  return headings;
};

export const extractNoteSnippet = (content: string, maxLength = 100): string => {
  if (!content) return "";
  let text = content.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^>\s+/gm, "");
  text = text.replace(/^[-*+]\s+(\[[ xX]\]\s+)?/gm, "");
  text = text.replace(/^\d+\.\s+/gm, "");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trim()}...`;
};

export const extractAllNoteTags = (notes: VaultNote[]): { tag: string; count: number }[] => {
  const map = new Map<string, number>();
  for (const note of notes) {
    if (note.tags) {
      for (const t of note.tags) {
        const clean = t.trim();
        if (clean) {
          map.set(clean, (map.get(clean) || 0) + 1);
        }
      }
    }
  }
  return Array.from(map.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
};

export type NoteSortOption =
  | "updatedDesc"
  | "updatedAsc"
  | "createdDesc"
  | "createdAsc"
  | "titleAsc"
  | "titleDesc"
  | "custom";

export type NoteFilterMode = "all" | "pinned" | "recent" | "uncategorized";

export const filterAndSortVaultNotes = (
  notes: VaultNote[],
  options: {
    search?: string;
    group?: string | null;
    tag?: string | null;
    filterMode?: NoteFilterMode;
    sort?: NoteSortOption;
    hosts?: Host[];
  } = {},
): VaultNote[] => {
  const {
    search = "",
    group = null,
    tag = null,
    filterMode = "all",
    sort = "updatedDesc",
    hosts = [],
  } = options;

  const filtered = notes.filter((note) => {
    if (filterMode === "pinned" && !note.isPinned) return false;
    if (filterMode === "uncategorized" && note.group) return false;
    if (filterMode === "recent") {
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      if (note.updatedAt < sevenDaysAgo) return false;
    }

    if (group) {
      if (!note.group || !isNoteGroupInside(note.group, group)) return false;
    }

    if (tag) {
      if (!note.tags || !note.tags.includes(tag)) return false;
    }

    if (search.trim() && !matchesVaultNoteSearch(note, search, hosts)) {
      return false;
    }

    return true;
  });

  return [...filtered].sort((a, b) => {
    if (sort !== "custom") {
      if (a.isPinned !== b.isPinned) {
        return a.isPinned ? -1 : 1;
      }
    }

    switch (sort) {
      case "updatedDesc":
        return b.updatedAt - a.updatedAt;
      case "updatedAsc":
        return a.updatedAt - b.updatedAt;
      case "createdDesc":
        return b.createdAt - a.createdAt;
      case "createdAsc":
        return a.createdAt - b.createdAt;
      case "titleAsc":
        return (a.title || "").localeCompare(b.title || "");
      case "titleDesc":
        return (b.title || "").localeCompare(a.title || "");
      case "custom":
      default:
        return (a.order ?? 0) - (b.order ?? 0);
    }
  });
};

export interface NoteStats {
  words: number;
  chars: number;
  lines: number;
}

export const calculateNoteStats = (content: string): NoteStats => {
  if (!content) return { words: 0, chars: 0, lines: 0 };
  const lines = content.split("\n").length;
  const chars = content.length;
  const cjkMatches = content.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkChars = cjkMatches ? cjkMatches.length : 0;
  const nonCjkWords = content
    .replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const words = cjkChars + nonCjkWords;
  return { words, chars, lines };
};

export type MarkdownActionType =
  | "undo"
  | "redo"
  | "bold"
  | "italic"
  | "strikethrough"
  | "underline"
  | "code"
  | "codeblock"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "quote"
  | "bullet"
  | "number"
  | "task"
  | "table"
  | "divider"
  | "link"
  | "image"
  | "math";

export interface WrapMarkdownResult {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

const formatSelectedMarkdownListLines = (
  content: string,
  marker: (index: number) => string,
): { formatted: string; selectionStartOffset: number; selectionEndOffset: number } => {
  let itemIndex = 0;
  let cursor = 0;
  let selectionStartOffset: number | null = null;
  let selectionEndOffset: number | null = null;
  const formattedLines = content.split("\n").map((line) => {
    if (!line.trim()) {
      cursor += line.length + 1;
      return line;
    }
    const prefix = marker(itemIndex);
    itemIndex += 1;
    const formattedLine = `${prefix}${line}`;
    if (selectionStartOffset === null) selectionStartOffset = cursor + prefix.length;
    selectionEndOffset = cursor + formattedLine.length;
    cursor += formattedLine.length + 1;
    return formattedLine;
  });
  return {
    formatted: formattedLines.join("\n"),
    selectionStartOffset: selectionStartOffset ?? 0,
    selectionEndOffset: selectionEndOffset ?? 0,
  };
};

export const formatMarkdownListSelection = (
  content: string,
  action: "bullet" | "number" | "task",
): string => formatSelectedMarkdownListLines(
  content,
  action === "number"
    ? (index) => `${index + 1}. `
    : action === "task"
      ? () => "- [ ] "
      : () => "- ",
).formatted;

const formatSelectedMarkdownQuoteLines = (content: string): {
  formatted: string;
  selectionStartOffset: number;
  selectionEndOffset: number;
} => {
  let cursor = 0;
  let selectionStartOffset: number | null = null;
  let selectionEndOffset: number | null = null;
  const formattedLines = content.split("\n").map((line) => {
    const prefix = line ? "> " : ">";
    const formattedLine = `${prefix}${line}`;
    if (line) {
      if (selectionStartOffset === null) selectionStartOffset = cursor + prefix.length;
      selectionEndOffset = cursor + formattedLine.length;
    }
    cursor += formattedLine.length + 1;
    return formattedLine;
  });
  return {
    formatted: formattedLines.join("\n"),
    selectionStartOffset: selectionStartOffset ?? 0,
    selectionEndOffset: selectionEndOffset ?? 0,
  };
};

export const formatMarkdownQuoteSelection = (content: string): string =>
  formatSelectedMarkdownQuoteLines(content).formatted;

export const wrapMarkdownSyntax = (
  text: string,
  start: number,
  end: number,
  action: MarkdownActionType,
): WrapMarkdownResult => {
  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);
  const selectedBlockContent = (fallback: string): string => selected.trim() ? selected : fallback;

  switch (action) {
    case "bold": {
      const content = selected || "bold text";
      return {
        text: `${before}**${content}**${after}`,
        selectionStart: start + 2,
        selectionEnd: start + 2 + content.length,
      };
    }
    case "italic": {
      const content = selected || "italic text";
      return {
        text: `${before}*${content}*${after}`,
        selectionStart: start + 1,
        selectionEnd: start + 1 + content.length,
      };
    }
    case "strikethrough": {
      const content = selected || "strikethrough text";
      return {
        text: `${before}~~${content}~~${after}`,
        selectionStart: start + 2,
        selectionEnd: start + 2 + content.length,
      };
    }
    case "underline": {
      const content = selected || "underlined text";
      return {
        text: `${before}<u>${content}</u>${after}`,
        selectionStart: start + 3,
        selectionEnd: start + 3 + content.length,
      };
    }
    case "code": {
      const content = selected || "code";
      return {
        text: `${before}\`${content}\`${after}`,
        selectionStart: start + 1,
        selectionEnd: start + 1 + content.length,
      };
    }
    case "codeblock": {
      const content = selected || "";
      const opening = "\n```bash\n";
      const insert = `${opening}${content}\n\`\`\`\n`;
      return {
        text: `${before}${insert}${after}`,
        selectionStart: start + opening.length,
        selectionEnd: start + opening.length + content.length,
      };
    }
    case "h1": {
      const content = selected || "Heading 1";
      return {
        text: `${before}\n# ${content}\n${after}`,
        selectionStart: start + 3,
        selectionEnd: start + 3 + content.length,
      };
    }
    case "h2": {
      const content = selected || "Heading 2";
      return {
        text: `${before}\n## ${content}\n${after}`,
        selectionStart: start + 4,
        selectionEnd: start + 4 + content.length,
      };
    }
    case "h3": {
      const content = selected || "Heading 3";
      return {
        text: `${before}\n### ${content}\n${after}`,
        selectionStart: start + 5,
        selectionEnd: start + 5 + content.length,
      };
    }
    case "h4": {
      const content = selected || "Heading 4";
      return {
        text: `${before}\n#### ${content}\n${after}`,
        selectionStart: start + 6,
        selectionEnd: start + 6 + content.length,
      };
    }
    case "quote": {
      const content = selectedBlockContent("Quote");
      const { formatted, selectionStartOffset, selectionEndOffset } = formatSelectedMarkdownQuoteLines(content);
      return {
        text: `${before}\n${formatted}\n${after}`,
        selectionStart: start + 1 + selectionStartOffset,
        selectionEnd: start + 1 + selectionEndOffset,
      };
    }
    case "bullet": {
      const content = selectedBlockContent("List item");
      const { formatted, selectionStartOffset, selectionEndOffset } = formatSelectedMarkdownListLines(
        content,
        () => "- ",
      );
      return {
        text: `${before}\n${formatted}\n${after}`,
        selectionStart: start + 1 + selectionStartOffset,
        selectionEnd: start + 1 + selectionEndOffset,
      };
    }
    case "number": {
      const content = selectedBlockContent("List item");
      const { formatted, selectionStartOffset, selectionEndOffset } = formatSelectedMarkdownListLines(
        content,
        (index) => `${index + 1}. `,
      );
      return {
        text: `${before}\n${formatted}\n${after}`,
        selectionStart: start + 1 + selectionStartOffset,
        selectionEnd: start + 1 + selectionEndOffset,
      };
    }
    case "task": {
      const content = selectedBlockContent("Task");
      const { formatted, selectionStartOffset, selectionEndOffset } = formatSelectedMarkdownListLines(
        content,
        () => "- [ ] ",
      );
      return {
        text: `${before}\n${formatted}\n${after}`,
        selectionStart: start + 1 + selectionStartOffset,
        selectionEnd: start + 1 + selectionEndOffset,
      };
    }
    case "divider": {
      const insert = `\n---\n`;
      return {
        text: `${before}${insert}${after}`,
        selectionStart: start + insert.length,
        selectionEnd: start + insert.length,
      };
    }
    case "table": {
      const tableMarkdown = `\n| Column 1 | Column 2 | Column 3 |\n| :--- | :--- | :--- |\n| Cell 1 | Cell 2 | Cell 3 |\n`;
      return {
        text: `${before}${tableMarkdown}${after}`,
        selectionStart: start + tableMarkdown.length,
        selectionEnd: start + tableMarkdown.length,
      };
    }
    case "link": {
      const title = selected || "Link text";
      const insert = `[${title}](https://)`;
      return {
        text: `${before}${insert}${after}`,
        selectionStart: start + title.length + 3,
        selectionEnd: start + title.length + 11,
      };
    }
    case "image": {
      const alt = selected || "Image description";
      const insert = `![${alt}](https://)`;
      return {
        text: `${before}${insert}${after}`,
        selectionStart: start + alt.length + 4,
        selectionEnd: start + alt.length + 12,
      };
    }
    case "math": {
      const content = selected || "";
      const opening = "\n```latex\n";
      const insert = `${opening}${content}\n\`\`\`\n`;
      return {
        text: `${before}${insert}${after}`,
        selectionStart: start + opening.length,
        selectionEnd: start + opening.length + content.length,
      };
    }
    default:
      return { text, selectionStart: start, selectionEnd: end };
  }
};
