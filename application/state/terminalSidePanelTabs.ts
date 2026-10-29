import { useCallback, useEffect, useMemo, useRef } from 'react';

import {
  normalizeToolbarItemLayout,
  reorderToolbarItems,
  type ToolbarItemLayout,
  type ToolbarItemLayoutDefaults,
  type ToolbarItemPlacement,
} from '../../domain/toolbarItemLayout';
import {
  STORAGE_KEY_TERMINAL_SIDE_PANEL_TAB_LAYOUT,
  STORAGE_KEY_TERMINAL_SIDE_PANEL_TAB_ORDER,
} from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { useToolbarItemLayout } from './useToolbarItemLayout';
import { isPluginSidePanelTool, type BuiltinSidePanelTool, type SidePanelTool } from '../../domain/sidePanelLayout';

export type TerminalSidePanelTabId = SidePanelTool;

export const TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER: BuiltinSidePanelTool[] = [
  'sftp',
  'browser',
  'scripts',
  'history',
  'theme',
  'system',
  'notes',
  'ai',
];

export const TERMINAL_SIDE_PANEL_TAB_IDS = new Set<TerminalSidePanelTabId>(
  TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER,
);

export const TERMINAL_SIDE_PANEL_TAB_LAYOUT_DEFAULTS: ToolbarItemLayoutDefaults = {
  order: [...TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER],
  placement: Object.fromEntries(
    TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER.map((id) => [id, 'show' as const]),
  ),
};

/** Order-only normalizer (legacy + tests). */
export function normalizeTerminalSidePanelTabOrder(value: unknown): TerminalSidePanelTabId[] {
  return normalizeToolbarItemLayout(value, TERMINAL_SIDE_PANEL_TAB_LAYOUT_DEFAULTS)
    .order as TerminalSidePanelTabId[];
}

export function reorderTerminalSidePanelTab(
  order: TerminalSidePanelTabId[],
  draggedTab: TerminalSidePanelTabId,
  targetTab: TerminalSidePanelTabId,
  placement: 'before' | 'after' = 'before',
): TerminalSidePanelTabId[] {
  const layout: ToolbarItemLayout = {
    order,
    placement: Object.fromEntries(order.map((id) => [id, 'show' as ToolbarItemPlacement])),
  };
  return reorderToolbarItems(layout, draggedTab, targetTab, placement)
    .order as TerminalSidePanelTabId[];
}

export function fitTerminalSidePanelTabs(params: {
  shown: TerminalSidePanelTabId[];
  collapsed: TerminalSidePanelTabId[];
  active: TerminalSidePanelTabId | null;
  maxShown: number;
}): { shown: TerminalSidePanelTabId[]; collapsed: TerminalSidePanelTabId[] } {
  if (params.shown.length <= params.maxShown) {
    return { shown: params.shown, collapsed: params.collapsed };
  }

  const kept = new Set(params.shown.slice(0, Math.max(1, params.maxShown)));
  if (params.active && params.shown.includes(params.active) && !kept.has(params.active)) {
    const lastKept = [...kept].at(-1);
    if (lastKept) kept.delete(lastKept);
    kept.add(params.active);
  }
  const shown = params.shown.filter((id) => kept.has(id));
  const autoCollapsed = params.shown.filter((id) => !kept.has(id));
  return {
    shown,
    collapsed: [...autoCollapsed, ...params.collapsed.filter((id) => !autoCollapsed.includes(id))],
  };
}

/**
 * Seed the modern layout storage from the legacy order-only key when needed.
 */
function migrateSidePanelTabLayoutIfNeeded(): void {
  try {
    const modern = localStorageAdapter.read(STORAGE_KEY_TERMINAL_SIDE_PANEL_TAB_LAYOUT);
    if (modern != null) return;
    const legacy = localStorageAdapter.read(STORAGE_KEY_TERMINAL_SIDE_PANEL_TAB_ORDER);
    if (legacy == null) return;
    const layout = normalizeToolbarItemLayout(legacy, TERMINAL_SIDE_PANEL_TAB_LAYOUT_DEFAULTS);
    localStorageAdapter.write(STORAGE_KEY_TERMINAL_SIDE_PANEL_TAB_LAYOUT, layout);
  } catch {
    // Best effort.
  }
}

migrateSidePanelTabLayoutIfNeeded();

export function useTerminalSidePanelTabOrder(pluginTools: readonly SidePanelTool[] = []): {
  sidePanelTabOrder: TerminalSidePanelTabId[];
  setSidePanelTabOrder: (order: TerminalSidePanelTabId[]) => void;
  layout: ToolbarItemLayout;
  setPlacement: ReturnType<typeof useToolbarItemLayout>['setPlacement'];
  move: ReturnType<typeof useToolbarItemLayout>['move'];
  reorder: (draggedId: string, targetId: string, placement?: 'before' | 'after') => void;
  resetLayout: () => void;
  partition: ReturnType<typeof useToolbarItemLayout>['partition'];
} {
  // Keep preferences for temporarily unavailable/disabled plugins, including
  // across a cold start before the contribution catalog finishes loading.
  const knownPluginTools = useRef<Set<string> | null>(null);
  if (!knownPluginTools.current) {
    let stored: unknown;
    try { stored = localStorageAdapter.read(STORAGE_KEY_TERMINAL_SIDE_PANEL_TAB_LAYOUT); } catch { stored = null; }
    const order = stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as { order?: unknown }).order : [];
    knownPluginTools.current = new Set(Array.isArray(order)
      ? order.filter((id): id is string => typeof id === 'string' && isPluginSidePanelTool(id)) : []);
  }
  for (const tool of pluginTools) if (isPluginSidePanelTool(tool)) knownPluginTools.current.add(tool);
  const pluginKey = [...knownPluginTools.current].join('\0');
  const defaults = useMemo<ToolbarItemLayoutDefaults>(() => {
    const plugins = pluginKey ? pluginKey.split('\0') : [];
    return { order: [TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER[0], ...plugins, ...TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER.slice(1)] };
  }, [pluginKey]);
  const {
    layout,
    setPlacement,
    setOrder,
    move,
    reorder,
    reset,
    partition,
  } = useToolbarItemLayout(
    STORAGE_KEY_TERMINAL_SIDE_PANEL_TAB_LAYOUT,
    defaults,
  );

  // Newly installed plugins get a visible slot near the start even when an
  // older saved layout already exists. Existing choices always keep their order.
  const activePluginKey = pluginTools.filter(isPluginSidePanelTool).join('\0');
  useEffect(() => {
    const active = activePluginKey ? activePluginKey.split('\0') : [];
    if (!active.length || active.some((id) => !layout.order.includes(id))) return;
    let stored: unknown;
    try { stored = localStorageAdapter.read(STORAGE_KEY_TERMINAL_SIDE_PANEL_TAB_LAYOUT); } catch { return; }
    const storedOrder = stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as { order?: unknown }).order : null;
    const saved = new Set(Array.isArray(storedOrder) ? storedOrder : []);
    const fresh = active.filter((id) => !saved.has(id));
    if (!fresh.length) return;
    const rest = layout.order.filter((id) => !fresh.includes(id));
    const index = Math.max(0, rest.indexOf('sftp') + 1);
    const next = [...rest.slice(0, index), ...fresh, ...rest.slice(index)];
    if (next.some((id, i) => id !== layout.order[i])) setOrder(next);
  }, [activePluginKey, layout.order, setOrder]);

  const sidePanelTabOrder = layout.order as TerminalSidePanelTabId[];

  const setSidePanelTabOrder = useCallback(
    (order: TerminalSidePanelTabId[]) => {
      setOrder(order);
    },
    [setOrder],
  );

  return useMemo(
    () => ({
      sidePanelTabOrder,
      setSidePanelTabOrder,
      layout,
      setPlacement,
      move,
      reorder,
      resetLayout: reset,
      partition,
    }),
    [layout, move, partition, reorder, reset, setPlacement, setSidePanelTabOrder, sidePanelTabOrder],
  );
}
