import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import { saveEditorTab } from "./editorTabSave";
import {
  editorTabStore,
  tabIsDirty,
  type EditorTab,
  type EditorTabId,
} from "./editorTabStore";
import type { EditorWindowTabSnapshot } from "./editorWindowTypes";
import { activeTabStore, toEditorTabId } from "./activeTabStore";

export function toEditorWindowSnapshot(
  tab: EditorTab,
  hostLabel?: string,
): EditorWindowTabSnapshot {
  return {
    editorId: tab.id,
    sessionId: tab.sessionId,
    sftpTabId: tab.sftpTabId,
    hostId: tab.hostId,
    hostLabel: hostLabel || tab.hostLabel,
    remotePath: tab.remotePath,
    fileName: tab.fileName,
    languageId: tab.languageId,
    content: tab.content,
    baselineContent: tab.baselineContent,
    wordWrap: tab.wordWrap,
    viewState: tab.viewState,
  };
}

export async function openEditorInWindow(snapshot: EditorWindowTabSnapshot): Promise<boolean> {
  const bridge = netcattyBridge.get();
  if (!bridge?.openEditorWindow) return false;
  const result = await bridge.openEditorWindow(snapshot);
  return result?.success === true;
}

export async function focusEditorInWindow(editorId: EditorTabId): Promise<boolean> {
  const result = await netcattyBridge.get()?.focusEditorWindow?.(editorId);
  return result?.success === true;
}

export async function popOutEditorTab(
  tabId: EditorTabId,
  hostLabel?: string,
): Promise<boolean> {
  const tab = editorTabStore.getTab(tabId);
  if (!tab) return false;
  if (tab.placement === "window") {
    return focusEditorInWindow(tabId);
  }
  const dirty = tabIsDirty(tab);
  const snapshot = toEditorWindowSnapshot(tab, hostLabel || tab.hostLabel);
  editorTabStore.markDetached(tabId, dirty);
  const ok = await openEditorInWindow(snapshot);
  if (!ok) {
    editorTabStore.upsertFromSnapshot(snapshot, "tab");
    return false;
  }
  const activeId = activeTabStore.getActiveTabId();
  if (activeId === toEditorTabId(tabId)) {
    activeTabStore.setActiveTabId("vault");
  }
  return true;
}

export async function closeOwnedEditorWindowTabs(
  owner: { sessionId?: string; sftpTabId?: string },
  options?: { force?: boolean },
): Promise<{ cancelled: boolean; closedIds: string[] }> {
  const matching = editorTabStore.listByOwner(owner).filter((tab) => tab.placement === "window");
  if (matching.length === 0) return { cancelled: false, closedIds: [] };
  const result = await netcattyBridge.get()?.closeEditorWindowTabs?.({
    editorIds: matching.map((tab) => tab.id),
    force: options?.force === true,
  });
  const closedIds = result?.closedIds ?? [];
  for (const id of closedIds) editorTabStore.close(id);
  if (!result || result.success === false) {
    return { cancelled: options?.force !== true, closedIds };
  }
  if (result.cancelled !== true) {
    for (const tab of matching) editorTabStore.close(tab.id);
  }
  return {
    cancelled: result.cancelled === true,
    closedIds,
  };
}

export async function confirmCloseOwnedEditors(
  owner: { sessionId?: string; sftpTabId?: string },
  promptChoice: (tab: EditorTab) => Promise<"save" | "discard" | "cancel">,
  saveTab?: (tabId: EditorTabId) => Promise<void>,
  onCloseTab?: (tabId: EditorTabId) => void,
): Promise<boolean> {
  const windowClose = await closeOwnedEditorWindowTabs(owner, { force: false });
  if (windowClose.cancelled) return false;
  return editorTabStore.confirmCloseByOwner(owner, promptChoice, saveTab, onCloseTab);
}

export function forceCloseOwnedEditors(owners: {
  sessionIds?: readonly string[];
  sftpTabIds?: readonly string[];
}): EditorTabId[] {
  const matching = editorTabStore.getTabs().filter((tab) => {
    if (tab.placement !== "window") return false;
    if (owners.sessionIds?.includes(tab.sessionId)) return true;
    if (owners.sftpTabIds?.includes(tab.sftpTabId)) return true;
    return false;
  });
  if (matching.length > 0) {
    void netcattyBridge.get()?.closeEditorWindowTabs?.({
      editorIds: matching.map((tab) => tab.id),
      force: true,
    });
  }
  return editorTabStore.forceCloseByOwners(owners);
}

export function notifyEditorWindowSessionRemap(fromSessionId: string, toSessionId: string): void {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return;
  netcattyBridge.get()?.remapEditorWindowSession?.({ fromSessionId, toSessionId });
}

export async function saveDetachedEditorTab(tabId: EditorTabId): Promise<{ ok: boolean; error?: string }> {
  const current = editorTabStore.getTab(tabId);
  if (!current) return { ok: false, error: "Editor tab closed before save completed" };
  editorTabStore.setSavingState(tabId, "saving");
  const result = await netcattyBridge.get()?.saveEditorWindowTab?.({
    editorId: current.id,
    sessionId: current.sessionId,
    sftpTabId: current.sftpTabId,
    hostId: current.hostId,
    remotePath: current.remotePath,
    content: current.content,
  });
  if (result?.ok) {
    editorTabStore.markSaved(tabId, current.content);
    netcattyBridge.get()?.reportEditorWindowDirty?.({ editorId: tabId, dirty: false });
    return { ok: true };
  }
  const error = result?.error || "Save failed";
  editorTabStore.setSavingState(tabId, "error", error);
  return { ok: false, error };
}

export async function dockDetachedEditorTab(tabId: EditorTabId): Promise<{ success: boolean; error?: string }> {
  const tab = editorTabStore.getTab(tabId);
  if (!tab) return { success: false, error: "Editor tab closed" };
  const result = await netcattyBridge.get()?.dockEditorWindowTab?.(
    toEditorWindowSnapshot(tab, tab.hostLabel),
  );
  if (result?.success) return { success: true };
  return { success: false, error: result?.error || "Failed to dock editor tab" };
}

export function reportDetachedEditorDirty(tabId: EditorTabId, dirty: boolean): void {
  netcattyBridge.get()?.reportEditorWindowDirty?.({ editorId: tabId, dirty });
}

export function reportDetachedEditorTabsClosed(editorIds: string[]): void {
  if (editorIds.length === 0) return;
  netcattyBridge.get()?.reportEditorWindowTabsClosed?.({ editorIds });
}

export function subscribeEditorWindowCloseTabs(
  cb: (payload: import("./editorWindowTypes").EditorWindowCloseTabsRequest) => void | Promise<void>,
): () => void {
  return netcattyBridge.get()?.onEditorWindowCloseTabs?.(cb) ?? (() => {});
}

export function reportEditorWindowCloseTabsResult(
  payload: import("./editorWindowTypes").EditorWindowCloseTabsResult,
): void {
  netcattyBridge.get()?.reportEditorWindowCloseTabsResult?.(payload);
}

export function subscribeEditorWindowDirtyCheck(cb: () => boolean): () => void {
  const bridge = netcattyBridge.get();
  if (!bridge?.onCheckDirtyEditors) return () => {};
  return bridge.onCheckDirtyEditors(() => {
    let hasDirty = false;
    try {
      hasDirty = cb() === true;
    } catch {
      hasDirty = false;
    }
    try {
      bridge.reportDirtyEditorsResult?.(hasDirty);
    } catch {
      // ignore
    }
  });
}

export function installEditorWindowSourceListeners(): () => void {
  const bridge = netcattyBridge.get();
  if (!bridge) return () => {};

  const unsubSave = bridge.onEditorWindowSaveRequest?.(async (payload) => {
      try {
        const tab = editorTabStore.getTab(payload.editorId);
        if (!tab) {
          bridge.reportEditorWindowSaveResult?.({
            requestId: payload.requestId,
            ok: false,
            error: "Editor tab closed before save completed",
          });
          return;
        }
        if (tab.sessionId !== payload.sessionId) {
          editorTabStore.remapSessionId(tab.sessionId, payload.sessionId);
        }
        const ok = await saveEditorTab(payload.editorId, payload.content);
        const latest = editorTabStore.getTab(payload.editorId);
        bridge.reportEditorWindowSaveResult?.({
          requestId: payload.requestId,
          ok,
          liveConnectionId: latest?.sessionId,
          error: ok ? undefined : (latest?.saveError || "Save failed"),
        });
        if (ok) {
          editorTabStore.setWindowDirty(payload.editorId, false);
        }
      } catch (err) {
      bridge.reportEditorWindowSaveResult?.({
        requestId: payload.requestId,
        ok: false,
        error: err instanceof Error ? err.message : "Save failed",
      });
    }
  }) ?? (() => {});

  const unsubDock = bridge.onEditorWindowDockRequest?.((payload) => {
    try {
      const id = editorTabStore.upsertFromSnapshot(payload, "tab");
      activeTabStore.setActiveTabId(toEditorTabId(id));
      bridge.reportEditorWindowDockResult?.({ requestId: payload.requestId, ok: true });
    } catch (err) {
      bridge.reportEditorWindowDockResult?.({
        requestId: payload.requestId,
        ok: false,
        error: err instanceof Error ? err.message : "Failed to dock",
      });
    }
  }) ?? (() => {});

  const unsubDirty = bridge.onEditorWindowDirtyChanged?.((payload) => {
    editorTabStore.setWindowDirty(payload.editorId, payload.dirty === true);
  }) ?? (() => {});

  const unsubClosed = bridge.onEditorWindowTabsClosed?.((payload) => {
    for (const editorId of payload.editorIds ?? []) {
      editorTabStore.close(editorId);
    }
  }) ?? (() => {});

  return () => {
    unsubSave();
    unsubDock();
    unsubDirty();
    unsubClosed();
  };
}
