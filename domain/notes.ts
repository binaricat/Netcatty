import type { Host, VaultNote } from "./models";
import { normalizeVaultOrder, sortByVaultOrder } from "./vaultOrder";

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

export const sanitizeNoteTitle = (title: unknown): string => {
  const value = typeof title === "string" ? title.trim() : "";
  return value || "Untitled note";
};

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
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    )
    : [];

export const sortVaultNotes = (notes: VaultNote[]): VaultNote[] => sortByVaultOrder(notes);

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
