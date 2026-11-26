import { directoryDisplayName, directoryLabel } from './directoryPicker';
import type { DirectoryPathFlavor } from './directoryPath';

export type ComposeDirectoryDisplay = {
  home: string | null;
  label: string;
  title: string;
  ariaPath: string;
};

/** Display only: a retained label must never be used as a live cwd. */
export function resolveComposeDirectoryDisplay(
  previous: ComposeDirectoryDisplay | null,
  cwd: string | null,
  home: string | null,
  flavor: DirectoryPathFlavor,
): ComposeDirectoryDisplay | null {
  // Native Windows nulls can mean a non-filesystem provider or integration failure.
  if (!cwd) return flavor === 'posix' ? previous : null;
  const displayHome = home ?? previous?.home ?? null;
  const ariaPath = directoryLabel(cwd, displayHome, flavor);
  return { home: displayHome, label: directoryDisplayName(ariaPath), title: directoryDisplayName(cwd), ariaPath };
}
