import { useCallback, useMemo } from 'react';

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

export type TerminalSidePanelTabId =
  | 'sftp'
  | 'scripts'
  | 'history'
  | 'theme'
  | 'system'
  | 'notes'
  | 'ai';

export const TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER: TerminalSidePanelTabId[] = [
  'sftp',
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

export function useTerminalSidePanelTabOrder(): {
  sidePanelTabOrder: TerminalSidePanelTabId[];
  setSidePanelTabOrder: (order: TerminalSidePanelTabId[]) => void;
  layout: ToolbarItemLayout;
  setPlacement: ReturnType<typeof useToolbarItemLayout>['setPlacement'];
  move: ReturnType<typeof useToolbarItemLayout>['move'];
  reorder: (draggedId: string, targetId: string, placement?: 'before' | 'after') => void;
  resetLayout: () => void;
  partition: ReturnType<typeof useToolbarItemLayout>['partition'];
} {
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
    TERMINAL_SIDE_PANEL_TAB_LAYOUT_DEFAULTS,
  );

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
