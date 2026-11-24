/** Interpret paths in the terminal's filesystem namespace. */
export type DirectoryPathFlavor = 'posix' | 'win32';
export type DirectoryTarget = Readonly<{ authority: string; pathFlavor: DirectoryPathFlavor }>;

const hasControls = (value: string) => Array.from(value).some(char => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127);

function windowsPath(value: string): string { return value.replace(/\//g, '\\'); }

function windowsRoot(value: string): string | null {
  const path = windowsPath(value);
  // Device namespaces and drive-relative paths are deliberately unsupported.
  if (/^\\\\[?.]\\/.test(path)) return null;
  const drive = /^[a-z]:\\/i.exec(path);
  if (drive) return drive[0];
  return /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.exec(path)?.[0].replace(/\\?$/, '\\') ?? null;
}

export function isAbsoluteDirectoryPath(value: string | null | undefined, flavor: DirectoryPathFlavor): value is string {
  if (typeof value !== 'string' || !value || hasControls(value)) return false;
  if (flavor === 'posix') return value.startsWith('/');
  if (!windowsRoot(value)) return false;
  // Win32 normalizes these names (including trailing dots/spaces). Reject
  // ambiguous spellings rather than confirming a different directory.
  return !/[<>"|?*]/.test(value) && !value.slice(2).includes(':')
    && !windowsPath(value).split('\\').some(part => /[. ]$/.test(part) && part !== '.' && part !== '..');
}

function withoutTrailingSeparators(value: string, flavor: DirectoryPathFlavor): string {
  if (flavor === 'posix') return value.replace(/\/+$/, '') || '/';
  const path = windowsPath(value);
  const root = windowsRoot(path);
  const trimmed = path.replace(/\\+$/, '');
  return root && trimmed.length < root.length ? root : trimmed;
}

export function parentDirectoryPath(value: string, flavor: DirectoryPathFlavor): string | null {
  if (!isAbsoluteDirectoryPath(value, flavor)) return null;
  const path = withoutTrailingSeparators(value, flavor);
  const root = flavor === 'posix' ? '/' : windowsRoot(path)!;
  if (path === root) return null;
  const parent = path.slice(0, path.lastIndexOf(flavor === 'posix' ? '/' : '\\'));
  return parent.length < root.length ? root : parent;
}

export function joinDirectoryPath(base: string, name: string, flavor: DirectoryPathFlavor): string | null {
  if (!isAbsoluteDirectoryPath(base, flavor) || !name || name === '.' || name === '..'
    || name.includes('/') || (flavor === 'win32' && name.includes('\\'))) return null;
  const separator = flavor === 'posix' ? '/' : '\\';
  const trimmed = withoutTrailingSeparators(base, flavor);
  const result = trimmed + (trimmed.endsWith(separator) ? '' : separator) + name;
  // POSIX filenames may contain control bytes. Keep them as display data;
  // isAbsoluteDirectoryPath still rejects sending those bytes to a PTY.
  return flavor === 'posix' || isAbsoluteDirectoryPath(result, flavor) ? result : null;
}

/** Preserve case-sensitive Windows directory names. */
export function sameDirectoryPath(a: string, b: string, flavor: DirectoryPathFlavor): boolean {
  return isAbsoluteDirectoryPath(a, flavor) && isAbsoluteDirectoryPath(b, flavor)
    && withoutTrailingSeparators(a, flavor) === withoutTrailingSeparators(b, flavor);
}

export function sameDirectoryTarget(a: DirectoryTarget, b: DirectoryTarget): boolean {
  return a.authority === b.authority && a.pathFlavor === b.pathFlavor;
}

export function labelDirectoryPath(value: string, home: string | null | undefined, flavor: DirectoryPathFlavor): string {
  if (!home || !isAbsoluteDirectoryPath(value, flavor) || !isAbsoluteDirectoryPath(home, flavor)) return value;
  const path = flavor === 'posix' ? value : windowsPath(value);
  const prefix = withoutTrailingSeparators(home, flavor);
  if (sameDirectoryPath(path, prefix, flavor)) return '~';
  const boundary = prefix.endsWith(flavor === 'posix' ? '/' : '\\') ? prefix : prefix + (flavor === 'posix' ? '/' : '\\');
  return path.startsWith(boundary) ? '~' + (flavor === 'posix' ? '/' : '\\') + path.slice(boundary.length) : value;
}
