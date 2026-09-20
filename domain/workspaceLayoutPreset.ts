import {
  MAX_SIDE_PANEL_PANES,
  closeSidePanelPane,
  collectSidePanelPanes,
  getFocusedSidePanelPane,
  type SidePanelLayout,
  type SidePanelLayoutNode,
  type SidePanelTool,
} from './sidePanelLayout';

export const WORKSPACE_LAYOUT_PRESET_VERSION = 1 as const;

/**
 * Device-local snapshot of a side panel arrangement (split panes + tools)
 * the user promoted to their default. New terminal sessions apply it on
 * connect so the preferred workspace needs no manual re-setup.
 */
export type WorkspaceLayoutPreset = {
  version: typeof WORKSPACE_LAYOUT_PRESET_VERSION;
  layout: SidePanelLayout;
};

const SIDE_PANEL_TOOLS: ReadonlySet<SidePanelTool> = new Set([
  'sftp',
  'scripts',
  'history',
  'theme',
  'ai',
  'system',
  'notes',
]);

function isSidePanelTool(value: unknown): value is SidePanelTool {
  return typeof value === 'string' && SIDE_PANEL_TOOLS.has(value as SidePanelTool);
}

function sanitizeSidePanelLayoutNode(
  raw: unknown,
  seenIds: Set<string>,
): SidePanelLayoutNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const node = raw as Record<string, unknown>;
  if (typeof node.id !== 'string' || node.id.length === 0 || seenIds.has(node.id)) return null;
  seenIds.add(node.id);

  if (node.type === 'pane') {
    if (!isSidePanelTool(node.tool)) return null;
    return { id: node.id, type: 'pane', tool: node.tool };
  }

  if (node.type !== 'split') return null;
  if (node.direction !== 'horizontal' && node.direction !== 'vertical') return null;
  if (!Array.isArray(node.children) || node.children.length < 2) return null;
  if (!Array.isArray(node.sizes) || node.sizes.length !== node.children.length) return null;

  const children: SidePanelLayoutNode[] = [];
  const sizes: number[] = [];
  for (let index = 0; index < node.children.length; index += 1) {
    const child = sanitizeSidePanelLayoutNode(node.children[index], seenIds);
    if (!child) return null;
    const size = node.sizes[index];
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return null;
    children.push(child);
    sizes.push(size);
  }
  return { id: node.id, type: 'split', direction: node.direction, children, sizes };
}

/** Validate persisted/unknown data into a usable preset, or null when unusable. */
export function sanitizeWorkspaceLayoutPreset(raw: unknown): WorkspaceLayoutPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== WORKSPACE_LAYOUT_PRESET_VERSION) return null;

  const layoutRaw = value.layout;
  if (!layoutRaw || typeof layoutRaw !== 'object') return null;
  const seenIds = new Set<string>();
  const root = sanitizeSidePanelLayoutNode((layoutRaw as Record<string, unknown>).root, seenIds);
  if (!root) return null;

  const panes = collectSidePanelPanes(root);
  if (panes.length === 0 || panes.length > MAX_SIDE_PANEL_PANES) return null;
  const focusedPaneId = (layoutRaw as Record<string, unknown>).focusedPaneId;
  if (typeof focusedPaneId !== 'string' || !panes.some((pane) => pane.id === focusedPaneId)) {
    return null;
  }

  return { version: WORKSPACE_LAYOUT_PRESET_VERSION, layout: { root, focusedPaneId } };
}

/** Build a preset from a live layout, reusing the same validation as reads. */
export function createWorkspaceLayoutPreset(
  layout: SidePanelLayout,
): WorkspaceLayoutPreset | null {
  return sanitizeWorkspaceLayoutPreset({
    version: WORKSPACE_LAYOUT_PRESET_VERSION,
    layout,
  });
}

/**
 * Clone a preset layout with fresh pane/split ids so the same preset can be
 * applied to many workspaces without sharing node identities. Focus follows
 * the focused pane's ordinal position in the source layout.
 */
export function rekeySidePanelLayout(
  layout: SidePanelLayout,
  generateId: () => string,
): SidePanelLayout {
  const remap = (node: SidePanelLayoutNode): SidePanelLayoutNode => {
    if (node.type === 'pane') return { ...node, id: generateId() };
    return {
      ...node,
      id: generateId(),
      children: node.children.map(remap),
    };
  };

  const root = remap(layout.root);
  const sourcePanes = collectSidePanelPanes(layout.root);
  const sourceFocused = getFocusedSidePanelPane(layout);
  const focusedIndex = Math.max(
    0,
    sourcePanes.findIndex((pane) => pane.id === sourceFocused.id),
  );
  const focusedPaneId = collectSidePanelPanes(root)[focusedIndex]?.id ?? layout.focusedPaneId;
  return { root, focusedPaneId };
}

/**
 * Drop panes whose tool cannot work for the target session (pruning splits
 * like a manual pane close). Returns null when nothing remains.
 */
export function withoutUnavailableSidePanelTools(
  layout: SidePanelLayout,
  isToolAvailable: (tool: SidePanelTool) => boolean,
): SidePanelLayout | null {
  let current = layout;
  for (const pane of collectSidePanelPanes(layout.root)) {
    if (isToolAvailable(pane.tool)) continue;
    const next = closeSidePanelPane(current, pane.id);
    if (!next) return null;
    current = next;
  }
  return current;
}
