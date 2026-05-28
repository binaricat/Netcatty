export interface RemoteFile {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: string;
  lastModified: string;
  linkTarget?: 'file' | 'directory' | null; // For symlinks: the type of the target, or null if broken
  permissions?: string; // rwx format for owner/group/others e.g. "rwxr-xr-x"
  hidden?: boolean; // Windows hidden attribute (only set for local Windows filesystem)
}

export type WorkspaceNode =
  | {
    id: string;
    type: 'pane';
    sessionId: string;
  }
  | {
    id: string;
    type: 'split';
    direction: 'horizontal' | 'vertical';
    children: WorkspaceNode[];
    sizes?: number[]; // relative sizes for children
  };

export type WorkspaceViewMode = 'split' | 'focus';

export interface Workspace {
  id: string;
  title: string;
  root: WorkspaceNode;
  viewMode?: WorkspaceViewMode; // 'split' = tiled view (default), 'focus' = left list + single terminal
  focusedSessionId?: string; // Which session is focused when in focus mode
  focusSessionOrder?: string[]; // User-defined session order for the focus-mode sidebar
  snippetId?: string; // If this workspace was created from running a snippet
}
