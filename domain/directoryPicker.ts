import type { RemoteFile } from './models';
import { resolveInteractiveTerminalCdIntent } from './sessionRestore';

export type DirectoryEntry = { name: string; path: string; hidden: boolean };
export type DirectoryPickerErrorCode = 'unavailable' | 'unknown' | 'busy' | 'readFailed' | 'changeFailed' | 'unsupportedPath';

export class DirectoryPickerError extends Error {
  constructor(public readonly code: DirectoryPickerErrorCode) { super(code); }
}

export function isDirectoryPath(path: string | null | undefined): path is string {
  return typeof path === 'string' && path.startsWith('/') && !!resolveInteractiveTerminalCdIntent(path);
}

export function directoryParent(path: string): string | null {
  const trimmed = path.replace(/\/+$/, '') || '/';
  return trimmed === '/' ? null : trimmed.slice(0, trimmed.lastIndexOf('/')) || '/';
}

export function directoryLabel(path: string, home?: string | null): string {
  const prefix = home?.replace(/\/+$/, '');
  if (prefix && (path === prefix || path.startsWith(prefix + '/'))) return '~' + path.slice(prefix.length);
  return path;
}

export function directoryEntries(path: string, files: readonly RemoteFile[]): DirectoryEntry[] {
  return files.filter(file => file.type === 'directory' || (file.type === 'symlink' && file.linkTarget === 'directory'))
    .filter(file => file.name !== '.' && file.name !== '..' && !file.name.includes('/') && file.name.length > 0)
    .map(file => ({ name: file.name, path: (path === '/' ? '' : path.replace(/\/+$/, '')) + '/' + file.name,
      hidden: file.hidden === true || file.name.startsWith('.') }));
}

const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function filterDirectories(entries: readonly DirectoryEntry[], query: string, showHidden: boolean): DirectoryEntry[] {
  const needle = query.toLocaleLowerCase();
  return entries.filter(entry => (showHidden || !entry.hidden) && entry.name.toLocaleLowerCase().includes(needle))
    .sort((a, b) => names.compare(a.name, b.name) || a.name.localeCompare(b.name));
}

/** Control characters remain visible as data rather than affecting menu layout. */
export function directoryDisplayName(name: string): string {
  return Array.from(name, char => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127
    ? '\\x' + char.charCodeAt(0).toString(16).padStart(2, '0') : char).join('');
}
