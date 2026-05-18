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
