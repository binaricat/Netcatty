export const WORKSPACE_SESSION_DRAG_TYPE = 'application/x-netcatty-workspace-session';

type DataTransferLike = {
  types: DOMStringList | readonly string[];
  getData: (format: string) => string;
};

export function dataTransferHasType(dataTransfer: Pick<DataTransferLike, 'types'>, type: string): boolean {
  return Array.prototype.includes.call(dataTransfer.types, type);
}

export function hasWorkspaceSessionDrag(dataTransfer: Pick<DataTransferLike, 'types'>): boolean {
  return dataTransferHasType(dataTransfer, WORKSPACE_SESSION_DRAG_TYPE);
}

export function getWorkspaceSessionDragId(dataTransfer: DataTransferLike): string {
  return dataTransfer.getData(WORKSPACE_SESSION_DRAG_TYPE) || dataTransfer.getData('session-id');
}

export function isPointInsideRect(
  point: { clientX: number; clientY: number },
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
): boolean {
  return point.clientX >= rect.left
    && point.clientX <= rect.right
    && point.clientY >= rect.top
    && point.clientY <= rect.bottom;
}

export type TopTabInsertionTarget = {
  tabId: string;
  position: 'before' | 'after';
};

export function getTopTabInsertionTarget(
  point: { clientX: number; clientY: number },
  topTabsRoot: HTMLElement | null,
): TopTabInsertionTarget | null {
  if (!topTabsRoot || !isPointInsideRect(point, topTabsRoot.getBoundingClientRect())) return null;

  const tabs = Array.from(topTabsRoot.querySelectorAll<HTMLElement>('[data-tab-id]'))
    .filter((tab) => tab.dataset.tabType !== 'root');

  if (tabs.length === 0) return null;

  for (const tab of tabs) {
    const rect = tab.getBoundingClientRect();
    const midpoint = rect.left + rect.width / 2;
    const tabId = tab.dataset.tabId;
    if (!tabId) continue;
    if (point.clientX <= midpoint) {
      return { tabId, position: 'before' };
    }
    if (point.clientX <= rect.right) {
      return { tabId, position: 'after' };
    }
  }

  const lastTab = tabs[tabs.length - 1];
  const lastTabId = lastTab?.dataset.tabId;
  return lastTabId ? { tabId: lastTabId, position: 'after' } : null;
}
