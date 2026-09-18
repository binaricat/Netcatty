import { useCallback, useMemo, useSyncExternalStore } from "react";
import type * as Monaco from "monaco-editor";

import { activeTabStore, fromEditorTabId, isEditorTabId } from "./activeTabStore";
import type { EditorTabPlacement, EditorWindowTabSnapshot } from "./editorWindowTypes";

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
  /** Stable SFTP pane tab id — survives browse reconnects that regenerate connection ids. */
  sftpTabId: string;
  /** Stable endpoint id; used to verify the session is still the one we opened against. */
  hostId: string;
  hostLabel?: string;
  remotePath: string;
  fileName: string;
  languageId: string;
  content: string;
  baselineContent: string;
  wordWrap: boolean;
  viewState: Monaco.editor.ICodeEditorViewState | null;
  savingState: EditorSavingState;
  saveError: string | null;
  placement?: EditorTabPlacement;
  windowDirty?: boolean;
}

type Listener = () => void;

let idCounter = 0;
const genId = (): EditorTabId => `edt_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;

export const tabIsDirty = (tab: EditorTab): boolean =>
  tab.placement === "window" ? tab.windowDirty === true : tab.content !== tab.baselineContent;

export class EditorTabStore {
  private tabs: EditorTab[] = [];
  private listeners = new Set<Listener>();
  private presenceListeners = new Set<Listener>();
  private pendingNotify = false;
  private pendingPresenceNotify = false;
  private presenceRevision = 0;

  getTabs = (): readonly EditorTab[] => this.tabs;
  getTab = (id: EditorTabId): EditorTab | undefined => this.tabs.find((t) => t.id === id);
  hasTabForSessions = (sessionIds: ReadonlySet<string>): boolean =>
    this.tabs.some((tab) => sessionIds.has(tab.sessionId));

  hasTabForSftpTabIds = (sftpTabIds: ReadonlySet<string>): boolean =>
    this.tabs.some((tab) => sftpTabIds.has(tab.sftpTabId));

  /** Match promoted editors by stable pane tab id and/or live connection id. */
  hasOwnedEditorForSftpOwner = (params: {
    sessionIds: ReadonlySet<string>;
    sftpTabIds: ReadonlySet<string>;
  }): boolean =>
    this.tabs.some((tab) =>
      params.sftpTabIds.has(tab.sftpTabId) || params.sessionIds.has(tab.sessionId),
    );

  getPresenceRevision = (): number => this.presenceRevision;

  /** Update editor tabs after browse reconnect replaces a connection id. */
  remapSessionId = (fromSessionId: string, toSessionId: string): void => {
    if (fromSessionId === toSessionId) return;
    let changed = false;
    this.tabs = this.tabs.map((tab) => {
      if (tab.sessionId !== fromSessionId) return tab;
      changed = true;
      return { ...tab, sessionId: toSessionId };
    });
    if (changed) this.notifyStructural();
  };
  isDirty = (id: EditorTabId): boolean => {
    const t = this.getTab(id);
    return !!t && tabIsDirty(t);
  };

  listByOwner = (owner: { sessionId?: string; sftpTabId?: string }): EditorTab[] =>
    this.tabs.filter((t) => this.tabMatchesOwner(t, owner));

  markDetached = (id: EditorTabId, dirty: boolean): void => {
    this.patch(id, {
      placement: "window",
      windowDirty: dirty,
      content: "",
      baselineContent: "",
      viewState: null,
    });
    this.notifyStructural();
  };

  setWindowDirty = (id: EditorTabId, dirty: boolean): void => {
    const tab = this.getTab(id);
    if (!tab || tab.placement !== "window" || tab.windowDirty === dirty) return;
    this.patch(id, { windowDirty: dirty });
  };

  upsertFromSnapshot = (
    snapshot: EditorWindowTabSnapshot,
    placement: EditorTabPlacement = "tab",
  ): EditorTabId => {
    const existingById = snapshot.editorId ? this.getTab(snapshot.editorId) : undefined;
    const normalized = normalizePath(snapshot.remotePath);
    const existing = existingById ?? this.tabs.find(
      (t) => t.sessionId === snapshot.sessionId && normalizePath(t.remotePath) === normalized,
    );
    const next: Partial<EditorTab> = {
      sessionId: snapshot.sessionId,
      sftpTabId: snapshot.sftpTabId,
      hostId: snapshot.hostId,
      hostLabel: snapshot.hostLabel,
      remotePath: snapshot.remotePath,
      fileName: snapshot.fileName,
      languageId: snapshot.languageId,
      content: placement === "window" ? "" : snapshot.content,
      baselineContent: placement === "window" ? "" : snapshot.baselineContent,
      wordWrap: snapshot.wordWrap,
      viewState: placement === "window" ? null : snapshot.viewState as EditorTab["viewState"],
      placement,
      windowDirty: placement === "window"
        ? snapshot.content !== snapshot.baselineContent
        : false,
      savingState: "idle",
      saveError: null,
    };
    if (existing) {
      this.patch(existing.id, next);
      if (existing.placement !== placement) this.notifyStructural();
      return existing.id;
    }
    const tab: EditorTab = {
      id: snapshot.editorId || this.makeId(),
      kind: "editor",
      sessionId: snapshot.sessionId,
      sftpTabId: snapshot.sftpTabId,
      hostId: snapshot.hostId,
      hostLabel: snapshot.hostLabel,
      remotePath: snapshot.remotePath,
      fileName: snapshot.fileName,
      languageId: snapshot.languageId,
      content: next.content ?? "",
      baselineContent: next.baselineContent ?? "",
      wordWrap: snapshot.wordWrap,
      viewState: (next.viewState ?? null) as EditorTab["viewState"],
      savingState: "idle",
      saveError: null,
      placement,
      windowDirty: next.windowDirty === true,
    };
    this.tabs = [...this.tabs, tab];
    this.notifyStructural();
    return tab.id;
  };

  updateContent = (
    id: EditorTabId,
    content: string,
    viewState: Monaco.editor.ICodeEditorViewState | null,
  ) => {
    this.patch(id, { content, viewState });
  };

  markSaved = (id: EditorTabId, newBaseline: string) => {
    const tab = this.getTab(id);
    if (tab?.placement === "window") {
      this.patch(id, { windowDirty: false, savingState: "idle", saveError: null });
      return;
    }
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
      this.notifyStructural();
    }
  };

  /**
   * Force-close every tab bound to any of the given sessionIds, with no dirty
   * prompt. Intended for cases where the owning SFTP instance has gone away
   * entirely (e.g. the hosting terminal tab was closed) and there is no
   * realistic save channel anyway. Returns the closed tab ids.
   */
  private tabMatchesOwner = (
    tab: EditorTab,
    owner: { sessionId?: string; sftpTabId?: string },
  ): boolean =>
    (owner.sessionId != null && tab.sessionId === owner.sessionId)
    || (owner.sftpTabId != null && tab.sftpTabId === owner.sftpTabId);

  /**
   * Force-close every tab bound to any owner id, with no dirty prompt.
   * Matches by live connection id and/or stable SFTP pane tab id.
   */
  forceCloseByOwners = (owners: {
    sessionIds?: readonly string[];
    sftpTabIds?: readonly string[];
  }): EditorTabId[] => {
    const sessionSet = new Set(owners.sessionIds ?? []);
    const tabIdSet = new Set(owners.sftpTabIds ?? []);
    if (sessionSet.size === 0 && tabIdSet.size === 0) return [];
    const removed = this.tabs
      .filter((t) => sessionSet.has(t.sessionId) || tabIdSet.has(t.sftpTabId))
      .map((t) => t.id);
    if (removed.length === 0) return [];
    const removedSet = new Set(removed);
    this.tabs = this.tabs.filter((t) => !removedSet.has(t.id));
    this.notifyStructural();

    const activeId = activeTabStore.getActiveTabId();
    if (isEditorTabId(activeId)) {
      const activeEditorId = fromEditorTabId(activeId);
      if (activeEditorId && removed.includes(activeEditorId)) {
        activeTabStore.setActiveTabId('vault');
      }
    }

    return removed;
  };

  forceCloseBySessions = (sessionIds: readonly string[]): EditorTabId[] =>
    this.forceCloseByOwners({ sessionIds });

  promoteFromModal = (snapshot: {
    sessionId: string;
    sftpTabId: string;
    hostId: string;
    remotePath: string;
    fileName: string;
    languageId: string;
    content: string;
    baselineContent: string;
    wordWrap: boolean;
    viewState: Monaco.editor.ICodeEditorViewState | null;
    placement?: EditorTabPlacement;
  }): EditorTabId => {
    const normalized = normalizePath(snapshot.remotePath);
    const existing = this.tabs.find(
      (t) => t.sessionId === snapshot.sessionId && normalizePath(t.remotePath) === normalized,
    );
    if (existing) {
      if (existing.placement === "window") return existing.id;
      this.patch(existing.id, {
        content: snapshot.content,
        baselineContent: snapshot.baselineContent,
        wordWrap: snapshot.wordWrap,
        viewState: snapshot.viewState,
        placement: snapshot.placement ?? existing.placement ?? "tab",
        windowDirty: false,
        // keep languageId/hostId/fileName stable; they shouldn't change for the same path
      });
      return existing.id;
    }
    const tab: EditorTab = {
      id: this.makeId(),
      kind: "editor",
      sessionId: snapshot.sessionId,
      sftpTabId: snapshot.sftpTabId,
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
      placement: snapshot.placement ?? "tab",
      windowDirty: false,
    };
    this.tabs = [...this.tabs, tab];
    this.notifyStructural();
    return tab.id;
  };

  /**
   * Walk editor tabs owned by a connection id and/or SFTP pane tab id. Clean tabs
   * close silently; dirty tabs prompt via `promptChoice`. 'save' invokes `saveTab`
   * and closes only on its success. Any 'cancel' aborts the batch and returns false.
   */
  confirmCloseByOwner = async (
    owner: { sessionId?: string; sftpTabId?: string },
    promptChoice: (tab: EditorTab) => Promise<"save" | "discard" | "cancel">,
    saveTab?: (tabId: EditorTabId) => Promise<void>,
    onCloseTab?: (tabId: EditorTabId) => void,
  ): Promise<boolean> => {
    const matching = this.tabs.filter((t) => this.tabMatchesOwner(t, owner) && t.placement !== "window");
    for (const tab of matching) {
      const dirty = tabIsDirty(tab);
      if (!dirty) {
        onCloseTab?.(tab.id);
        this.close(tab.id);
        continue;
      }
      const choice = await promptChoice(tab);
      if (choice === "cancel") return false;
      if (choice === "discard") {
        onCloseTab?.(tab.id);
        this.close(tab.id);
        continue;
      }
      if (choice === "save") {
        if (!saveTab) throw new Error("saveTab callback required when 'save' choice is possible");
        try {
          await saveTab(tab.id);
        } catch {
          // Save failed — treat like cancel (keep tab open, abort batch so the user sees the error)
          return false;
        }
        onCloseTab?.(tab.id);
        this.close(tab.id);
      }
    }
    return true;
  };

  confirmCloseBySession = async (
    sessionId: string,
    promptChoice: (tab: EditorTab) => Promise<"save" | "discard" | "cancel">,
    saveTab?: (tabId: EditorTabId) => Promise<void>,
    onCloseTab?: (tabId: EditorTabId) => void,
  ): Promise<boolean> =>
    this.confirmCloseByOwner({ sessionId }, promptChoice, saveTab, onCloseTab);

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Tab open/close/session remap only — not editor content or save-state churn. */
  subscribePresence = (listener: Listener): (() => void) => {
    this.presenceListeners.add(listener);
    return () => { this.presenceListeners.delete(listener); };
  };

  /** TEST-ONLY: seed a tab without going through promote/openOrFocus. */
  _debugInsert = (tab: EditorTab) => {
    this.tabs = [...this.tabs, tab];
    this.notifyStructural();
  };

  protected makeId = genId;

  protected patch = (id: EditorTabId, patch: Partial<EditorTab>) => {
    let changed = false;
    this.tabs = this.tabs.map((t) => {
      if (t.id !== id) return t;
      changed = true;
      return { ...t, ...patch };
    });
    if (changed) this.notifyContent();
  };

  protected notifyContent = () => {
    if (this.pendingNotify) return;
    this.pendingNotify = true;
    Promise.resolve().then(() => {
      this.pendingNotify = false;
      this.listeners.forEach((l) => l());
    });
  };

  protected notifyStructural = () => {
    this.presenceRevision += 1;
    this.notifyPresence();
    this.notifyContent();
  };

  protected notifyPresence = () => {
    if (this.pendingPresenceNotify) return;
    this.pendingPresenceNotify = true;
    Promise.resolve().then(() => {
      this.pendingPresenceNotify = false;
      this.presenceListeners.forEach((l) => l());
    });
  };
}

export const editorTabStore = new EditorTabStore();

// Hooks
const getTabsSnapshot = () => editorTabStore.getTabs();

export const useEditorTabs = (): readonly EditorTab[] =>
  useSyncExternalStore(editorTabStore.subscribe, getTabsSnapshot, getTabsSnapshot);

/**
 * Chrome-only editor tab fields for App shell / TopTabs ordering.
 * Content/save-state churn must not flow through this list.
 */
export type EditorTabChrome = Pick<
  EditorTab,
  | 'id'
  | 'kind'
  | 'sessionId'
  | 'sftpTabId'
  | 'hostId'
  | 'hostLabel'
  | 'remotePath'
  | 'fileName'
  | 'languageId'
  | 'placement'
>;

const projectEditorTabChrome = (tab: EditorTab): EditorTabChrome => ({
  id: tab.id,
  kind: tab.kind,
  sessionId: tab.sessionId,
  sftpTabId: tab.sftpTabId,
  hostId: tab.hostId,
  hostLabel: tab.hostLabel,
  remotePath: tab.remotePath,
  fileName: tab.fileName,
  languageId: tab.languageId,
  placement: tab.placement ?? "tab",
});

export const useHasEditorTabForSessions = (
  getSessionIds: () => ReadonlySet<string>,
): boolean => {
  const getSnapshot = useCallback(
    () => editorTabStore.hasTabForSessions(getSessionIds()),
    [getSessionIds],
  );
  return useSyncExternalStore(editorTabStore.subscribe, getSnapshot, getSnapshot);
};

/** Re-render only when editor tabs open/close or their SFTP session binding changes. */
export const useEditorTabPresenceRevision = (): number =>
  useSyncExternalStore(
    editorTabStore.subscribePresence,
    () => editorTabStore.getPresenceRevision(),
    () => editorTabStore.getPresenceRevision(),
  );

/**
 * Subscribe to open/close/remap only. Safe for App domain memos and tab strip
 * structure; dirty dots and Monaco content must use per-tab hooks.
 */
export const useEditorTabChromeList = (): readonly EditorTabChrome[] => {
  const revision = useEditorTabPresenceRevision();
  return useMemo(() => {
    void revision;
    return editorTabStore.getTabs().map(projectEditorTabChrome);
  }, [revision]);
};

export const useEditorTab = (id: EditorTabId): EditorTab | undefined => {
  const getSnapshot = useCallback(() => editorTabStore.getTab(id), [id]);
  return useSyncExternalStore(editorTabStore.subscribe, getSnapshot, getSnapshot);
};

/**
 * Per-tab dirty flag. Content edits notify the store, but React skips re-render
 * when this tab's dirty boolean is unchanged (Object.is).
 */
export const useEditorTabDirty = (id: EditorTabId): boolean =>
  useSyncExternalStore(
    editorTabStore.subscribe,
    () => editorTabStore.isDirty(id),
    () => editorTabStore.isDirty(id),
  );
