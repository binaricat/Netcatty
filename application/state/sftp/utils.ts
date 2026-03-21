import { SftpFileEntry } from "../../../domain/models";

export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return "--";
  const units = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
};

export const formatDate = (timestamp: number): string => {
  if (!timestamp) return "--";
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return "--";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const getFileExtension = (name: string): string => {
  if (name === "..") return "folder";
  const ext = name.split(".").pop()?.toLowerCase();
  return ext || "file";
};

// Check if an entry is navigable like a directory (directories or symlinks pointing to directories)
export const isNavigableDirectory = (entry: SftpFileEntry): boolean => {
  return entry.type === "directory" || (entry.type === "symlink" && entry.linkTarget === "directory");
};

// Check if path is Windows-style
export const isWindowsPath = (path: string): boolean => /^[A-Za-z]:/.test(path);

const normalizeWindowsRoot = (path: string): string => {
  const normalized = path.replace(/\//g, "\\");
  if (/^[A-Za-z]:\\$/.test(normalized)) return normalized;
  if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}\\`;
  return normalized;
};

export const isWindowsRoot = (path: string): boolean => {
  if (!isWindowsPath(path)) return false;
  return /^[A-Za-z]:\\?$/.test(path.replace(/\//g, "\\"));
};

export const joinPath = (base: string, name: string): string => {
  if (isWindowsPath(base)) {
    const normalizedBase = normalizeWindowsRoot(base).replace(/[\\/]+$/, "");
    return `${normalizedBase}\\${name}`;
  }
  if (base === "/") return `/${name}`;
  return `${base}/${name}`;
};

export const getParentPath = (path: string): string => {
  if (isWindowsPath(path)) {
    const normalized = normalizeWindowsRoot(path).replace(/[\\]+$/, "");
    const drive = normalized.slice(0, 2);
    if (/^[A-Za-z]:$/.test(normalized) || /^[A-Za-z]:\\$/.test(normalized)) {
      return `${drive}\\`;
    }
    const rest = normalized.slice(2).replace(/^[\\]+/, "");
    const parts = rest ? rest.split(/[\\]+/).filter(Boolean) : [];
    if (parts.length <= 1) {
      return `${drive}\\`;
    }
    parts.pop();
    const result = `${drive}\\${parts.join("\\")}`;
    return result;
  }
  if (path === "/") {
    return "/";
  }
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  const result = parts.length ? `/${parts.join("/")}` : "/";
  return result;
};

export const getFileName = (path: string): string => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "";
};
