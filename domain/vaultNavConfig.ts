/**
 * Pure domain model for customizable Vault left sidebar navigation:
 * drag-and-drop ordering, show/hide visibility, plugin page reconciliation,
 * and fallback navigation guardrails.
 */

export type BuiltinVaultNavId =
  | 'hosts'
  | 'keys'
  | 'proxies'
  | 'port'
  | 'snippets'
  | 'notes'
  | 'knownhosts'
  | 'logs';

export type PluginVaultNavId = `plugin-vault:${string}`;

export type VaultNavItemId = BuiltinVaultNavId | PluginVaultNavId;

export type VaultNavDropPosition = 'before' | 'after';

export interface VaultNavConfig {
  /** Ordered list of Vault sidebar navigation item IDs. */
  order: VaultNavItemId[];
  /** Deduplicated list of hidden item IDs. Locked items are never hidden. */
  hidden: VaultNavItemId[];
}

export interface ReconcileVaultNavOptions {
  /**
   * When true (default), plugin-vault:* IDs not present in `activePluginIds`
   * are pruned from `order` and `hidden`. Pass false while plugin contributions
   * are still loading on cold start so saved plugin preferences survive boot.
   */
  pruneMissingPlugins?: boolean;
}

export const PLUGIN_VAULT_NAV_PREFIX = 'plugin-vault:' as const;

export const DEFAULT_BUILTIN_VAULT_NAV_ORDER: readonly BuiltinVaultNavId[] = [
  'hosts',
  'keys',
  'proxies',
  'port',
  'snippets',
  'notes',
  'knownhosts',
  'logs',
] as const;

/** Sections that cannot be hidden so the user can never lock themselves out. */
export const LOCKED_VAULT_NAV_IDS: readonly BuiltinVaultNavId[] = ['hosts'] as const;

const BUILTIN_ID_SET = new Set<string>(DEFAULT_BUILTIN_VAULT_NAV_ORDER);
const LOCKED_ID_SET = new Set<string>(LOCKED_VAULT_NAV_IDS);

export function isBuiltinVaultNavId(value: unknown): value is BuiltinVaultNavId {
  return typeof value === 'string' && BUILTIN_ID_SET.has(value);
}

export function isPluginVaultNavId(value: unknown): value is PluginVaultNavId {
  return (
    typeof value === 'string'
    && value.startsWith(PLUGIN_VAULT_NAV_PREFIX)
    && value.length > PLUGIN_VAULT_NAV_PREFIX.length
  );
}

export function isValidVaultNavItemId(value: unknown): value is VaultNavItemId {
  return isBuiltinVaultNavId(value) || isPluginVaultNavId(value);
}

export function isLockedVaultNavId(id: string): boolean {
  return LOCKED_ID_SET.has(id);
}

function dedupePluginIds(activePluginIds: readonly PluginVaultNavId[] = []): PluginVaultNavId[] {
  const seen = new Set<PluginVaultNavId>();
  const result: PluginVaultNavId[] = [];
  for (const id of activePluginIds) {
    if (!isPluginVaultNavId(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function createDefaultVaultNavConfig(
  activePluginIds: readonly PluginVaultNavId[] = [],
): VaultNavConfig {
  return {
    order: [...DEFAULT_BUILTIN_VAULT_NAV_ORDER, ...dedupePluginIds(activePluginIds)],
    hidden: [],
  };
}

function isActiveNavItem(id: VaultNavItemId, activePluginSet: ReadonlySet<string> | null): boolean {
  if (isBuiltinVaultNavId(id)) return true;
  if (!activePluginSet) return true;
  return activePluginSet.has(id);
}

function ensureAtLeastOneVisible(
  order: VaultNavItemId[],
  hidden: VaultNavItemId[],
  activePluginSet: ReadonlySet<string> | null,
): VaultNavItemId[] {
  const hiddenSet = new Set<VaultNavItemId>(hidden);
  // Locked items can never be hidden.
  for (const locked of LOCKED_VAULT_NAV_IDS) {
    hiddenSet.delete(locked);
  }

  const hasVisibleActive = order.some(
    (id) => isActiveNavItem(id, activePluginSet) && !hiddenSet.has(id),
  );
  if (!hasVisibleActive) {
    const restoreCandidate =
      order.find((id) => isActiveNavItem(id, activePluginSet) && isLockedVaultNavId(id))
      ?? order.find((id) => isActiveNavItem(id, activePluginSet))
      ?? DEFAULT_BUILTIN_VAULT_NAV_ORDER[0];
    if (restoreCandidate) {
      hiddenSet.delete(restoreCandidate);
    }
  }

  return order.filter((id) => hiddenSet.has(id));
}

/**
 * Parse and normalize persisted (potentially untrusted or legacy) config data,
 * reconciling built-in items and plugin-contributed Vault pages.
 */
export function normalizeVaultNavConfig(
  raw: unknown,
  activePluginIds: readonly PluginVaultNavId[] = [],
  options: ReconcileVaultNavOptions = {},
): VaultNavConfig {
  const pruneMissingPlugins = options.pruneMissingPlugins ?? true;
  const plugins = dedupePluginIds(activePluginIds);
  const activePluginSet = new Set<string>(plugins);

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return createDefaultVaultNavConfig(plugins);
  }

  const record = raw as Record<string, unknown>;
  const rawOrder = Array.isArray(record.order) ? record.order : [];
  const rawHidden = Array.isArray(record.hidden) ? record.hidden : [];

  const seenOrder = new Set<VaultNavItemId>();
  const order: VaultNavItemId[] = [];

  for (const candidate of rawOrder) {
    if (!isValidVaultNavItemId(candidate) || seenOrder.has(candidate)) continue;
    if (isPluginVaultNavId(candidate) && pruneMissingPlugins && !activePluginSet.has(candidate)) {
      continue;
    }
    seenOrder.add(candidate);
    order.push(candidate);
  }

  // Append any missing built-ins in canonical order.
  for (const builtinId of DEFAULT_BUILTIN_VAULT_NAV_ORDER) {
    if (!seenOrder.has(builtinId)) {
      seenOrder.add(builtinId);
      order.push(builtinId);
    }
  }

  // Append newly installed active plugin pages (visible by default).
  const newlyInstalledPlugins = new Set<VaultNavItemId>();
  for (const pluginId of plugins) {
    if (!seenOrder.has(pluginId)) {
      seenOrder.add(pluginId);
      order.push(pluginId);
      newlyInstalledPlugins.add(pluginId);
    }
  }

  const orderSet = new Set<VaultNavItemId>(order);
  const hiddenCandidates: VaultNavItemId[] = [];
  const seenHidden = new Set<VaultNavItemId>();

  for (const candidate of rawHidden) {
    if (!isValidVaultNavItemId(candidate)) continue;
    if (!orderSet.has(candidate) || seenHidden.has(candidate)) continue;
    if (isLockedVaultNavId(candidate)) continue;
    if (newlyInstalledPlugins.has(candidate)) continue;
    seenHidden.add(candidate);
    hiddenCandidates.push(candidate);
  }

  const hidden = ensureAtLeastOneVisible(order, hiddenCandidates, activePluginSet);
  return { order, hidden };
}

export function reconcileVaultNavConfig(
  config: VaultNavConfig,
  activePluginIds: readonly PluginVaultNavId[],
  options: ReconcileVaultNavOptions = {},
): VaultNavConfig {
  return normalizeVaultNavConfig(config, activePluginIds, options);
}

/**
 * Return currently active, visible nav item IDs in user-configured order.
 * Unavailable plugin IDs (e.g., while loading or disabled) are excluded from rendering.
 */
export function getVisibleVaultNavIds(
  config: VaultNavConfig,
  activePluginIds: readonly PluginVaultNavId[] = [],
): VaultNavItemId[] {
  const activePluginSet = new Set<string>(dedupePluginIds(activePluginIds));
  const hiddenSet = new Set<VaultNavItemId>(config.hidden);
  return config.order.filter(
    (id) => isActiveNavItem(id, activePluginSet) && !hiddenSet.has(id),
  );
}

/**
 * Return all currently active nav item IDs (visible and hidden) in user-configured order.
 */
export function getManageableVaultNavIds(
  config: VaultNavConfig,
  activePluginIds: readonly PluginVaultNavId[] = [],
): VaultNavItemId[] {
  const activePluginSet = new Set<string>(dedupePluginIds(activePluginIds));
  return config.order.filter((id) => isActiveNavItem(id, activePluginSet));
}

export function canHideVaultNavItem(
  config: VaultNavConfig,
  id: VaultNavItemId,
  activePluginIds: readonly PluginVaultNavId[] = [],
): boolean {
  if (isLockedVaultNavId(id)) return false;
  const visible = getVisibleVaultNavIds(config, activePluginIds);
  if (!visible.includes(id)) return true;
  return visible.length > 1;
}

export function setVaultNavItemVisibility(
  config: VaultNavConfig,
  id: VaultNavItemId,
  visible: boolean,
  activePluginIds: readonly PluginVaultNavId[] = [],
): VaultNavConfig {
  if (!config.order.includes(id)) return config;
  const hiddenSet = new Set<VaultNavItemId>(config.hidden);

  if (visible) {
    if (!hiddenSet.has(id)) return config;
    hiddenSet.delete(id);
    return {
      order: [...config.order],
      hidden: config.order.filter((itemId) => hiddenSet.has(itemId)),
    };
  }

  if (!canHideVaultNavItem(config, id, activePluginIds)) {
    return config;
  }
  if (hiddenSet.has(id)) return config;
  hiddenSet.add(id);

  const activePluginSet = new Set<string>(dedupePluginIds(activePluginIds));
  return {
    order: [...config.order],
    hidden: ensureAtLeastOneVisible(config.order, [...hiddenSet], activePluginSet),
  };
}

export function toggleVaultNavItemVisibility(
  config: VaultNavConfig,
  id: VaultNavItemId,
  activePluginIds: readonly PluginVaultNavId[] = [],
): VaultNavConfig {
  const isCurrentlyHidden = config.hidden.includes(id);
  return setVaultNavItemVisibility(config, id, isCurrentlyHidden, activePluginIds);
}

/**
 * Move `draggedId` immediately before or after `targetId` in `config.order`.
 */
export function reorderVaultNavItems(
  config: VaultNavConfig,
  draggedId: VaultNavItemId,
  targetId: VaultNavItemId,
  position: VaultNavDropPosition = 'before',
): VaultNavConfig {
  if (draggedId === targetId) return config;
  if (!config.order.includes(draggedId) || !config.order.includes(targetId)) {
    return config;
  }

  const withoutDragged = config.order.filter((id) => id !== draggedId);
  const targetIndex = withoutDragged.indexOf(targetId);
  if (targetIndex === -1) return config;

  const insertIndex = position === 'after' ? targetIndex + 1 : targetIndex;
  const nextOrder = [
    ...withoutDragged.slice(0, insertIndex),
    draggedId,
    ...withoutDragged.slice(insertIndex),
  ];

  if (nextOrder.every((id, index) => id === config.order[index])) {
    return config;
  }

  const hiddenSet = new Set<VaultNavItemId>(config.hidden);
  return {
    order: nextOrder,
    hidden: nextOrder.filter((id) => hiddenSet.has(id)),
  };
}

/**
 * Move an item one position up or down among the supplied `scopeIds`
 * (defaults to all items in `config.order`), skipping items outside `scopeIds`.
 */
export function moveVaultNavItem(
  config: VaultNavConfig,
  id: VaultNavItemId,
  direction: 'up' | 'down',
  scopeIds?: readonly VaultNavItemId[],
): VaultNavConfig {
  const scopeSet = scopeIds ? new Set<VaultNavItemId>(scopeIds) : null;
  const sequence = scopeSet
    ? config.order.filter((candidate) => scopeSet.has(candidate))
    : config.order;
  const index = sequence.indexOf(id);
  if (index === -1) return config;

  const swapIndex = direction === 'up' ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= sequence.length) return config;

  const a = sequence[index];
  const b = sequence[swapIndex];
  const nextOrder = config.order.map((candidate) => {
    if (candidate === a) return b;
    if (candidate === b) return a;
    return candidate;
  });

  const hiddenSet = new Set<VaultNavItemId>(config.hidden);
  return {
    order: nextOrder,
    hidden: nextOrder.filter((itemId) => hiddenSet.has(itemId)),
  };
}

export function resetVaultNavConfig(
  activePluginIds: readonly PluginVaultNavId[] = [],
): VaultNavConfig {
  return createDefaultVaultNavConfig(activePluginIds);
}

export function areVaultNavConfigsEqual(a: VaultNavConfig, b: VaultNavConfig): boolean {
  if (a.order.length !== b.order.length || a.hidden.length !== b.hidden.length) {
    return false;
  }
  for (let i = 0; i < a.order.length; i += 1) {
    if (a.order[i] !== b.order[i]) return false;
  }
  for (let i = 0; i < a.hidden.length; i += 1) {
    if (a.hidden[i] !== b.hidden[i]) return false;
  }
  return true;
}

export function isCustomVaultNavConfig(
  config: VaultNavConfig,
  activePluginIds: readonly PluginVaultNavId[] = [],
): boolean {
  const defaults = createDefaultVaultNavConfig(activePluginIds);
  const currentManageable = getManageableVaultNavIds(config, activePluginIds);
  if (currentManageable.length !== defaults.order.length) return true;
  for (let i = 0; i < defaults.order.length; i += 1) {
    if (currentManageable[i] !== defaults.order[i]) return true;
  }
  const activeSet = new Set<VaultNavItemId>(currentManageable);
  return config.hidden.some((id) => activeSet.has(id));
}

/**
 * Resolve the section to activate when the currently selected section becomes hidden
 * or unavailable. Prefers staying on `currentSection` if still visible; otherwise
 * falls back to the first visible section (or `'hosts'`).
 */
export function resolveFallbackVaultSection(
  currentSection: string,
  visibleIds: readonly VaultNavItemId[],
): VaultNavItemId {
  if (visibleIds.includes(currentSection as VaultNavItemId)) {
    return currentSection as VaultNavItemId;
  }
  return visibleIds[0] ?? 'hosts';
}
