/**
 * Shared layout model for dense toolbar regions.
 *
 * Placement:
 * - show: render inline on the toolbar
 * - collapse: render inside the ⋮ overflow menu
 * - hide: do not render
 */

export type ToolbarItemPlacement = 'show' | 'collapse' | 'hide';

export const TOOLBAR_ITEM_PLACEMENTS: readonly ToolbarItemPlacement[] = [
  'show',
  'collapse',
  'hide',
] as const;

export type ToolbarItemLayout = {
  order: string[];
  placement: Record<string, ToolbarItemPlacement>;
};

export type ToolbarItemLayoutDefaults = {
  /** Canonical item ids in default visual order. */
  order: readonly string[];
  /** Default placement per id. Missing ids default to "show". */
  placement?: Readonly<Partial<Record<string, ToolbarItemPlacement>>>;
  /**
   * Ids that cannot be hidden (or further restricted). They always stay
   * available; default placement is "show" unless defaults.placement says
   * otherwise for collapse-only locks.
   */
  lockedIds?: readonly string[];
  /**
   * When true (default), at least one available item must remain
   * show or collapse so the region never becomes empty.
   */
  requireReachable?: boolean;
};

export type ToolbarItemPartition = {
  shown: string[];
  collapsed: string[];
  hidden: string[];
};

export function isToolbarItemPlacement(value: unknown): value is ToolbarItemPlacement {
  return value === 'show' || value === 'collapse' || value === 'hide';
}

function defaultPlacementFor(
  id: string,
  defaults: ToolbarItemLayoutDefaults,
): ToolbarItemPlacement {
  const locked = defaults.lockedIds?.includes(id) ?? false;
  const configured = defaults.placement?.[id];
  if (configured && isToolbarItemPlacement(configured)) {
    if (locked && configured === 'hide') return 'show';
    return configured;
  }
  return 'show';
}

function buildDefaultLayout(defaults: ToolbarItemLayoutDefaults): ToolbarItemLayout {
  const order = [...defaults.order];
  const placement: Record<string, ToolbarItemPlacement> = {};
  for (const id of order) {
    placement[id] = defaultPlacementFor(id, defaults);
  }
  return { order, placement };
}

/**
 * Accepts:
 * - full { order, placement } objects
 * - legacy order-only arrays (all items default placement)
 * - null / garbage → defaults
 */
export function normalizeToolbarItemLayout(
  value: unknown,
  defaults: ToolbarItemLayoutDefaults,
): ToolbarItemLayout {
  const fallback = buildDefaultLayout(defaults);
  const known = new Set(defaults.order);
  if (known.size === 0) return fallback;

  let rawOrder: unknown[] | null = null;
  let rawPlacement: Record<string, unknown> | null = null;

  if (Array.isArray(value)) {
    rawOrder = value;
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.order)) rawOrder = obj.order;
    if (obj.placement && typeof obj.placement === 'object' && !Array.isArray(obj.placement)) {
      rawPlacement = obj.placement as Record<string, unknown>;
    }
  }

  if (!rawOrder) return fallback;

  const seen = new Set<string>();
  const order: string[] = [];
  for (const candidate of rawOrder) {
    if (typeof candidate !== 'string') continue;
    if (!known.has(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    order.push(candidate);
  }
  for (const id of defaults.order) {
    if (!seen.has(id)) order.push(id);
  }

  const placement: Record<string, ToolbarItemPlacement> = {};
  for (const id of order) {
    const fromRaw = rawPlacement?.[id];
    if (isToolbarItemPlacement(fromRaw)) {
      placement[id] = fromRaw;
    } else {
      placement[id] = defaultPlacementFor(id, defaults);
    }
    if ((defaults.lockedIds?.includes(id) ?? false) && placement[id] === 'hide') {
      placement[id] = defaultPlacementFor(id, defaults) === 'collapse' ? 'collapse' : 'show';
    }
  }

  return ensureReachable({ order, placement }, defaults, known);
}

function toIdSet(ids?: readonly string[] | ReadonlySet<string> | null): Set<string> | null {
  if (ids == null) return null;
  return ids instanceof Set ? ids : new Set(ids);
}

function ensureReachable(
  layout: ToolbarItemLayout,
  defaults: ToolbarItemLayoutDefaults,
  known: Set<string>,
  /**
   * When provided, reachability is computed only over currently available ids
   * (e.g. session-specific toolbar actions). Unavailable "show" entries must
   * not keep an empty visible toolbar looking "reachable".
   */
  availableIds?: readonly string[] | ReadonlySet<string> | null,
): ToolbarItemLayout {
  if (defaults.requireReachable === false) return layout;

  const available = toIdSet(availableIds);

  const isCandidate = (id: string): boolean => {
    if (!known.has(id)) return false;
    if (available && !available.has(id)) return false;
    return true;
  };

  const hasReachable = layout.order.some((id) => {
    if (!isCandidate(id)) return false;
    const p = layout.placement[id] ?? 'show';
    return p === 'show' || p === 'collapse';
  });
  if (hasReachable) return layout;

  // Prefer restoring the first always-present (available) non-locked default.
  const restoreId =
    defaults.order.find(
      (id) => isCandidate(id) && !(defaults.lockedIds?.includes(id) ?? false),
    ) ??
    defaults.order.find((id) => isCandidate(id)) ??
    defaults.order[0];
  if (!restoreId) return layout;
  return {
    order: layout.order,
    placement: {
      ...layout.placement,
      [restoreId]: 'show',
    },
  };
}

/** Split layout into shown / collapsed / hidden, optionally filtering by currently available ids. */
export function partitionToolbarItems(
  layout: ToolbarItemLayout,
  availableIds?: readonly string[] | ReadonlySet<string>,
): ToolbarItemPartition {
  const available =
    availableIds == null
      ? null
      : availableIds instanceof Set
        ? availableIds
        : new Set(availableIds);

  const shown: string[] = [];
  const collapsed: string[] = [];
  const hidden: string[] = [];

  for (const id of layout.order) {
    if (available && !available.has(id)) continue;
    const placement = layout.placement[id] ?? 'show';
    if (placement === 'show') shown.push(id);
    else if (placement === 'collapse') collapsed.push(id);
    else hidden.push(id);
  }

  return { shown, collapsed, hidden };
}

export function setToolbarItemPlacement(
  layout: ToolbarItemLayout,
  id: string,
  placement: ToolbarItemPlacement,
  defaults: ToolbarItemLayoutDefaults,
  availableIds?: readonly string[] | ReadonlySet<string> | null,
): ToolbarItemLayout {
  if (!layout.order.includes(id) && !defaults.order.includes(id)) return layout;
  if ((defaults.lockedIds?.includes(id) ?? false) && placement === 'hide') {
    return layout;
  }

  const next: ToolbarItemLayout = {
    order: layout.order.includes(id) ? layout.order : [...layout.order, id],
    placement: {
      ...layout.placement,
      [id]: placement,
    },
  };
  return ensureReachable(next, defaults, new Set(defaults.order), availableIds);
}

/**
 * Reorder `draggedId` relative to `targetId`.
 * Operates on the full order array (shown + collapsed + hidden).
 */
export function reorderToolbarItems(
  layout: ToolbarItemLayout,
  draggedId: string,
  targetId: string,
  placement: 'before' | 'after' = 'before',
): ToolbarItemLayout {
  if (draggedId === targetId) return layout;
  const order = layout.order;
  if (!order.includes(draggedId) || !order.includes(targetId)) return layout;

  const withoutDragged = order.filter((id) => id !== draggedId);
  const targetIndex = withoutDragged.indexOf(targetId);
  if (targetIndex === -1) return layout;
  const insertionIndex = placement === 'after' ? targetIndex + 1 : targetIndex;

  return {
    ...layout,
    order: [
      ...withoutDragged.slice(0, insertionIndex),
      draggedId,
      ...withoutDragged.slice(insertionIndex),
    ],
  };
}

/**
 * Move an item one step earlier/later in order.
 * When `availableIds` is set, skip unavailable neighbors so the UI reorder
 * matches the filtered customize list.
 */
export function moveToolbarItem(
  layout: ToolbarItemLayout,
  id: string,
  direction: 'earlier' | 'later',
  availableIds?: readonly string[] | ReadonlySet<string> | null,
): ToolbarItemLayout {
  const available = toIdSet(availableIds);
  const sequence = available
    ? layout.order.filter((candidate) => available.has(candidate))
    : layout.order;
  const index = sequence.indexOf(id);
  if (index === -1) return layout;
  const swapWith = direction === 'earlier' ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= sequence.length) return layout;

  const a = sequence[index];
  const b = sequence[swapWith];
  const order = layout.order.map((candidate) => {
    if (candidate === a) return b;
    if (candidate === b) return a;
    return candidate;
  });
  return { ...layout, order };
}

export function resetToolbarItemLayout(defaults: ToolbarItemLayoutDefaults): ToolbarItemLayout {
  return buildDefaultLayout(defaults);
}
