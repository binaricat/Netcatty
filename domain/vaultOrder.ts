export type VaultOrderPosition = "before" | "after";

export interface VaultOrderedItem {
  id: string;
  order?: number;
}

const ORDER_STEP = 1000;

const isFiniteOrder = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const getVaultOrderValue = <T extends { order?: number }>(
  item: T,
  fallbackIndex: number,
): number => {
  return isFiniteOrder(item.order) ? item.order : (fallbackIndex + 1) * ORDER_STEP;
};

export const normalizeVaultOrder = <T extends { order?: number }>(
  items: readonly T[],
): T[] => {
  let changed = false;
  const usedOrders = new Set(
    items
      .map((item) => item.order)
      .filter(isFiniteOrder),
  );
  const next = items.map((item, index) => {
    if (isFiniteOrder(item.order)) return item;
    const order = (index + 1) * ORDER_STEP;
    let nextOrder = order;
    while (usedOrders.has(nextOrder)) {
      nextOrder += ORDER_STEP;
    }
    usedOrders.add(nextOrder);
    changed = true;
    return { ...item, order: nextOrder };
  });
  return changed ? next : [...items];
};

export const renumberVaultOrder = <T extends { order?: number }>(
  items: readonly T[],
): T[] => {
  return items.map((item, index) => {
    const order = (index + 1) * ORDER_STEP;
    return item.order === order ? item : { ...item, order };
  });
};

export const sortByVaultOrder = <T extends { order?: number; label?: string; id?: string }>(
  items: readonly T[],
): T[] => {
  const fallbackIndexByItem = new Map<T, number>();
  items.forEach((item, index) => fallbackIndexByItem.set(item, index));
  return [...items].sort((a, b) => {
    const orderDiff =
      getVaultOrderValue(a, fallbackIndexByItem.get(a) ?? 0) -
      getVaultOrderValue(b, fallbackIndexByItem.get(b) ?? 0);
    if (orderDiff !== 0) return orderDiff;
    const labelDiff = (a.label ?? "").localeCompare(b.label ?? "");
    if (labelDiff !== 0) return labelDiff;
    return (a.id ?? "").localeCompare(b.id ?? "");
  });
};

export const reorderVaultItems = <T extends VaultOrderedItem>(
  items: readonly T[],
  sourceId: string,
  targetId: string,
  position: VaultOrderPosition,
): T[] => {
  if (sourceId === targetId) return normalizeVaultOrder(items);

  const ordered = sortByVaultOrder(items);
  const source = ordered.find((item) => item.id === sourceId);
  const target = ordered.find((item) => item.id === targetId);
  if (!source || !target) return normalizeVaultOrder(ordered);

  const withoutSource = ordered.filter((item) => item.id !== sourceId);
  const targetIndex = withoutSource.findIndex((item) => item.id === targetId);
  if (targetIndex === -1) return normalizeVaultOrder(ordered);

  const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
  const next = [
    ...withoutSource.slice(0, insertIndex),
    source,
    ...withoutSource.slice(insertIndex),
  ];

  return renumberVaultOrder(next);
};

export const getNextVaultOrder = <T extends { order?: number }>(
  items: readonly T[],
): number => {
  const maxOrder = items.reduce((max, item, index) => {
    return Math.max(max, getVaultOrderValue(item, index));
  }, 0);
  return maxOrder + ORDER_STEP;
};

export const sortVaultStringsByOrder = (
  values: readonly string[],
  orderByValue: ReadonlyMap<string, number>,
): string[] => {
  return [...values].sort((a, b) => {
    const orderA = orderByValue.get(a);
    const orderB = orderByValue.get(b);
    if (isFiniteOrder(orderA) && isFiniteOrder(orderB) && orderA !== orderB) {
      return orderA - orderB;
    }
    if (isFiniteOrder(orderA)) return -1;
    if (isFiniteOrder(orderB)) return 1;
    return a.localeCompare(b);
  });
};

export const reorderVaultStrings = (
  values: readonly string[],
  source: string,
  target: string,
  position: VaultOrderPosition,
): string[] => {
  if (source === target) return [...values];
  const withoutSource = values.filter((value) => value !== source);
  const targetIndex = withoutSource.indexOf(target);
  if (targetIndex === -1 || !values.includes(source)) return [...values];
  const insertIndex = position === "before" ? targetIndex : targetIndex + 1;
  return [
    ...withoutSource.slice(0, insertIndex),
    source,
    ...withoutSource.slice(insertIndex),
  ];
};
