export type SftpArchiveFormat = "tar.gz" | "zip";

export interface SftpArchiveCreationOptions {
  directory: string;
  paths: string[];
  archiveName: string;
  format: SftpArchiveFormat;
  overwrite?: boolean;
}

export interface SftpArchiveCreationTarget {
  paneId: string;
  connectionId: string;
}

export interface SftpArchiveCreationResult {
  success: boolean;
  error?: string;
  code?: string;
}

/** Remote archive creation uses POSIX paths, as does the remote shell backend. */
function normalizeSourcePath(value: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || /[\\\0\r\n]/.test(value)) {
    throw new Error("sftp.archive.invalidSelection");
  }
  const parts = value.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error("sftp.archive.invalidSelection");
  }
  return `/${parts.join("/")}`;
}

export function prepareSftpArchiveSelection(sourcePaths: string[]): {
  directory: string;
  paths: string[];
  defaultName: string;
} {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    throw new Error("sftp.archive.invalidSelection");
  }
  const unique = [...new Set(sourcePaths.map(normalizeSourcePath))];
  // A selected directory already contains its selected descendants.
  const roots = unique.filter((entry) => !unique.some((other) => entry.startsWith(`${other}/`)));
  const parents = roots.map((entry) => entry.split("/").slice(1, -1));
  const common = [...parents[0]];
  for (const parent of parents.slice(1)) {
    let index = 0;
    while (index < common.length && common[index] === parent[index]) index += 1;
    common.length = index;
  }
  const directory = `/${common.join("/")}`;
  const prefix = directory === "/" ? "/" : `${directory}/`;
  let defaultName = roots.length === 1
    ? roots[0].slice(roots[0].lastIndexOf("/") + 1)
    : (common[common.length - 1] || "archive");
  // Do not suggest overwriting the selected archive when the format is changed.
  if (/\.(?:tar\.gz|tgz|zip)$/i.test(defaultName)) defaultName += "-archive";
  return { directory, paths: roots.map((entry) => entry.slice(prefix.length)), defaultName };
}

export function withSftpArchiveExtension(name: string, format: SftpArchiveFormat): string {
  const suffix = `.${format}`;
  if (name.toLowerCase().endsWith(suffix)) return name;
  return `${name.replace(/\.(?:tar\.gz|zip)$/i, "")}${suffix}`;
}

export function validateSftpArchiveName(name: string, format: SftpArchiveFormat): string | null {
  if (!name || !name.trim() || name === "." || name === ".." || /[/\\\0\r\n]/.test(name)) {
    return "sftp.archive.invalidName";
  }
  const suffix = `.${format}`;
  if (!name.toLowerCase().endsWith(suffix) || name.length <= suffix.length) {
    return "sftp.archive.invalidExtension";
  }
  return null;
}
