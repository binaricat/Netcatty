import { STORAGE_KEY_WORKSPACE_LAYOUT_PRESET } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import {
  sanitizeWorkspaceLayoutPreset,
  type WorkspaceLayoutPreset,
} from '../../domain/workspaceLayoutPreset';

/**
 * Saved default workspace side panel layout. Device-local only: it is not
 * part of the sync payload because pane arrangements are client-side chrome.
 */
export function readWorkspaceLayoutPreset(): WorkspaceLayoutPreset | null {
  return sanitizeWorkspaceLayoutPreset(localStorageAdapter.read(STORAGE_KEY_WORKSPACE_LAYOUT_PRESET));
}

export function writeWorkspaceLayoutPreset(preset: WorkspaceLayoutPreset): boolean {
  return localStorageAdapter.write(STORAGE_KEY_WORKSPACE_LAYOUT_PRESET, preset);
}
