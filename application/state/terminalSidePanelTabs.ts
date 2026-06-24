import { useCallback, useState } from 'react';

import { STORAGE_KEY_TERMINAL_SIDE_PANEL_TAB_ORDER } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

export type TerminalSidePanelTabId = 'sftp' | 'scripts' | 'history' | 'theme' | 'system' | 'notes' | 'ai';

export const TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER: TerminalSidePanelTabId[] = [
  'sftp',
  'scripts',
  'history',
  'theme',
  'system',
  'notes',
  'ai',
];

export const TERMINAL_SIDE_PANEL_TAB_IDS = new Set<TerminalSidePanelTabId>(TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER);

export function normalizeTerminalSidePanelTabOrder(value: unknown): TerminalSidePanelTabId[] {
  if (!Array.isArray(value) || value.length !== TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER.length) {
    return [...TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER];
  }

  const seen = new Set<TerminalSidePanelTabId>();
  const normalized: TerminalSidePanelTabId[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') return [...TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER];
    if (!TERMINAL_SIDE_PANEL_TAB_IDS.has(candidate as TerminalSidePanelTabId)) {
      return [...TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER];
    }
    const tab = candidate as TerminalSidePanelTabId;
    if (seen.has(tab)) return [...TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER];
    seen.add(tab);
    normalized.push(tab);
  }

  return normalized;
}

export function reorderTerminalSidePanelTab(
  order: TerminalSidePanelTabId[],
  draggedTab: TerminalSidePanelTabId,
  targetTab: TerminalSidePanelTabId,
  placement: 'before' | 'after' = 'before',
): TerminalSidePanelTabId[] {
  if (draggedTab === targetTab) return order;
  if (!order.includes(draggedTab) || !order.includes(targetTab)) return order;

  const withoutDragged = order.filter((tab) => tab !== draggedTab);
  const targetIndex = withoutDragged.indexOf(targetTab);
  if (targetIndex === -1) return order;
  const insertionIndex = placement === 'after' ? targetIndex + 1 : targetIndex;
  return [
    ...withoutDragged.slice(0, insertionIndex),
    draggedTab,
    ...withoutDragged.slice(insertionIndex),
  ];
}

function readTerminalSidePanelTabOrder(): TerminalSidePanelTabId[] {
  try {
    return normalizeTerminalSidePanelTabOrder(
      localStorageAdapter.read<TerminalSidePanelTabId[]>(STORAGE_KEY_TERMINAL_SIDE_PANEL_TAB_ORDER),
    );
  } catch {
    return [...TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER];
  }
}

function persistTerminalSidePanelTabOrder(order: TerminalSidePanelTabId[]): void {
  try {
    localStorageAdapter.write(STORAGE_KEY_TERMINAL_SIDE_PANEL_TAB_ORDER, order);
  } catch {
    // Best effort only; the toolbar still works with the in-memory order.
  }
}

export function useTerminalSidePanelTabOrder(): {
  sidePanelTabOrder: TerminalSidePanelTabId[];
  setSidePanelTabOrder: (order: TerminalSidePanelTabId[]) => void;
} {
  const [sidePanelTabOrder, setSidePanelTabOrderRaw] = useState<TerminalSidePanelTabId[]>(
    readTerminalSidePanelTabOrder,
  );

  const setSidePanelTabOrder = useCallback((order: TerminalSidePanelTabId[]) => {
    setSidePanelTabOrderRaw(order);
    persistTerminalSidePanelTabOrder(order);
  }, []);

  return { sidePanelTabOrder, setSidePanelTabOrder };
}
