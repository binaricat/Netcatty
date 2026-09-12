import { SftpFileEntry, TransferTask } from "../../../domain/models";

export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return "--";
  const units = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
};

/**
 * Estimate remaining transfer time from bytes left and current speed.
 * Returns null when inputs are too small to be meaningful (WinSCP-style:
 * only show ETA after a stable speed sample).
 */
export function estimateTransferEtaSeconds(
  remainingBytes: number,
  speedBytesPerSec: number,
): number | null {
  if (!Number.isFinite(remainingBytes) || remainingBytes <= 0) return null;
  if (!Number.isFinite(speedBytesPerSec) || speedBytesPerSec < 1024) return null;
  const seconds = Math.ceil(remainingBytes / speedBytesPerSec);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  // Cap absurd ETAs (e.g. speed briefly dips).
  if (seconds > 48 * 3600) return null;
  return seconds;
}

export function formatTransferEta(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

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

export type SftpWindowsPathOptions = {
  /**
   * When true, treat //host/share as a Windows UNC path.
   * Default false so remote/POSIX panes keep // as a POSIX absolute path.
   */
  acceptForwardSlashUnc?: boolean;
};

export const getWindowsUncRoot = (
  path: string,
  options?: SftpWindowsPathOptions,
): string | null => {
  // Forward-slash //host/share is ambiguous: UNC on Windows panes,
  // POSIX absolute on remote/POSIX panes. A backslash can be a POSIX filename
  // character, so require an explicit opt-in for every // path.
  if (
    !options?.acceptForwardSlashUnc
    && /^\/\//.test(path)
  ) {
    return null;
  }
  const normalized = path.replace(/\//g, "\\");
  const match = normalized.match(/^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/);
  return match ? `\\\\${match[1]}\\${match[2]}` : null;
};

// Check if path is Windows-style, including network-share (UNC) paths.
export const isWindowsPath = (
  path: string,
  options?: SftpWindowsPathOptions,
): boolean => (
  /^[A-Za-z]:/.test(path) || getWindowsUncRoot(path, options) !== null
);

export type NormalizeSftpNavigationPathOptions = SftpWindowsPathOptions & {
  /**
   * Strip leading/trailing whitespace from the whole path string.
   * Default true for path-bar typing/paste; set false for programmatic
   * navigate/openEntry so directory names ending in whitespace stay intact.
   */
  trimWhitespace?: boolean;
};

/**
 * Normalize a path typed/pasted into the SFTP path bar before navigation.
 * Preserves Windows drive letters and UNC roots (e.g. \\wsl.localhost\Ubuntu-22.04\...).
 * Non-Windows paths keep or gain a leading slash.
 * Pass acceptForwardSlashUnc on Windows-style panes so //host/share becomes UNC.
 */
export const normalizeSftpNavigationPath = (
  rawPath: string,
  options?: NormalizeSftpNavigationPathOptions,
): string => {
  const prepared = options?.trimWhitespace === false ? rawPath : rawPath.trim();
  const newPath = prepared || "/";
  if (isWindowsPath(newPath, options)) {
    if (/^[A-Za-z]:[\\/]?$/.test(newPath)) {
      return `${newPath.charAt(0).toUpperCase()}:\\`;
    }
    return newPath.replace(/\//g, "\\");
  }
  return newPath.startsWith("/") ? newPath : `/${newPath}`;
};

/**
 * Derive Windows UNC opt-in from pane context (current/home paths that are
 * already unambiguously Windows: drive letter or backslash UNC).
 */
export const resolveSftpWindowsPathOptions = (
  ...hints: Array<string | null | undefined>
): SftpWindowsPathOptions => {
  for (const hint of hints) {
    if (hint && isWindowsPath(hint)) {
      return { acceptForwardSlashUnc: true };
    }
  }
  return {};
};

/**
 * Normalize bookmark / initialPath / navigate ingress using pane Windows context
 * so //host/share becomes UNC on Windows panes and stays POSIX elsewhere.
 * Does not trim: openEntry / joinPath may produce paths with meaningful trailing
 * whitespace in directory names.
 */
export const normalizeSftpPaneNavigationPath = (
  rawPath: string,
  ...contextPaths: Array<string | null | undefined>
): string => normalizeSftpNavigationPath(
  rawPath,
  {
    ...resolveSftpWindowsPathOptions(...contextPaths),
    trimWhitespace: false,
  },
);

export type SftpBreadcrumbSegment = { label: string; path: string };

/**
 * Split a current path into breadcrumb segments (label + navigable path).
 * UNC roots are kept as a single first segment (\\server\share).
 * Pure //host/share paths stay POSIX unless acceptForwardSlashUnc is set.
 */
export const getSftpBreadcrumbSegments = (
  path: string,
  options?: SftpWindowsPathOptions,
): { segments: SftpBreadcrumbSegment[]; isWindowsDrive: boolean } => {
  if (!isWindowsPath(path, options)) {
    const parts = path.split("/").filter(Boolean);
    const prefix = /^\/\/(?!\/)/.test(path) ? "//" : "/";
    return {
      segments: parts.map((part, index) => ({
        label: part,
        path: `${prefix}${parts.slice(0, index + 1).join("/")}`,
      })),
      isWindowsDrive: false,
    };
  }

  const normalized = path.replace(/\//g, "\\");
  const uncRoot = getWindowsUncRoot(normalized, options);
  if (uncRoot) {
    const rest = normalized.slice(uncRoot.length).replace(/^[\\]+/, "");
    const restParts = rest ? rest.split(/[\\]+/).filter(Boolean) : [];
    return {
      segments: [
        { label: uncRoot, path: uncRoot },
        ...restParts.map((part, index) => ({
          label: part,
          path: `${uncRoot}\\${restParts.slice(0, index + 1).join("\\")}`,
        })),
      ],
      isWindowsDrive: false,
    };
  }

  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return {
    segments: parts.map((part, index) => {
      const built = parts.slice(0, index + 1).join("\\");
      return {
        label: part,
        path: /^[A-Za-z]:$/.test(built) ? `${built}\\` : built,
      };
    }),
    isWindowsDrive: true,
  };
};

const normalizeWindowsRoot = (path: string): string => {
  const normalized = path.replace(/\//g, "\\");
  if (/^[A-Za-z]:\\$/.test(normalized)) return normalized;
  if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}\\`;
  return normalized;
};

/**
 * Filesystem root for the given path, used by the breadcrumb "go to root" affordance:
 * "/" on POSIX panes, the drive root (C:\) or UNC share root on Windows panes.
 * Returns null when no root can be derived (e.g. a relative Windows path).
 */
export const getSftpPathRoot = (
  path: string,
  options?: SftpWindowsPathOptions,
): string | null => {
  if (!isWindowsPath(path, options)) return "/";
  const normalized = path.replace(/\//g, "\\");
  const uncRoot = getWindowsUncRoot(normalized, options);
  if (uncRoot) return uncRoot;
  const drive = normalized.match(/^[A-Za-z]:/);
  return drive ? `${drive[0]}\\` : null;
};

export const isWindowsRoot = (
  path: string,
  options?: SftpWindowsPathOptions,
): boolean => {
  if (!isWindowsPath(path, options)) return false;
  const normalized = path.replace(/\//g, "\\");
  if (/^[A-Za-z]:\\?$/.test(normalized)) return true;
  const uncRoot = getWindowsUncRoot(normalized, options);
  return uncRoot !== null && normalized.replace(/[\\]+$/, "") === uncRoot;
};

export const joinPath = (base: string, name: string): string => {
  if (isWindowsPath(base)) {
    const normalizedBase = normalizeWindowsRoot(base).replace(/[\\/]+$/, "");
    return `${normalizedBase}\\${name}`;
  }
  if (base === "/") return `/${name}`;
  return `${base.replace(/\/+$/, "")}/${name}`;
};

/**
 * Join a discovered directory entry to a transfer target without allowing a
 * server-controlled filename to escape the user-selected destination root.
 * Forward slashes are the traversal's internal separators; a backslash is a
 * literal POSIX filename character but becomes a separator on Windows targets.
 *
 * Navigation treats pure //host/share as POSIX unless acceptForwardSlashUnc is
 * set, but transfer joins still apply Windows relative-path guards to
 * UNC-shaped bases so //server/share download roots cannot be escaped.
 */
export function joinTransferTargetPath(
  base: string,
  relativePath: string,
  options?: SftpWindowsPathOptions,
): string {
  const unsafe = () => {
    throw new Error(`Unsafe transfer path outside the selected destination: ${relativePath}`);
  };
  if (!relativePath || relativePath.includes("\0")) return unsafe();
  if (
    relativePath.startsWith("/")
    || relativePath.startsWith("\\")
    || /^[A-Za-z]:[\\/]/.test(relativePath)
  ) return unsafe();

  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return unsafe();

  const windowsBase = isWindowsPath(base, options);
  // Ambiguous //host/share stays POSIX for joining, but still needs Windows
  // segment guards when it matches a UNC share shape.
  const uncShapedBase = getWindowsUncRoot(base, { acceptForwardSlashUnc: true }) !== null;
  if (windowsBase || uncShapedBase) {
    if (parts.some((part) => (
      part.includes("\\")
      || part.includes(":")
      || /[. ]$/.test(part)
    ))) return unsafe();
  }
  if (windowsBase) {
    // joinPath only recognizes drive / \\UNC without opt-in; normalize
    // forward-slash UNC when the caller explicitly opted into Windows UNC.
    const joinBase = isWindowsPath(base) ? base : base.replace(/\//g, "\\");
    return joinPath(joinBase, parts.join("\\"));
  }
  return joinPath(base, parts.join("/"));
}

export const getParentPath = (
  path: string,
  options?: SftpWindowsPathOptions,
): string => {
  if (isWindowsPath(path, options)) {
    const normalized = normalizeWindowsRoot(path).replace(/[\\]+$/, "");
    const uncRoot = getWindowsUncRoot(normalized, options);
    if (uncRoot) {
      const rest = normalized.slice(uncRoot.length).replace(/^[\\]+/, "");
      const parts = rest ? rest.split(/[\\]+/).filter(Boolean) : [];
      if (parts.length <= 1) return uncRoot;
      parts.pop();
      return `${uncRoot}\\${parts.join("\\")}`;
    }
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
  if (path === "/" || path === "//") {
    return "/";
  }
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  // Match breadcrumb / path-bar: pure //host/... stays POSIX with a double-slash prefix.
  const prefix = /^\/\/(?!\/)/.test(path) ? "//" : "/";
  return parts.length ? `${prefix}${parts.join("/")}` : "/";
};

export const isConcreteTransferTargetPath = (task: Pick<TransferTask, "targetPath">): boolean => {
  const targetPath = task.targetPath.trim();
  return targetPath.length > 0 && targetPath !== "(temp)";
};

export const getFileName = (path: string): string => {
  const parts = path.split(isWindowsPath(path) ? /[\\/]/ : "/").filter(Boolean);
  return parts[parts.length - 1] || "";
};

export const normalizeSftpPathForCompare = (path: string): string => {
  if (isWindowsRoot(path)) return path.replace(/\//g, "\\").toLowerCase();
  if (isWindowsPath(path)) {
    return path.replace(/\//g, "\\").replace(/[\\]+$/, "").toLowerCase();
  }
  if (path === "/") return "/";
  return path.replace(/\/+$/, "");
};

export const isSameSftpPath = (a: string, b: string): boolean => {
  return normalizeSftpPathForCompare(a) === normalizeSftpPathForCompare(b);
};

export const isSftpDescendantPath = (candidate: string, parent: string): boolean => {
  const normalizedCandidate = normalizeSftpPathForCompare(candidate);
  const normalizedParent = normalizeSftpPathForCompare(parent);
  if (normalizedCandidate === normalizedParent) return false;

  if (/^[a-z]:\\$/.test(normalizedParent)) {
    return normalizedCandidate.startsWith(normalizedParent);
  }
  if (normalizedParent === "/") {
    return normalizedCandidate.startsWith("/");
  }

  const separator = isWindowsPath(normalizedParent) ? "\\" : "/";
  return normalizedCandidate.startsWith(`${normalizedParent}${separator}`);
};

export const shouldClearSftpFilterForPathChange = (
  currentPath: string,
  nextPath: string,
): boolean => {
  return !isSameSftpPath(currentPath, nextPath);
};

export const getSftpFilterAfterPathChange = (
  currentPath: string,
  nextPath: string,
  currentFilter: string,
): string => {
  return shouldClearSftpFilterForPathChange(currentPath, nextPath) ? "" : currentFilter;
};

export const getSftpFilterAfterPathChangeError = (
  clearFilterForPathChange: boolean,
  previousFilter: string,
  currentFilter: string,
): string => {
  return clearFilterForPathChange ? previousFilter : currentFilter;
};
