import { Copy, Minus, Square, X } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";

import { useI18n } from "../../application/i18n/I18nProvider";
import {
  editorTabStore,
  tabIsDirty,
  useEditorTab,
  useEditorTabChromeList,
  useEditorTabDirty,
  type EditorTabId,
} from "../../application/state/editorTabStore";
import {
  dockDetachedEditorTab,
  reportDetachedEditorDirty,
  reportDetachedEditorTabsClosed,
  reportEditorWindowCloseTabsResult,
  saveDetachedEditorTab,
  subscribeEditorWindowCloseTabs,
  subscribeEditorWindowDirtyCheck,
} from "../../application/state/editorWindowClient";
import { useEditorWindowRuntime } from "../../application/state/useEditorWindow";
import { useWindowControls } from "../../application/state/useWindowControls";
import type { AppLockGateRenderContext } from "../AppLockGate";
import { toast } from "../ui/toast";
import { promptUnsavedChanges, UnsavedChangesProvider } from "./UnsavedChangesDialog";
import { EditorWindowTabBar } from "./EditorWindowTabBar";
import { TextEditorPane } from "./TextEditorPane";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

type SettingsState = AppLockGateRenderContext["settings"];

function EditorWindowControls({ onClose }: { onClose: () => void }) {
  const { minimize, maximize, isMaximized: fetchIsMaximized } = useWindowControls();
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchIsMaximized().then((value) => {
      if (!cancelled) setIsWindowMaximized(!!value);
    });
    const handleResize = () => {
      void fetchIsMaximized().then((value) => setIsWindowMaximized(!!value));
    };
    window.addEventListener("resize", handleResize);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", handleResize);
    };
  }, [fetchIsMaximized]);

  if (isMac) return null;

  const buttonClass =
    "app-no-drag flex h-10 w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

  return (
    <div className="app-no-drag ml-auto flex h-10 shrink-0 items-center">
      <button type="button" onClick={() => void minimize()} className={buttonClass} aria-label="Minimize">
        <Minus size={15} />
      </button>
      <button
        type="button"
        onClick={async () => {
          const value = await maximize();
          setIsWindowMaximized(!!value);
        }}
        className={buttonClass}
        aria-label={isWindowMaximized ? "Restore" : "Maximize"}
      >
        {isWindowMaximized ? <Copy size={14} /> : <Square size={13} />}
      </button>
      <button
        type="button"
        onClick={onClose}
        className="app-no-drag flex h-10 w-11 items-center justify-center text-foreground opacity-80 transition-colors hover:bg-destructive/20 hover:opacity-100"
        aria-label="Close"
      >
        <X size={16} />
      </button>
    </div>
  );
}

const EditorWindowPaneHost = React.memo(function EditorWindowPaneHost({
  tabId,
  isVisible,
  settings,
  onRequestClose,
  onDock,
}: {
  tabId: EditorTabId;
  isVisible: boolean;
  settings: SettingsState;
  onRequestClose: (tabId: EditorTabId) => void;
  onDock: (tabId: EditorTabId) => void;
}) {
  const { t } = useI18n();
  const tab = useEditorTab(tabId);
  const dirtyReportTimerRef = useRef<number | null>(null);
  const handleContentChange = useCallback(
    (content: string, viewState: Monaco.editor.ICodeEditorViewState | null) => {
      editorTabStore.updateContent(tabId, content, viewState);
      const latest = editorTabStore.getTab(tabId);
      if (!latest) return;
      const dirty = content !== latest.baselineContent;
      if (dirtyReportTimerRef.current != null) window.clearTimeout(dirtyReportTimerRef.current);
      dirtyReportTimerRef.current = window.setTimeout(() => {
        dirtyReportTimerRef.current = null;
        reportDetachedEditorDirty(tabId, dirty);
      }, 150);
    },
    [tabId],
  );
  useEffect(() => () => {
    if (dirtyReportTimerRef.current != null) window.clearTimeout(dirtyReportTimerRef.current);
  }, []);
  const handleSave = useCallback(async () => {
    if (dirtyReportTimerRef.current != null) {
      window.clearTimeout(dirtyReportTimerRef.current);
      dirtyReportTimerRef.current = null;
    }
    const result = await saveDetachedEditorTab(tabId);
    if (result.ok) {
      toast.success(t("sftp.editor.saved"), "SFTP");
    } else {
      toast.error(result.error ?? t("sftp.editor.saveFailed"), "SFTP");
    }
  }, [tabId, t]);

  const handleLanguageChange = useCallback((language: string) => {
    editorTabStore.setLanguage(tabId, language);
  }, [tabId]);
  const handleToggleWordWrap = useCallback(() => {
    const current = editorTabStore.getTab(tabId);
    if (current) editorTabStore.setWordWrap(tabId, !current.wordWrap);
  }, [tabId]);
  const handleRequestClose = useCallback(() => onRequestClose(tabId), [onRequestClose, tabId]);
  const handleDock = useCallback(() => onDock(tabId), [onDock, tabId]);

  if (!tab) return null;
  const isDirty = tabIsDirty(tab);
  const hostLabel = tab.hostLabel || tab.hostId;

  return (
    <div
      className="absolute inset-0 flex min-h-0 flex-col bg-background"
      style={isVisible ? undefined : { pointerEvents: "none", visibility: "hidden" }}
    >
      <TextEditorPane
        chrome="window"
        fileName={`${tab.fileName}${isDirty ? " *" : ""}`}
        subtitle={`${hostLabel}:${tab.remotePath}`}
        content={tab.content}
        languageId={tab.languageId}
        wordWrap={tab.wordWrap}
        saving={tab.savingState === "saving"}
        saveError={tab.saveError}
        hotkeyScheme={settings.hotkeyScheme}
        keyBindings={settings.keyBindings}
        onContentChange={handleContentChange}
        onLanguageChange={handleLanguageChange}
        onToggleWordWrap={handleToggleWordWrap}
        onSave={handleSave}
        onRequestClose={handleRequestClose}
        onDockToMain={handleDock}
        initialViewState={tab.viewState}
      />
    </div>
  );
});

/** Keep content/dirty notifications out of the page and inactive editor panes. */
function EditorWindowTitle({
  activeTabId,
  setWindowTitle,
}: {
  activeTabId: EditorTabId | null;
  setWindowTitle: (title: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const activeTab = useEditorTab(activeTabId ?? "");
  const activeDirty = useEditorTabDirty(activeTabId ?? "");
  useEffect(() => {
    const name = activeTab?.fileName;
    void setWindowTitle(name
      ? `${activeDirty ? "* " : ""}${name}`
      : t("sftp.editor.windowTitle"));
  }, [activeDirty, activeTab?.fileName, setWindowTitle, t]);
  return null;
}

function EditorWindowPageInner({ settings }: { settings: SettingsState }) {
  const { t } = useI18n();
  const { activeTabId, setActiveTabId, closeWindow, setWindowTitle } = useEditorWindowRuntime();
  const { onWindowCommandCloseRequested } = useWindowControls();
  const tabs = useEditorTabChromeList();
  const closeInFlightRef = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    if (activeTabId && editorTabStore.getTab(activeTabId)) return;
    if (tabs.length > 0) setActiveTabId(tabs[tabs.length - 1].id);
  }, [activeTabId, setActiveTabId, tabs]);

  const saveTab = useCallback(async (tabId: EditorTabId): Promise<boolean> => {
    const result = await saveDetachedEditorTab(tabId);
    if (result.ok) return true;
    toast.error(result.error ?? t("sftp.editor.saveFailed"), "SFTP");
    return false;
  }, [t]);

  const closeTab = useCallback(async (tabId: EditorTabId, force = false): Promise<boolean> => {
    const tab = editorTabStore.getTab(tabId);
    if (!tab) return true;
    if (!force && tabIsDirty(tab)) {
      const choice = await promptUnsavedChanges(tab.fileName);
      if (choice === "cancel") return false;
      if (choice === "save") {
        const ok = await saveTab(tabId);
        if (!ok) return false;
      }
    }
    editorTabStore.close(tabId);
    reportDetachedEditorTabsClosed([tabId]);
    return true;
  }, [saveTab]);

  const closeTabAndMaybeWindow = useCallback(async (tabId: EditorTabId, force = false): Promise<boolean> => {
    if (closeInFlightRef.current) return closeInFlightRef.current;
    const task = (async () => {
      const ok = await closeTab(tabId, force);
      if (!ok) return false;
      const remaining = editorTabStore.getTabs();
      if (remaining.length === 0) {
        await closeWindow();
        return true;
      }
      setActiveTabId((current) => current === tabId
        ? remaining[remaining.length - 1]?.id ?? null
        : current);
      return true;
    })().finally(() => {
      closeInFlightRef.current = null;
    });
    closeInFlightRef.current = task;
    return task;
  }, [closeTab, closeWindow, setActiveTabId]);

  const handleDock = useCallback(async (tabId: EditorTabId) => {
    const result = await dockDetachedEditorTab(tabId);
    if (!result.success) {
      toast.error(result.error ?? t("sftp.editor.dockFailed"), "SFTP");
      return;
    }
    editorTabStore.close(tabId);
    const remaining = editorTabStore.getTabs();
    if (remaining.length === 0) {
      await closeWindow();
      return;
    }
    setActiveTabId((current) => current === tabId
      ? remaining[remaining.length - 1]?.id ?? null
      : current);
  }, [closeWindow, setActiveTabId, t]);

  const handleRequestClose = useCallback((tabId: EditorTabId) => {
    void closeTabAndMaybeWindow(tabId);
  }, [closeTabAndMaybeWindow]);

  const handleWindowClose = useCallback(async () => {
    // Native close owns confirmation and blocks new transfers until it settles.
    await closeWindow();
  }, [closeWindow]);

  useEffect(() => {
    return onWindowCommandCloseRequested(() => {
      if (activeTabId) void closeTabAndMaybeWindow(activeTabId);
      else void handleWindowClose();
    });
  }, [activeTabId, closeTabAndMaybeWindow, handleWindowClose, onWindowCommandCloseRequested]);

  useEffect(() => {
    return subscribeEditorWindowDirtyCheck(() => {
      const hasDirty = editorTabStore.getTabs().some((tab) => tabIsDirty(tab));
      if (hasDirty) toast.warning(t("sftp.editor.quitBlockedByDirty"), "SFTP");
      return hasDirty;
    });
  }, [t]);

  useEffect(() => {
    return subscribeEditorWindowCloseTabs(async (payload) => {
      const closedIds: string[] = [];
      let cancelled = false;
      for (const editorId of payload.editorIds ?? []) {
        const ok = await closeTab(editorId, payload.force === true);
        if (!ok) {
          cancelled = true;
          break;
        }
        closedIds.push(editorId);
      }
      reportEditorWindowCloseTabsResult({
        requestId: payload.requestId,
        cancelled,
        closedIds,
      });
      if (!cancelled && editorTabStore.getTabs().length === 0) {
        await closeWindow();
      } else if (activeTabId && !editorTabStore.getTab(activeTabId)) {
        setActiveTabId(editorTabStore.getTabs()[0]?.id ?? null);
      }
    });
  }, [activeTabId, closeTab, closeWindow, setActiveTabId]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <EditorWindowTitle activeTabId={activeTabId} setWindowTitle={setWindowTitle} />
      <div className="flex h-10 shrink-0 items-center border-b border-border/60 app-drag">
        {isMac ? <div className="w-[72px] shrink-0" /> : null}
        <div className="px-3 text-xs font-semibold text-muted-foreground app-no-drag">
          {t("sftp.editor.windowTitle")}
        </div>
        <EditorWindowTabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelect={setActiveTabId}
          onClose={(tabId) => { void closeTabAndMaybeWindow(tabId); }}
        />
        <EditorWindowControls onClose={() => { void handleWindowClose(); }} />
      </div>
      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t("sftp.editor.windowEmpty")}
          </div>
        ) : (
          tabs.map((tab) => (
            <EditorWindowPaneHost
              key={tab.id}
              tabId={tab.id}
              isVisible={tab.id === activeTabId}
              settings={settings}
              onRequestClose={handleRequestClose}
              onDock={handleDock}
            />
          ))
        )}
      </div>
    </div>
  );
}

export default function EditorWindowPage({
  settings,
}: {
  settings: SettingsState;
  allowEdit?: boolean;
}) {
  return (
    <UnsavedChangesProvider>
      {() => <EditorWindowPageInner settings={settings} />}
    </UnsavedChangesProvider>
  );
}
