import type { RemoteFile } from './models';
import { resolveInteractiveTerminalCdIntent } from './sessionRestore';
import { isAbsoluteDirectoryPath, joinDirectoryPath, labelDirectoryPath, parentDirectoryPath, type DirectoryPathFlavor } from './directoryPath';

export type DirectoryEntry = { name: string; path: string; hidden: boolean };
export type DirectoryPickerErrorCode = 'unavailable' | 'unknown' | 'busy' | 'readFailed' | 'changeFailed' | 'unsupportedPath' | 'integrationUnavailable' | 'nonFilesystem';

export class DirectoryPickerError extends Error {
  constructor(public readonly code: DirectoryPickerErrorCode) { super(code); }
}

export function isDirectoryPath(path: string | null | undefined, flavor: DirectoryPathFlavor = 'posix'): path is string {
  return isAbsoluteDirectoryPath(path, flavor);
}

export function directoryParent(path: string, flavor: DirectoryPathFlavor = 'posix'): string | null {
  return parentDirectoryPath(path, flavor);
}

export function directoryLabel(path: string, home?: string | null, flavor: DirectoryPathFlavor = 'posix'): string {
  return labelDirectoryPath(path, home, flavor);
}

export function directoryEntries(path: string, files: readonly RemoteFile[], flavor: DirectoryPathFlavor = 'posix'): DirectoryEntry[] {
  return files.filter(file => file.type === 'directory' || (file.type === 'symlink' && file.linkTarget === 'directory'))
    .flatMap(file => {
      const child = joinDirectoryPath(path, file.name, flavor);
      return child ? [{ name: file.name, path: child, hidden: file.hidden === true || file.name.startsWith('.') }] : [];
    });
}

export type DirectoryCapabilities = Readonly<{
  readCwd: boolean; listDirectories: boolean; changeDirectory: boolean; confirmChange: boolean;
}>;

export const COMPLETE_DIRECTORY_CAPABILITIES: DirectoryCapabilities = Object.freeze({
  readCwd: true, listDirectories: true, changeDirectory: true, confirmChange: true,
});

/** A shell adapter constructs input for the original interactive shell. */
export function directoryChangeCommand(path: string, shell: 'posix' | 'powershell', flavor: DirectoryPathFlavor): string | null {
  if (!isDirectoryPath(path, flavor)) return null;
  // PowerShell recognizes smart single quotes as delimiters too. Doubling
  // only ASCII apostrophes would let a filename terminate the literal.
  if (shell === 'powershell') return `Microsoft.PowerShell.Management\\Set-Location -LiteralPath '${path.replace(/['\u2018\u2019\u201a\u201b]/g, quote => quote + quote)}'`;
  return flavor === 'posix' ? resolveInteractiveTerminalCdIntent(path)?.command ?? null : null;
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
