import { Workspace,WorkspaceNode,WorkspaceViewMode } from './models';

export type SplitDirection = 'horizontal' | 'vertical';
type SplitPosition = 'left' | 'right' | 'top' | 'bottom';

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
    focusedSessionId: baseSessionId, // Initialize with the base session focused
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

/**
 * Find a pane node by session ID in the workspace tree.
 */
const _findPaneBySessionId = (node: WorkspaceNode, sessionId: string): WorkspaceNode | null => {
  if (node.type === 'pane') {
    return node.sessionId === sessionId ? node : null;
  }
  for (const child of node.children) {
    const found = _findPaneBySessionId(child, sessionId);
    if (found) return found;
  }
  return null;
};

/**
 * Get the path to a session in the workspace tree.
 * Returns an array of indices representing the path from root to the pane.
 */
const _getPathToSession = (node: WorkspaceNode, sessionId: string, path: number[] = []): number[] | null => {
  if (node.type === 'pane') {
    return node.sessionId === sessionId ? path : null;
  }
  for (let i = 0; i < node.children.length; i++) {
    const result = _getPathToSession(node.children[i], sessionId, [...path, i]);
    if (result) return result;
  }
  return null;
};

/**
 * Get all panes with their positions for navigation.
 */
interface PanePosition {
  sessionId: string;
  path: number[];
  // Calculated bounds (normalized 0-1)
  x: number;
  y: number;
  width: number;
  height: number;
}

const collectPanePositions = (
  node: WorkspaceNode,
  path: number[] = [],
  bounds: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: 1, height: 1 }
): PanePosition[] => {
  if (node.type === 'pane') {
    return [{
      sessionId: node.sessionId,
      path,
      ...bounds,
    }];
  }

  const positions: PanePosition[] = [];
  const sizes = node.sizes || node.children.map(() => 1 / node.children.length);
  const totalSize = sizes.reduce((a, b) => a + b, 0) || 1;
  
  let offset = 0;
  for (let i = 0; i < node.children.length; i++) {
    const sizeRatio = (sizes[i] || 1 / node.children.length) / totalSize;
    
    let childBounds: { x: number; y: number; width: number; height: number };
    if (node.direction === 'horizontal') {
      // Top/bottom split
      childBounds = {
        x: bounds.x,
        y: bounds.y + bounds.height * offset,
        width: bounds.width,
        height: bounds.height * sizeRatio,
      };
    } else {
      // Left/right split
      childBounds = {
        x: bounds.x + bounds.width * offset,
        y: bounds.y,
        width: bounds.width * sizeRatio,
        height: bounds.height,
      };
    }
    
    positions.push(...collectPanePositions(node.children[i], [...path, i], childBounds));
    offset += sizeRatio;
  }
  
  return positions;
};

export type FocusDirection = 'up' | 'down' | 'left' | 'right';

/**
 * Find the next session to focus when moving in a direction.
 * Returns the session ID to focus, or null if no valid target.
 */
export const getNextFocusSessionId = (
  root: WorkspaceNode,
  currentSessionId: string,
  direction: FocusDirection
): string | null => {
  const positions = collectPanePositions(root);
  
  const current = positions.find(p => p.sessionId === currentSessionId);
  if (!current) {
    return null;
  }

  // Filter candidates based on direction
  let candidates: PanePosition[] = [];
  const otherPanes = positions.filter(p => p.sessionId !== currentSessionId);
  
  switch (direction) {
    case 'left':
      // Find panes to the left
      candidates = otherPanes.filter(p => 
        p.x + p.width <= current.x + 0.001 // Allow small epsilon for floating point
      );
      // Wraparound: if no pane to the left, find the rightmost pane
      if (candidates.length === 0 && otherPanes.length > 0) {
        const maxX = Math.max(...otherPanes.map(p => p.x));
        candidates = otherPanes.filter(p => p.x >= maxX - 0.001);
      }
      break;
    case 'right':
      // Find panes to the right
      candidates = otherPanes.filter(p => 
        p.x >= current.x + current.width - 0.001
      );
      // Wraparound: if no pane to the right, find the leftmost pane
      if (candidates.length === 0 && otherPanes.length > 0) {
        const minX = Math.min(...otherPanes.map(p => p.x));
        candidates = otherPanes.filter(p => p.x <= minX + 0.001);
      }
      break;
    case 'up':
      // Find panes above
      candidates = otherPanes.filter(p => 
        p.y + p.height <= current.y + 0.001
      );
      // Wraparound: if no pane above, find the bottommost pane
      if (candidates.length === 0 && otherPanes.length > 0) {
        const maxY = Math.max(...otherPanes.map(p => p.y));
        candidates = otherPanes.filter(p => p.y >= maxY - 0.001);
      }
      break;
    case 'down':
      // Find panes below
      candidates = otherPanes.filter(p => 
        p.y >= current.y + current.height - 0.001
      );
      // Wraparound: if no pane below, find the topmost pane
      if (candidates.length === 0 && otherPanes.length > 0) {
        const minY = Math.min(...otherPanes.map(p => p.y));
        candidates = otherPanes.filter(p => p.y <= minY + 0.001);
      }
      break;
  }

  if (candidates.length === 0) return null;

  // Calculate center point of current pane for scoring
  const currentCenterX = current.x + current.width / 2;
  const currentCenterY = current.y + current.height / 2;

  // Find the closest candidate
  // For left/right, prefer candidates that overlap vertically
  // For up/down, prefer candidates that overlap horizontally
  let best: PanePosition | null = null;
  let bestScore = Infinity;

  for (const candidate of candidates) {
    const candidateCenterX = candidate.x + candidate.width / 2;
    const candidateCenterY = candidate.y + candidate.height / 2;
    
    let score: number;
    
    if (direction === 'left' || direction === 'right') {
      // Check vertical overlap
      const overlapTop = Math.max(current.y, candidate.y);
      const overlapBottom = Math.min(current.y + current.height, candidate.y + candidate.height);
      const hasOverlap = overlapBottom > overlapTop;
      
      // Distance is horizontal distance, but penalize if no overlap
      const distance = Math.abs(candidateCenterX - currentCenterX);
      const verticalPenalty = hasOverlap ? 0 : Math.abs(candidateCenterY - currentCenterY) * 2;
      score = distance + verticalPenalty;
    } else {
      // Check horizontal overlap
      const overlapLeft = Math.max(current.x, candidate.x);
      const overlapRight = Math.min(current.x + current.width, candidate.x + candidate.width);
      const hasOverlap = overlapRight > overlapLeft;
      
      // Distance is vertical distance, but penalize if no overlap
      const distance = Math.abs(candidateCenterY - currentCenterY);
      const horizontalPenalty = hasOverlap ? 0 : Math.abs(candidateCenterX - currentCenterX) * 2;
      score = distance + horizontalPenalty;
    }

    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best?.sessionId || null;
};
