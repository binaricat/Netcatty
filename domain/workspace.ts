import { Workspace,WorkspaceNode,WorkspaceViewMode } from './models';
import { DEFAULT_WORKSPACE_TITLE } from './sessionTabTitle';

export type SplitDirection = 'horizontal' | 'vertical';
type SplitPosition = 'left' | 'right' | 'top' | 'bottom';

export type SplitHint = {
  direction: SplitDirection;
  position: SplitPosition;
  targetSessionId?: string;
};

export const invertSplitPosition = (position: SplitPosition): SplitPosition => {
  switch (position) {
    case 'left': return 'right';
    case 'right': return 'left';
    case 'top': return 'bottom';
    case 'bottom': return 'top';
  }
};

/**
 * Root placeholder for a workspace whose member sessions have all closed.
 * Issue #4098 phase 2 keeps the workspace entity (and its id) alive at zero
 * members so restore re-links its AI chats; this empty split renders as a
 * workspace tab with no panes until a session joins again.
 */
export const createEmptyWorkspaceRoot = (): WorkspaceNode => ({
  id: crypto.randomUUID(),
  type: 'split',
  direction: 'vertical',
  children: [],
  sizes: [],
});


export const pruneWorkspaceNode = (node: WorkspaceNode, targetSessionId: string): WorkspaceNode | null => {
  if (node.type === 'pane') {
    return node.sessionId === targetSessionId ? null : node;
  }

  const nextChildren: WorkspaceNode[] = [];
  const nextSizes: number[] = [];
  const sizeList = node.sizes && node.sizes.length === node.children.length
    ? node.sizes
    : node.children.map(() => 1 / node.children.length);
  let removedDirectChild = false;

  node.children.forEach((child, idx) => {
    const pruned = pruneWorkspaceNode(child, targetSessionId);
    if (pruned) {
      nextChildren.push(pruned);
      nextSizes.push(sizeList[idx] ?? 1 / node.children.length);
    } else {
      removedDirectChild = true;
    }
  });

  if (nextChildren.length === 0) return null;
  if (nextChildren.length === 1) return nextChildren[0];

  // Only rebalance siblings to equal sizes when this level actually
  // lost one of its direct children. If the prune happened deeper in
  // one branch, this split's direct children are unchanged and their
  // original ratios must be preserved (otherwise e.g. a root 0.8/0.2
  // split gets rewritten to 0.5/0.5 when a grand-child pane closes).
  if (removedDirectChild) {
    const equalSize = 1 / nextChildren.length;
    return { ...node, children: nextChildren, sizes: nextChildren.map(() => equalSize) };
  }

  // Preserve existing ratios; normalise defensively in case sibling
  // subtrees changed shape (e.g. a split collapsed to a single pane).
  const total = nextSizes.reduce((acc, n) => acc + n, 0) || 1;
  const normalized = nextSizes.map(n => n / total);
  return { ...node, children: nextChildren, sizes: normalized };
};

/**
 * Append a new pane containing `sessionId` to the end of the workspace
 * root's split. If the root already splits in the requested direction,
 * the new pane becomes its last sibling and all sibling sizes are reset
 * to equal. Otherwise the root is wrapped in a new split (same behaviour
 * as the existing `insertPaneIntoWorkspace(root, id, { targetSessionId:
 * undefined })` path) with two equal children.
 */
export const appendPaneToWorkspaceRoot = (
  root: WorkspaceNode,
  sessionId: string,
  direction: SplitDirection = 'vertical',
): WorkspaceNode => {
  if (collectSessionIds(root).includes(sessionId)) return root;

  const newPane: WorkspaceNode = { id: crypto.randomUUID(), type: 'pane', sessionId };
  if (collectSessionIds(root).length === 0) return newPane;

  if (root.type === 'split' && root.direction === direction) {
    const nextChildren = [...root.children, newPane];
    const equalSize = 1 / nextChildren.length;
    return {
      ...root,
      children: nextChildren,
      sizes: nextChildren.map(() => equalSize),
    };
  }

  return {
    id: crypto.randomUUID(),
    type: 'split',
    direction,
    children: [root, newPane],
    sizes: [0.5, 0.5],
  };
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
  if (collectSessionIds(root).includes(sessionId)) return root;

  const pane: WorkspaceNode = { id: crypto.randomUUID(), type: 'pane', sessionId };
  if (collectSessionIds(root).length === 0) return pane;

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

/**
 * Move an existing member pane to a new position inside the same workspace
 * tree (issue #4037). The pane is pruned from its current spot (collapsing
 * the emptied parent split per `pruneWorkspaceNode` rules) and re-inserted
 * as a split sibling of the target pane on the hint's side, exactly like an
 * orphan drop would land. Pure and immutable: session ids, node identity of
 * untouched panes, focus fields and AI bindings are never touched — only the
 * tree shape changes. Returns the same `root` reference for no-ops:
 * unknown session/target, single-pane tree, or the pane dropped onto itself.
 */
export const movePaneInWorkspace = (
  root: WorkspaceNode,
  memberSessionId: string,
  hint: SplitHint,
): WorkspaceNode => {
  const paneSessionIds = collectSessionIds(root);
  if (!paneSessionIds.includes(memberSessionId)) return root;
  // A lone pane has nowhere to move within its own workspace.
  if (paneSessionIds.length <= 1) return root;
  if (hint.targetSessionId === memberSessionId) return root;
  // The target may have closed since the drag began. Validate it before
  // pruning the source so a stale drop cannot remove the dragged terminal.
  if (hint.targetSessionId && !paneSessionIds.includes(hint.targetSessionId)) return root;

  // Prune before inserting so the dragged pane is out of the tree even when
  // the drop target sits inside its old subtree. The pruned tree keeps the
  // target pane (target !== source), so the insert below always lands.
  const prunedRoot = pruneWorkspaceNode(root, memberSessionId);
  if (!prunedRoot) return root;

  return insertPaneIntoWorkspace(prunedRoot, memberSessionId, hint);
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
    title: DEFAULT_WORKSPACE_TITLE,
    focusedSessionId: baseSessionId, // Initialize with the base session focused
    focusSessionOrder: [baseSessionId, joiningSessionId],
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

export const resolveWorkspaceFocusSessionOrder = (
  root: WorkspaceNode,
  savedOrder?: string[],
): string[] => {
  const sessionIds = collectSessionIds(root);
  if (!savedOrder?.length) return sessionIds;

  const sessionIdSet = new Set(sessionIds);
  const ordered = savedOrder.filter((id, index) => (
    sessionIdSet.has(id) && savedOrder.indexOf(id) === index
  ));
  const orderedSet = new Set(ordered);
  return [...ordered, ...sessionIds.filter((id) => !orderedSet.has(id))];
};

export const reorderWorkspaceFocusSessionOrder = (
  root: WorkspaceNode,
  savedOrder: string[] | undefined,
  draggedSessionId: string,
  targetSessionId: string,
  position: 'before' | 'after' = 'before',
): string[] => {
  if (draggedSessionId === targetSessionId) {
    return resolveWorkspaceFocusSessionOrder(root, savedOrder);
  }

  const currentOrder = resolveWorkspaceFocusSessionOrder(root, savedOrder);
  const draggedIndex = currentOrder.indexOf(draggedSessionId);
  const targetIndex = currentOrder.indexOf(targetSessionId);

  if (draggedIndex === -1 || targetIndex === -1) return currentOrder;

  currentOrder.splice(draggedIndex, 1);
  let insertIndex = targetIndex;
  if (draggedIndex < targetIndex) insertIndex -= 1;
  if (position === 'after') insertIndex += 1;
  currentOrder.splice(insertIndex, 0, draggedSessionId);

  return currentOrder;
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
    /** false = the title is an explicit name; omit for an auto default title. */
    autoTitle?: boolean;
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
      autoTitle: options.autoTitle,
      viewMode: options.viewMode,
      snippetId: options.snippetId,
      focusedSessionId: sessionIds[0],
      focusSessionOrder: [sessionIds[0]],
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
    autoTitle: options.autoTitle,
    viewMode: options.viewMode,
    snippetId: options.snippetId,
    focusedSessionId: sessionIds[0],
    focusSessionOrder: sessionIds,
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
 * Deep-clone a workspace layout tree, minting fresh node ids and remapping
 * every pane's sessionId via `sessionIdMap` (old id -> new id). Split
 * `direction` and `sizes` are preserved. A sessionId absent from the map is
 * kept as-is. Pure; does not mutate `node`.
 */
export const cloneWorkspaceTree = (
  node: WorkspaceNode,
  sessionIdMap: ReadonlyMap<string, string>,
  nodeIdMap?: ReadonlyMap<string, string>,
): WorkspaceNode => {
  if (node.type === 'pane') {
    return {
      id: nodeIdMap?.get(node.id) ?? crypto.randomUUID(),
      type: 'pane',
      sessionId: sessionIdMap.get(node.sessionId) ?? node.sessionId,
    };
  }
  return {
    id: nodeIdMap?.get(node.id) ?? crypto.randomUUID(),
    type: 'split',
    direction: node.direction,
    children: node.children.map(child => cloneWorkspaceTree(child, sessionIdMap, nodeIdMap)),
    ...(node.sizes ? { sizes: [...node.sizes] } : {}),
  };
};

/**
 * Collect all session IDs from a workspace node tree.
 */
/**
 * Point a workspace's focus at `sessionId`. Returns the same array when the
 * workspace is missing or already focused there, so React state setters can
 * bail out instead of re-rendering the whole shell on every pane click/focus.
 */
export const setWorkspaceFocusedSessionId = (
  workspaces: Workspace[],
  workspaceId: string,
  sessionId: string,
): Workspace[] => {
  const index = workspaces.findIndex((ws) => ws.id === workspaceId);
  if (index < 0 || workspaces[index].focusedSessionId === sessionId) return workspaces;
  const next = workspaces.slice();
  next[index] = { ...workspaces[index], focusedSessionId: sessionId };
  return next;
};

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
