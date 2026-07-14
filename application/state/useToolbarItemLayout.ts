import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  moveToolbarItem,
  normalizeToolbarItemLayout,
  partitionToolbarItems,
  reorderToolbarItems,
  resetToolbarItemLayout,
  setToolbarItemPlacement,
  type ToolbarItemLayout,
  type ToolbarItemLayoutDefaults,
  type ToolbarItemPartition,
  type ToolbarItemPlacement,
} from '../../domain/toolbarItemLayout';
import {
  LOCAL_STORAGE_ADAPTER_CHANGED_EVENT,
  localStorageAdapter,
} from '../../infrastructure/persistence/localStorageAdapter';

export type UseToolbarItemLayoutResult = {
  layout: ToolbarItemLayout;
  partition: (availableIds?: readonly string[] | ReadonlySet<string>) => ToolbarItemPartition;
  setPlacement: (
    id: string,
    placement: ToolbarItemPlacement,
    availableIds?: readonly string[] | ReadonlySet<string> | null,
  ) => ToolbarItemLayout;
  /** Replace full order while preserving placements (normalized against defaults). */
  setOrder: (order: string[]) => void;
  reorder: (draggedId: string, targetId: string, placement?: 'before' | 'after') => void;
  move: (
    id: string,
    direction: 'earlier' | 'later',
    availableIds?: readonly string[] | ReadonlySet<string> | null,
  ) => void;
  reset: () => void;
};

function readLayout(storageKey: string, defaults: ToolbarItemLayoutDefaults): ToolbarItemLayout {
  try {
    return normalizeToolbarItemLayout(localStorageAdapter.read(storageKey), defaults);
  } catch {
    return resetToolbarItemLayout(defaults);
  }
}

function writeLayout(storageKey: string, layout: ToolbarItemLayout): void {
  try {
    localStorageAdapter.write(storageKey, layout);
  } catch {
    // Best effort; in-memory state still applies for the session.
  }
}

/**
 * Persist show / collapse / hide + order for a dense toolbar region.
 * `defaults` should be a stable reference (module-level const).
 */
export function useToolbarItemLayout(
  storageKey: string,
  defaults: ToolbarItemLayoutDefaults,
): UseToolbarItemLayoutResult {
  const [layout, setLayout] = useState<ToolbarItemLayout>(() => readLayout(storageKey, defaults));

  useEffect(() => {
    const sync = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== storageKey) return;
      if (event instanceof CustomEvent && event.detail?.key !== storageKey) return;
      setLayout(readLayout(storageKey, defaults));
    };
    window.addEventListener('storage', sync);
    window.addEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, sync);
    };
  }, [defaults, storageKey]);

  const commit = useCallback(
    (next: ToolbarItemLayout) => {
      setLayout(next);
      writeLayout(storageKey, next);
    },
    [storageKey],
  );

  const setPlacement = useCallback(
    (
      id: string,
      placement: ToolbarItemPlacement,
      availableIds?: readonly string[] | ReadonlySet<string> | null,
    ): ToolbarItemLayout => {
      let nextLayout!: ToolbarItemLayout;
      setLayout((current) => {
        nextLayout = setToolbarItemPlacement(current, id, placement, defaults, availableIds);
        writeLayout(storageKey, nextLayout);
        return nextLayout;
      });
      return nextLayout;
    },
    [defaults, storageKey],
  );

  const setOrder = useCallback(
    (order: string[]) => {
      setLayout((current) => {
        const next = normalizeToolbarItemLayout(
          { order, placement: current.placement },
          defaults,
        );
        writeLayout(storageKey, next);
        return next;
      });
    },
    [defaults, storageKey],
  );

  const reorder = useCallback(
    (draggedId: string, targetId: string, placement: 'before' | 'after' = 'before') => {
      setLayout((current) => {
        const next = reorderToolbarItems(current, draggedId, targetId, placement);
        writeLayout(storageKey, next);
        return next;
      });
    },
    [storageKey],
  );

  const move = useCallback(
    (
      id: string,
      direction: 'earlier' | 'later',
      availableIds?: readonly string[] | ReadonlySet<string> | null,
    ) => {
      setLayout((current) => {
        const next = moveToolbarItem(current, id, direction, availableIds);
        writeLayout(storageKey, next);
        return next;
      });
    },
    [storageKey],
  );

  const reset = useCallback(() => {
    commit(resetToolbarItemLayout(defaults));
  }, [commit, defaults]);

  const partition = useCallback(
    (availableIds?: readonly string[] | ReadonlySet<string>) =>
      partitionToolbarItems(layout, availableIds),
    [layout],
  );

  return useMemo(
    () => ({ layout, partition, setPlacement, setOrder, reorder, move, reset }),
    [layout, partition, setPlacement, setOrder, reorder, move, reset],
  );
}
