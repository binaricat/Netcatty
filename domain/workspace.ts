import { Workspace, WorkspaceNode, WorkspaceViewMode } from './models';

export type SplitDirection = 'horizontal' | 'vertical';
export type SplitPosition = 'left' | 'right' | 'top' | 'bottom';

export type SplitHint = {
  direction: SplitDirection;
  position: SplitPosition;
  targetSessionId?: string;
};

export const pruneWorkspaceNode = (node: WorkspaceNode, targetSessionId: string): WorkspaceNode | null => {
  if (node.type === 'pane') {
    return node.sessionId === targetSessionId ? null : node;
  }

  const nextChildren: WorkspaceNode[] = [];
  const nextSizes: number[] = [];
  const sizeList = node.sizes && node.sizes.length === node.children.length ? node.sizes : node.children.map(() => 1);

  node.children.forEach((child, idx) => {
    const pruned = pruneWorkspaceNode(child, targetSessionId);
    if (pruned) {
      nextChildren.push(pruned);
      nextSizes.push(sizeList[idx] ?? 1);
    }
  });

  if (nextChildren.length === 0) return null;
  if (nextChildren.length === 1) return nextChildren[0];

  const total = nextSizes.reduce((acc, n) => acc + n, 0) || 1;
  const normalized = nextSizes.map(n => n / total);
  return { ...node, children: nextChildren, sizes: normalized };
};

const createSplitFromPane = (
  existingPane: WorkspaceNode,
  newPane: WorkspaceNode,
  hint: SplitHint
): WorkspaceNode => {
  const children = (hint.position === 'left' || hint.position === 'top') ? [newPane, existingPane] : [existingPane, newPane];
  return {
    id: crypto.randomUUID(),
    type: 'split',
    direction: hint.direction,
    children,
    sizes: [1, 1],
  };
};

export const insertPaneIntoWorkspace = (
  root: WorkspaceNode,
  sessionId: string,
  hint: SplitHint
): WorkspaceNode => {
  const pane: WorkspaceNode = { id: crypto.randomUUID(), type: 'pane', sessionId };

  if (!hint.targetSessionId) {
    const children = (hint.position === 'left' || hint.position === 'top') ? [pane, root] : [root, pane];
    return {
      id: crypto.randomUUID(),
      type: 'split',
      direction: hint.direction,
      children,
      sizes: [1, 1],
    };
  }

  const insertPane = (node: WorkspaceNode): WorkspaceNode => {
    if (node.type === 'pane' && node.sessionId === hint.targetSessionId) {
      return createSplitFromPane(node, pane, hint);
    }
    if (node.type === 'split') {
      return { ...node, children: node.children.map(child => insertPane(child)) };
    }
    return node;
  };

  return insertPane(root);
};

export const createWorkspaceFromSessions = (
  baseSessionId: string,
  joiningSessionId: string,
  hint: SplitHint
): Workspace => {
  const basePane: WorkspaceNode = { id: crypto.randomUUID(), type: 'pane', sessionId: baseSessionId };
  const newPane: WorkspaceNode = { id: crypto.randomUUID(), type: 'pane', sessionId: joiningSessionId };
  const children = (hint.position === 'left' || hint.position === 'top') ? [newPane, basePane] : [basePane, newPane];

  return {
    id: `ws-${crypto.randomUUID()}`,
    title: 'Workspace',
    root: {
      id: crypto.randomUUID(),
      type: 'split',
      direction: hint.direction,
      children,
      sizes: [1, 1],
    },
  };
};

export const updateWorkspaceSplitSizes = (
  root: WorkspaceNode,
  splitId: string,
  sizes: number[]
): WorkspaceNode => {
  const patch = (node: WorkspaceNode): WorkspaceNode => {
    if (node.type === 'split') {
      if (node.id === splitId) {
        return { ...node, sizes };
      }
      return { ...node, children: node.children.map(child => patch(child)) };
    }
    return node;
  };
  return patch(root);
};

/**
 * Create a workspace from multiple session IDs.
 * Used for snippet runner - creates a workspace with all sessions in a horizontal split.
 */
export const createWorkspaceFromSessionIds = (
  sessionIds: string[],
  options: {
    title: string;
    viewMode?: WorkspaceViewMode;
    snippetId?: string;
  }
): Workspace => {
  if (sessionIds.length === 0) {
    throw new Error('Cannot create workspace with no sessions');
  }

  if (sessionIds.length === 1) {
    // Single pane workspace
    return {
      id: `ws-${crypto.randomUUID()}`,
      title: options.title,
      viewMode: options.viewMode,
      snippetId: options.snippetId,
      focusedSessionId: sessionIds[0],
      root: {
        id: crypto.randomUUID(),
        type: 'pane',
        sessionId: sessionIds[0],
      },
    };
  }

  // Multiple sessions - create a horizontal split
  const children: WorkspaceNode[] = sessionIds.map(sessionId => ({
    id: crypto.randomUUID(),
    type: 'pane' as const,
    sessionId,
  }));

  return {
    id: `ws-${crypto.randomUUID()}`,
    title: options.title,
    viewMode: options.viewMode,
    snippetId: options.snippetId,
    focusedSessionId: sessionIds[0],
    root: {
      id: crypto.randomUUID(),
      type: 'split',
      direction: 'vertical', // Side by side
      children,
      sizes: children.map(() => 1),
    },
  };
};

/**
 * Collect all session IDs from a workspace node tree.
 */
export const collectSessionIds = (node: WorkspaceNode): string[] => {
  if (node.type === 'pane') {
    return [node.sessionId];
  }
  return node.children.flatMap(child => collectSessionIds(child));
};
