import type { SftpBookmark } from "../../../domain/models";

const ROOT_PATH_RE = /^[A-Za-z]:[\\/]?$/;

export function getSftpBookmarkLabel(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "/" || ROOT_PATH_RE.test(trimmed)) return trimmed;
  return trimmed.split(/[\\/]/).filter(Boolean).pop() || trimmed;
}

export function createSftpBookmark(
  path: string,
  options: { global?: boolean; idPrefix?: string } = {},
): SftpBookmark {
  const global = options.global === true;
  const idPrefix = options.idPrefix ?? (global ? "gbm" : "bm");
  return {
    id: `${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    path,
    label: getSftpBookmarkLabel(path),
    ...(global ? { global: true } : {}),
  };
}

export function moveSftpBookmark<T extends { id: string }>(
  bookmarks: T[],
  fromId: string,
  toId: string,
): T[] {
  const from = bookmarks.findIndex((bookmark) => bookmark.id === fromId);
  const to = bookmarks.findIndex((bookmark) => bookmark.id === toId);
  if (from < 0 || to < 0 || from === to) return bookmarks;
  const next = bookmarks.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function renameSftpBookmark<T extends { id: string; label: string }>(
  bookmarks: T[],
  id: string,
  label: string,
): T[] {
  const nextLabel = label.trim();
  if (!nextLabel) return bookmarks;
  return bookmarks.map((bookmark) => (
    bookmark.id === id ? { ...bookmark, label: nextLabel } : bookmark
  ));
}
