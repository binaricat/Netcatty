export type SidePanelTool =
  | 'sftp'
  | 'scripts'
  | 'history'
  | 'theme'
  | 'ai'
  | 'system'
  | 'notes';

export type SidePanelSplitDirection = 'horizontal' | 'vertical';

export type SidePanelPaneNode = {
  id: string;
  type: 'pane';
  tool: SidePanelTool;
};

export type SidePanelSplitNode = {
  id: string;
  type: 'split';
  direction: SidePanelSplitDirection;
  children: SidePanelLayoutNode[];
  sizes: number[];
};

export type SidePanelLayoutNode = SidePanelPaneNode | SidePanelSplitNode;

export type SidePanelLayout = {
  root: SidePanelLayoutNode;
  focusedPaneId: string;
};

export const MAX_SIDE_PANEL_PANES = 8;
export const MIN_SIDE_PANEL_PANE_PIXELS = 80;
export const MIN_SIDE_PANEL_PANE_RATIO = 0.04;
export const SIDE_PANEL_SPLIT_DIVIDER_PIXELS = 1;

export function canSplitSidePanelPaneAtSize(axisLength: number): boolean {
  return Number.isFinite(axisLength)
    && axisLength >= (
      MIN_SIDE_PANEL_PANE_PIXELS * 2 + SIDE_PANEL_SPLIT_DIVIDER_PIXELS
    );
}

export function getSidePanelNodeMinimumPixels(
  node: SidePanelLayoutNode,
  direction: SidePanelSplitDirection,
): number {
  if (node.type === 'pane') return MIN_SIDE_PANEL_PANE_PIXELS;
  const childMinimums = node.children.map((child) => (
    getSidePanelNodeMinimumPixels(child, direction)
  ));
  if (childMinimums.length === 0) return MIN_SIDE_PANEL_PANE_PIXELS;
  if (node.direction !== direction) return Math.max(...childMinimums);
  return childMinimums.reduce((sum, minimum) => sum + minimum, 0)
    + Math.max(0, node.children.length - 1) * SIDE_PANEL_SPLIT_DIVIDER_PIXELS;
}

export function getSidePanelSplitResizeBounds(
  node: SidePanelSplitNode,
  index: number,
  pairSize: number,
  axisLength: number,
): { firstMin: number; firstMax: number } {
  const ratioFor = (child: SidePanelLayoutNode) => (
    axisLength > 0
      ? Math.max(
        MIN_SIDE_PANEL_PANE_RATIO,
        getSidePanelNodeMinimumPixels(child, node.direction) / axisLength,
      )
      : MIN_SIDE_PANEL_PANE_RATIO
  );
  const firstMinimum = ratioFor(node.children[index]);
  const secondMinimum = ratioFor(node.children[index + 1]);
  const combinedMinimum = firstMinimum + secondMinimum;
  if (combinedMinimum > pairSize) {
    const scale = pairSize / combinedMinimum;
    return {
      firstMin: firstMinimum * scale,
      firstMax: pairSize - (secondMinimum * scale),
    };
  }
  return {
    firstMin: firstMinimum,
    firstMax: pairSize - secondMinimum,
  };
}

export function createSidePanelLayout(
  tool: SidePanelTool,
  paneId: string,
): SidePanelLayout {
  return {
    root: { id: paneId, type: 'pane', tool },
    focusedPaneId: paneId,
  };
}

export function collectSidePanelPanes(node: SidePanelLayoutNode): SidePanelPaneNode[] {
  if (node.type === 'pane') return [node];
  return node.children.flatMap(collectSidePanelPanes);
}

export function sidePanelLayoutHasTool(
  layout: SidePanelLayout | null | undefined,
  tool: SidePanelTool,
): boolean {
  return !!layout && collectSidePanelPanes(layout.root).some((pane) => pane.tool === tool);
}

export function getFocusedSidePanelPane(layout: SidePanelLayout): SidePanelPaneNode {
  return collectSidePanelPanes(layout.root).find((pane) => pane.id === layout.focusedPaneId)
    ?? collectSidePanelPanes(layout.root)[0];
}

export function focusSidePanelPane(
  layout: SidePanelLayout,
  paneId: string,
): SidePanelLayout {
  if (layout.focusedPaneId === paneId) return layout;
  if (!collectSidePanelPanes(layout.root).some((pane) => pane.id === paneId)) return layout;
  return { ...layout, focusedPaneId: paneId };
}

export function selectSidePanelTool(
  layout: SidePanelLayout,
  tool: SidePanelTool,
): SidePanelLayout {
  const panes = collectSidePanelPanes(layout.root);
  const occupied = panes.find((pane) => pane.tool === tool);
  if (occupied) return focusSidePanelPane(layout, occupied.id);

  const focused = getFocusedSidePanelPane(layout);
  const replace = (node: SidePanelLayoutNode): SidePanelLayoutNode => {
    if (node.type === 'pane') {
      return node.id === focused.id ? { ...node, tool } : node;
    }
    const children = node.children.map(replace);
    return children.every((child, index) => child === node.children[index])
      ? node
      : { ...node, children };
  };
  return { ...layout, root: replace(layout.root) };
}

export function splitSidePanelPane(
  layout: SidePanelLayout,
  targetPaneId: string,
  tool: SidePanelTool,
  direction: SidePanelSplitDirection,
  ids: { paneId: string; splitId: string },
  availableAxisLength: number,
): SidePanelLayout {
  const panes = collectSidePanelPanes(layout.root);
  const occupied = panes.find((pane) => pane.tool === tool);
  if (occupied) return focusSidePanelPane(layout, occupied.id);
  if (panes.length >= MAX_SIDE_PANEL_PANES) return layout;
  if (!panes.some((pane) => pane.id === targetPaneId)) return layout;
  if (!canSplitSidePanelPaneAtSize(availableAxisLength)) return layout;

  const newPane: SidePanelPaneNode = { id: ids.paneId, type: 'pane', tool };
  const insert = (node: SidePanelLayoutNode): SidePanelLayoutNode => {
    if (node.type === 'pane') {
      if (node.id !== targetPaneId) return node;
      return {
        id: ids.splitId,
        type: 'split',
        direction,
        children: [node, newPane],
        sizes: [0.5, 0.5],
      };
    }
    const children = node.children.map(insert);
    return children.every((child, index) => child === node.children[index])
      ? node
      : { ...node, children };
  };

  return {
    root: insert(layout.root),
    focusedPaneId: ids.paneId,
  };
}

function pruneSidePanelPane(
  node: SidePanelLayoutNode,
  paneId: string,
): SidePanelLayoutNode | null {
  if (node.type === 'pane') return node.id === paneId ? null : node;

  const children: SidePanelLayoutNode[] = [];
  const keptSizes: number[] = [];
  node.children.forEach((child, index) => {
    const next = pruneSidePanelPane(child, paneId);
    if (!next) return;
    children.push(next);
    keptSizes.push(node.sizes[index] ?? 1);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];

  const total = keptSizes.reduce((sum, size) => sum + Math.max(0, size), 0);
  const sizes = total > 0
    ? keptSizes.map((size) => Math.max(0, size) / total)
    : children.map(() => 1 / children.length);
  return { ...node, children, sizes };
}

export function closeSidePanelPane(
  layout: SidePanelLayout,
  paneId: string,
): SidePanelLayout | null {
  const panes = collectSidePanelPanes(layout.root);
  const removedIndex = panes.findIndex((pane) => pane.id === paneId);
  if (removedIndex < 0) return layout;
  if (panes.length === 1) return null;

  const root = pruneSidePanelPane(layout.root, paneId);
  if (!root) return null;
  const remaining = collectSidePanelPanes(root);
  const existingFocus = remaining.find((pane) => pane.id === layout.focusedPaneId);
  const fallbackIndex = Math.min(removedIndex, remaining.length - 1);
  return {
    root,
    focusedPaneId: existingFocus?.id ?? remaining[fallbackIndex].id,
  };
}

export function resizeSidePanelSplit(
  layout: SidePanelLayout,
  splitId: string,
  sizes: number[],
): SidePanelLayout {
  const patch = (node: SidePanelLayoutNode): SidePanelLayoutNode => {
    if (node.type === 'pane') return node;
    if (node.id === splitId) {
      if (sizes.length !== node.children.length || sizes.some((size) => !Number.isFinite(size) || size <= 0)) {
        return node;
      }
      const total = sizes.reduce((sum, size) => sum + size, 0);
      return { ...node, sizes: sizes.map((size) => size / total) };
    }
    const children = node.children.map(patch);
    return children.every((child, index) => child === node.children[index])
      ? node
      : { ...node, children };
  };

  const root = patch(layout.root);
  return root === layout.root ? layout : { ...layout, root };
}

export type SidePanelDockPosition = 'left' | 'right' | 'bottom';

export const SIDE_PANEL_DOCK_POSITIONS: readonly SidePanelDockPosition[] = [
  'left',
  'right',
  'bottom',
];

export function isSidePanelDockPosition(value: unknown): value is SidePanelDockPosition {
  return typeof value === 'string'
    && (SIDE_PANEL_DOCK_POSITIONS as readonly string[]).includes(value);
}

export function cycleSidePanelDockPosition(
  position: SidePanelDockPosition,
): SidePanelDockPosition {
  const index = SIDE_PANEL_DOCK_POSITIONS.indexOf(position);
  return SIDE_PANEL_DOCK_POSITIONS[(index + 1) % SIDE_PANEL_DOCK_POSITIONS.length];
}
