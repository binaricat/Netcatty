import { useSyncExternalStore } from "react";

export interface SftpTreeSelectionItem {
  path: string;
  name: string;
  isDirectory: boolean;
  sourcePath: string;
}

interface SftpTreeSelectionState {
  visibleItems: SftpTreeSelectionItem[];
  selectedPaths: string[];
}

const EMPTY_STATE: SftpTreeSelectionState = {
  visibleItems: [],
  selectedPaths: [],
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
  if (next.visibleItems.length === 0 && next.selectedPaths.length === 0) {
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
    return state.selectedPaths
      .map((path) => visibleByPath.get(path))
      .filter((item): item is SftpTreeSelectionItem => Boolean(item));
  },

  setVisibleItems: (paneId: string, visibleItems: SftpTreeSelectionItem[]) => {
    const visiblePaths = new Set(visibleItems.map((item) => item.path));
    setPaneState(paneId, (state) => ({
      visibleItems,
      selectedPaths: state.selectedPaths.filter((path) => visiblePaths.has(path)),
    }));
  },

  setSelection: (paneId: string, selectedPaths: Iterable<string>) => {
    setPaneState(paneId, (state) => {
      const visiblePaths = new Set(state.visibleItems.map((item) => item.path));
      return {
        ...state,
        selectedPaths: Array.from(selectedPaths).filter((path) => visiblePaths.has(path)),
      };
    });
  },

  clearSelection: (paneId: string) => {
    setPaneState(paneId, (state) => ({ ...state, selectedPaths: [] }));
  },

  selectAllVisible: (paneId: string) => {
    setPaneState(paneId, (state) => ({
      ...state,
      selectedPaths: state.visibleItems.map((item) => item.path),
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

export const useSftpTreeSelectionState = (paneId: string): SftpTreeSelectionState =>
  useSyncExternalStore(
    (listener) => sftpTreeSelectionStore.subscribe(paneId, listener),
    () => sftpTreeSelectionStore.getPaneState(paneId),
    () => sftpTreeSelectionStore.getPaneState(paneId),
  );
