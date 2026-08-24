export interface RemoteFile {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: string;
  lastModified: string;
  linkTarget?: 'file' | 'directory' | null; // For symlinks: the type of the target, or null if broken
  permissions?: string; // rwx format for owner/group/others e.g. "rwxr-xr-x"
  owner?: string;
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
  // Whether `title` is an explicit name the user/caller chose. `false` means a
  // user rename or a named-at-creation workspace; `true`/absent means the tab
  // may derive a host-based label instead of showing the generic default.
  // Absent on legacy workspaces — the tab falls back to the default-title
  // string check for those. See resolveWorkspaceTabLabel.
  autoTitle?: boolean;
}
