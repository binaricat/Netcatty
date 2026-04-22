import { useCallback, useSyncExternalStore } from "react";
import type * as Monaco from "monaco-editor";

export type EditorTabId = string;

export type EditorSavingState = "idle" | "saving" | "error";

export interface EditorTab {
  id: EditorTabId;
  kind: "editor";
  /** SFTP connection id (matches SftpConnection.id). Session lookup key. */
  sessionId: string;
  /** Stable endpoint id; used to verify the session is still the one we opened against. */
  hostId: string;
  remotePath: string;
  fileName: string;
  languageId: string;
  content: string;
  baselineContent: string;
  wordWrap: boolean;
  viewState: Monaco.editor.ICodeEditorViewState | null;
  savingState: EditorSavingState;
  saveError: string | null;
}

type Listener = () => void;

let idCounter = 0;
const genId = (): EditorTabId => `edt_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;

export class EditorTabStore {
  private tabs: EditorTab[] = [];
  private listeners = new Set<Listener>();
  private pendingNotify = false;

  getTabs = (): readonly EditorTab[] => this.tabs;
  getTab = (id: EditorTabId): EditorTab | undefined => this.tabs.find((t) => t.id === id);
  isDirty = (id: EditorTabId): boolean => {
    const t = this.getTab(id);
    return !!t && t.content !== t.baselineContent;
  };

  updateContent = (
    id: EditorTabId,
    content: string,
    viewState: Monaco.editor.ICodeEditorViewState | null,
  ) => {
    this.patch(id, { content, viewState });
  };

  markSaved = (id: EditorTabId, newBaseline: string) => {
    this.patch(id, { baselineContent: newBaseline, savingState: "idle", saveError: null });
  };

  setWordWrap = (id: EditorTabId, value: boolean) => {
    this.patch(id, { wordWrap: value });
  };

  setSavingState = (id: EditorTabId, state: EditorSavingState, error: string | null = null) => {
    const patch: Partial<EditorTab> = { savingState: state };
    if (state === "idle") patch.saveError = null;
    else if (state === "error") patch.saveError = error;
    this.patch(id, patch);
  };

  close = (id: EditorTabId) => {
    const next = this.tabs.filter((t) => t.id !== id);
    if (next.length !== this.tabs.length) {
      this.tabs = next;
      this.notify();
    }
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** TEST-ONLY: seed a tab without going through promote/openOrFocus. */
  _debugInsert = (tab: EditorTab) => {
    this.tabs = [...this.tabs, tab];
    this.notify();
  };

  protected makeId = genId;

  protected patch = (id: EditorTabId, patch: Partial<EditorTab>) => {
    let changed = false;
    this.tabs = this.tabs.map((t) => {
      if (t.id !== id) return t;
      changed = true;
      return { ...t, ...patch };
    });
    if (changed) this.notify();
  };

  protected notify = () => {
    if (this.pendingNotify) return;
    this.pendingNotify = true;
    Promise.resolve().then(() => {
      this.pendingNotify = false;
      this.listeners.forEach((l) => l());
    });
  };
}

export const editorTabStore = new EditorTabStore();

// Hooks
const getTabsSnapshot = () => editorTabStore.getTabs();

export const useEditorTabs = (): readonly EditorTab[] =>
  useSyncExternalStore(editorTabStore.subscribe, getTabsSnapshot);

export const useEditorTab = (id: EditorTabId): EditorTab | undefined => {
  const getSnapshot = useCallback(() => editorTabStore.getTab(id), [id]);
  return useSyncExternalStore(editorTabStore.subscribe, getSnapshot);
};

export const useEditorDirty = (id: EditorTabId): boolean => {
  const getSnapshot = useCallback(() => editorTabStore.isDirty(id), [id]);
  return useSyncExternalStore(editorTabStore.subscribe, getSnapshot);
};

export const useAnyEditorDirty = (): boolean => {
  const getSnapshot = useCallback(
    () => editorTabStore.getTabs().some((t) => t.content !== t.baselineContent),
    [],
  );
  return useSyncExternalStore(editorTabStore.subscribe, getSnapshot);
};
