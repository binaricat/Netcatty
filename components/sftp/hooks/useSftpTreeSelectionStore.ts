import { useCallback, useSyncExternalStore } from "react";

export interface SftpTreeSelectionItem {
  path: string;
  name: string;
  isDirectory: boolean;
  sourcePath: string;
}

interface SftpTreeSelectionState {
  visibleItems: SftpTreeSelectionItem[];
  visiblePathsSet: Set<string>;
  selectedPaths: Set<string>;
}

const EMPTY_PATHS = new Set<string>();

const EMPTY_STATE: SftpTreeSelectionState = {
  visibleItems: [],
  visiblePathsSet: new Set(),
  selectedPaths: EMPTY_PATHS,
};

type Listener = () => void;

const paneStates = new Map<string, SftpTreeSelectionState>();
const paneListeners = new Map<string, Set<Listener>>();

const notifyPaneListeners = (paneId: string) => {
  paneListeners.get(paneId)?.forEach((listener) => listener());
};

const getPaneState = (paneId: string): SftpTreeSelectionState =>
  paneStates.get(paneId) ?? EMPTY_STATE;

const setPaneState = (
  paneId: string,
  updater: (state: SftpTreeSelectionState) => SftpTreeSelectionState,
) => {
  const prev = getPaneState(paneId);
  const next = updater(prev);
  if (next === prev) return;
  if (next.visibleItems.length === 0 && next.selectedPaths.size === 0) {
    paneStates.delete(paneId);
  } else {
    paneStates.set(paneId, next);
  }
  notifyPaneListeners(paneId);
};

export const sftpTreeSelectionStore = {
  getPaneState,

  getSelectedItems: (paneId: string): SftpTreeSelectionItem[] => {
    const state = getPaneState(paneId);
    const visibleByPath = new Map(state.visibleItems.map((item) => [item.path, item]));
    const result: SftpTreeSelectionItem[] = [];
    for (const path of state.selectedPaths) {
      const item = visibleByPath.get(path);
      if (item) result.push(item);
    }
    return result;
  },

  setVisibleItems: (paneId: string, visibleItems: SftpTreeSelectionItem[]) => {
    const visiblePathsSet = new Set(visibleItems.map((item) => item.path));
    setPaneState(paneId, (state) => {
      const newSelected = new Set([...state.selectedPaths].filter((p) => visiblePathsSet.has(p)));
      const changed =
        newSelected.size !== state.selectedPaths.size ||
        [...newSelected].some((p) => !state.selectedPaths.has(p));
      return {
        visibleItems,
        visiblePathsSet,
        selectedPaths: changed ? newSelected : state.selectedPaths,
      };
    });
  },

  setSelection: (paneId: string, selectedPaths: Iterable<string>) => {
    setPaneState(paneId, (state) => ({
      ...state,
      selectedPaths: new Set(Array.from(selectedPaths).filter((path) => state.visiblePathsSet.has(path))),
    }));
  },

  clearSelection: (paneId: string) => {
    setPaneState(paneId, (state) => ({ ...state, selectedPaths: EMPTY_PATHS }));
  },

  selectAllVisible: (paneId: string) => {
    setPaneState(paneId, (state) => ({
      ...state,
      selectedPaths: new Set(state.visibleItems.map((item) => item.path)),
    }));
  },

  clearPane: (paneId: string) => {
    if (!paneStates.has(paneId)) return;
    paneStates.delete(paneId);
    notifyPaneListeners(paneId);
  },

  subscribe: (paneId: string, listener: Listener) => {
    const listeners = paneListeners.get(paneId) ?? new Set<Listener>();
    listeners.add(listener);
    paneListeners.set(paneId, listeners);
    return () => {
      const current = paneListeners.get(paneId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        paneListeners.delete(paneId);
      }
    };
  },
};

export const useSftpTreeSelectionState = (paneId: string): SftpTreeSelectionState => {
  const subscribe = useCallback(
    (listener: () => void) => sftpTreeSelectionStore.subscribe(paneId, listener),
    [paneId],
  );
  return useSyncExternalStore(
    subscribe,
    () => sftpTreeSelectionStore.getPaneState(paneId),
    () => sftpTreeSelectionStore.getPaneState(paneId),
  );
};

export function useIsTreeNodeSelected(paneId: string, path: string): boolean {
  const getSnapshot = useCallback(
    () => sftpTreeSelectionStore.getPaneState(paneId).selectedPaths.has(path),
    [paneId, path],
  );
  const subscribe = useCallback(
    (listener: () => void) => sftpTreeSelectionStore.subscribe(paneId, listener),
    [paneId],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
