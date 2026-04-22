import { useCallback, useSyncExternalStore } from "react";
import type * as Monaco from "monaco-editor";

import { activeTabStore, fromEditorTabId, isEditorTabId } from "./activeTabStore";

// POSIX-style normalization: collapse "/./" and duplicate slashes, not ".." (remote paths
// may contain semantic ".." segments we don't want to resolve client-side).
const normalizePath = (p: string): string => {
  const collapsed = p.replace(/\/+/g, "/").replace(/\/\.(?=\/|$)/g, "");
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
};

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

  setLanguage = (id: EditorTabId, languageId: string) => {
    this.patch(id, { languageId });
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

  /**
   * Force-close every tab bound to any of the given sessionIds, with no dirty
   * prompt. Intended for cases where the owning SFTP instance has gone away
   * entirely (e.g. the hosting terminal tab was closed) and there is no
   * realistic save channel anyway. Returns the closed tab ids.
   */
  forceCloseBySessions = (sessionIds: readonly string[]): EditorTabId[] => {
    if (sessionIds.length === 0) return [];
    const idSet = new Set(sessionIds);
    const removed = this.tabs.filter((t) => idSet.has(t.sessionId)).map((t) => t.id);
    if (removed.length === 0) return [];
    this.tabs = this.tabs.filter((t) => !idSet.has(t.sessionId));
    this.notify();

    // If the current active tab was one of the editor tabs we just removed,
    // fall back to 'vault' so the user doesn't end up on a stale id (empty
    // chrome + no content). Any better neighbor choice would need the full
    // orderedTabs list, which isn't available here; 'vault' is always valid.
    const activeId = activeTabStore.getActiveTabId();
    if (isEditorTabId(activeId)) {
      const activeEditorId = fromEditorTabId(activeId);
      if (activeEditorId && removed.includes(activeEditorId)) {
        activeTabStore.setActiveTabId('vault');
      }
    }

    return removed;
  };

  promoteFromModal = (snapshot: {
    sessionId: string;
    hostId: string;
    remotePath: string;
    fileName: string;
    languageId: string;
    content: string;
    baselineContent: string;
    wordWrap: boolean;
    viewState: Monaco.editor.ICodeEditorViewState | null;
  }): EditorTabId => {
    const normalized = normalizePath(snapshot.remotePath);
    const existing = this.tabs.find(
      (t) => t.sessionId === snapshot.sessionId && normalizePath(t.remotePath) === normalized,
    );
    if (existing) {
      this.patch(existing.id, {
        content: snapshot.content,
        baselineContent: snapshot.baselineContent,
        wordWrap: snapshot.wordWrap,
        viewState: snapshot.viewState,
        // keep languageId/hostId/fileName stable; they shouldn't change for the same path
      });
      return existing.id;
    }
    const tab: EditorTab = {
      id: this.makeId(),
      kind: "editor",
      sessionId: snapshot.sessionId,
      hostId: snapshot.hostId,
      remotePath: snapshot.remotePath,
      fileName: snapshot.fileName,
      languageId: snapshot.languageId,
      content: snapshot.content,
      baselineContent: snapshot.baselineContent,
      wordWrap: snapshot.wordWrap,
      viewState: snapshot.viewState,
      savingState: "idle",
      saveError: null,
    };
    this.tabs = [...this.tabs, tab];
    this.notify();
    return tab.id;
  };

  /**
   * Walk all editor tabs bound to `sessionId`. Clean tabs close silently; dirty tabs
   * prompt via `promptChoice`. 'save' invokes `saveTab` and closes only on its success.
   * Any 'cancel' aborts the batch (subsequent dirty tabs are preserved) and returns false.
   */
  confirmCloseBySession = async (
    sessionId: string,
    promptChoice: (tab: EditorTab) => Promise<"save" | "discard" | "cancel">,
    saveTab?: (tabId: EditorTabId) => Promise<void>,
  ): Promise<boolean> => {
    const matching = this.tabs.filter((t) => t.sessionId === sessionId);
    for (const tab of matching) {
      const dirty = tab.content !== tab.baselineContent;
      if (!dirty) {
        this.close(tab.id);
        continue;
      }
      const choice = await promptChoice(tab);
      if (choice === "cancel") return false;
      if (choice === "discard") { this.close(tab.id); continue; }
      if (choice === "save") {
        if (!saveTab) throw new Error("saveTab callback required when 'save' choice is possible");
        try {
          await saveTab(tab.id);
        } catch {
          // Save failed — treat like cancel (keep tab open, abort batch so the user sees the error)
          return false;
        }
        this.close(tab.id);
      }
    }
    return true;
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
