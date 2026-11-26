import type { PluginWorkbenchShortcut } from './types';

export interface KeyboardShortcutLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Normalize global workbench shortcuts pressed inside plugin views/widgets.
 * Returns null for unrecognized key combinations.
 */
export function matchWorkbenchShortcut(
  event: KeyboardShortcutLike,
  options?: { includeUndoRedo?: boolean },
): PluginWorkbenchShortcut | null {
  const includeUndoRedo = options?.includeUndoRedo ?? true;
  if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    return 'escape';
  }
  const mod = Boolean(event.metaKey || event.ctrlKey);
  if (!mod || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'k' && !event.shiftKey) return 'mod+k';
  if (key === 's' && !event.shiftKey) return 'mod+s';
  if (key === 't' && !event.shiftKey) return 'mod+t';
  if (key === 'w' && !event.shiftKey) return 'mod+w';
  if (includeUndoRedo) {
    if (key === 'z' && event.shiftKey) return 'mod+shift+z';
    if (key === 'z' && !event.shiftKey) return 'mod+z';
    if (key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey) return 'mod+shift+z';
  }
  return null;
}
