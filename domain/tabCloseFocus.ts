import type { TerminalSession, Workspace } from './models';

export type RootNavigationTabId = 'vault' | 'sftp';

export function isRootNavigationTabId(
  tabId: string | null | undefined,
): tabId is RootNavigationTabId {
  return tabId === 'vault' || tabId === 'sftp';
}

function uniqueTabIds(tabIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const uniqueIds: string[] = [];
  for (const tabId of tabIds) {
    if (!tabId || seen.has(tabId)) continue;
    seen.add(tabId);
    uniqueIds.push(tabId);
  }
  return uniqueIds;
}

/**
 * Compute the visual left-to-right order of open terminal and workspace tabs
 * (visible standalone sessions + workspaces), honoring `tabOrder` with any
 * unordered tabs appended in their natural order.
 */
export function buildOrderedTerminalTabIds({
  sessions,
  workspaces,
  tabOrder = [],
}: {
  sessions: readonly TerminalSession[];
  workspaces: readonly Workspace[];
  tabOrder?: readonly string[];
}): string[] {
  const visibleStandaloneSessionIds = sessions
    .filter((session) => !session.workspaceId && !session.hiddenFromTabs)
    .map((session) => session.id);
  const workspaceIds = workspaces.map((workspace) => workspace.id);
  const allTabIds = uniqueTabIds([...visibleStandaloneSessionIds, ...workspaceIds]);
  const allTabIdSet = new Set(allTabIds);
  const orderedIds = uniqueTabIds(tabOrder.filter((id) => allTabIdSet.has(id)));
  const orderedIdSet = new Set(orderedIds);
  const remainingIds = allTabIds.filter((id) => !orderedIdSet.has(id));
  return [...orderedIds, ...remainingIds];
}

/**
 * Pick the nearest surviving adjacent tab in visual tab order, preferring the
 * immediate left neighbor and then the immediate right neighbor (matching
 * right-to-left close flow and batch/editor tab close behavior).
 */
export function resolveAdjacentTabId({
  orderedTabIdsBeforeClose = [],
  survivingTabIds,
  closedTabId,
}: {
  orderedTabIdsBeforeClose?: readonly string[];
  survivingTabIds: readonly string[];
  closedTabId: string;
}): string | undefined {
  if (survivingTabIds.length === 0) return undefined;

  const closedIndex = orderedTabIdsBeforeClose.indexOf(closedTabId);
  if (closedIndex !== -1) {
    const survivingSet = new Set(survivingTabIds);
    for (let distance = 1; distance < orderedTabIdsBeforeClose.length; distance += 1) {
      const left = orderedTabIdsBeforeClose[closedIndex - distance];
      if (left && survivingSet.has(left)) return left;
      const right = orderedTabIdsBeforeClose[closedIndex + distance];
      if (right && survivingSet.has(right)) return right;
    }
  }

  return survivingTabIds[survivingTabIds.length - 1];
}

/**
 * Resolve the next active tab after closing a terminal session tab or
 * workspace tab.
 *
 * Rules:
 * - Closing an inactive tab leaves the active tab unchanged (`null`).
 * - While other open terminal/workspace tabs remain:
 *   - Restore `preferredTabId` only if it is itself a surviving open
 *     terminal/workspace tab (preserving #2788 temporary-tab return).
 *   - Never jump back to non-terminal views (`vault`, `sftp`, plugins, etc.)
 *     while other terminal/workspace tabs are open (#4249); instead focus the
 *     nearest adjacent surviving terminal/workspace tab (left first, then right).
 * - Only when the LAST terminal/workspace tab is closed, fall back to
 *   `preferredTabId` if it is a root navigation view (`vault` or `sftp`),
 *   otherwise `vault`.
 */
export function resolveNextActiveTabAfterTerminalClose({
  currentActiveTabId,
  closedTabId,
  orderedTabIdsBeforeClose,
  survivingTabIds,
  preferredTabId,
}: {
  currentActiveTabId: string | null;
  closedTabId: string;
  orderedTabIdsBeforeClose?: readonly string[];
  survivingTabIds: readonly string[];
  preferredTabId?: string | null;
}): string | null {
  if (currentActiveTabId !== closedTabId) {
    return null;
  }

  const filteredSurvivingTabIds = survivingTabIds.filter((id) => id !== closedTabId);
  if (filteredSurvivingTabIds.length > 0) {
    if (
      preferredTabId
      && preferredTabId !== closedTabId
      && filteredSurvivingTabIds.includes(preferredTabId)
    ) {
      return preferredTabId;
    }
    return resolveAdjacentTabId({
      orderedTabIdsBeforeClose,
      survivingTabIds: filteredSurvivingTabIds,
      closedTabId,
    }) ?? 'vault';
  }

  return isRootNavigationTabId(preferredTabId) ? preferredTabId : 'vault';
}
