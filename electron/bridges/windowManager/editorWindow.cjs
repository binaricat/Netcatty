/* eslint-disable no-undef */

const { randomUUID } = require("node:crypto");

const {
  windowsFramelessContentChromeOptions,
} = require("./windowsWindowChrome.cjs");

const EDITOR_WIDTH = 1100;
const EDITOR_HEIGHT = 760;
const CLOSE_TABS_PROMPT_TIMEOUT_MS = 120000;
const CLOSE_TABS_FORCE_TIMEOUT_MS = 8000;
const SAVE_TIMEOUT_MS = 30000;
const DOCK_TIMEOUT_MS = 8000;
const OPEN_TAB_TIMEOUT_MS = 30000;
const MAX_EDITOR_CONTENT_BYTES = 10 * 1024 * 1024;

function isLiveWindow(win) {
  return Boolean(win && typeof win.isDestroyed === "function" && !win.isDestroyed());
}

function sanitizeEditorSnapshot(payload) {
  if (!payload || typeof payload !== "object") return null;
  const editorId = typeof payload.editorId === "string" ? payload.editorId.trim() : "";
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
  const sftpTabId = typeof payload.sftpTabId === "string" ? payload.sftpTabId : "";
  const hostId = typeof payload.hostId === "string" ? payload.hostId : "";
  const remotePath = typeof payload.remotePath === "string" ? payload.remotePath : "";
  const fileName = typeof payload.fileName === "string" ? payload.fileName.trim() : "";
  if (!editorId || !sessionId || !sftpTabId || !hostId || !remotePath || !fileName) {
    return null;
  }
  const content = typeof payload.content === "string" ? payload.content : "";
  const baselineContent = typeof payload.baselineContent === "string" ? payload.baselineContent : "";
  try {
    if (Buffer.byteLength(content, "utf8") > MAX_EDITOR_CONTENT_BYTES) return null;
    if (Buffer.byteLength(baselineContent, "utf8") > MAX_EDITOR_CONTENT_BYTES) return null;
  } catch {
    return null;
  }
  return {
    editorId,
    sessionId,
    sftpTabId,
    hostId,
    hostLabel: typeof payload.hostLabel === "string" ? payload.hostLabel : undefined,
    remotePath,
    fileName,
    languageId: typeof payload.languageId === "string" && payload.languageId
      ? payload.languageId
      : "plaintext",
    content,
    baselineContent,
    wordWrap: payload.wordWrap === true,
    viewState: payload.viewState && typeof payload.viewState === "object" ? payload.viewState : null,
  };
}

function createEditorWindowApi(ctx) {
  with (ctx) {
    let editorWindow = null;
    let editorWindowLoaded = null;
    const tabSources = new Map();

    function getEditorWindow() {
      if (!isLiveWindow(editorWindow)) {
        editorWindow = null;
        return null;
      }
      return editorWindow;
    }

    function hasEditorTabsForSource(webContents) {
      return Array.from(tabSources.values()).some((owner) => owner.webContentsId === webContents?.id);
    }

    async function closeEditorTabsForSource(electronModule, webContents) {
      const editorIds = Array.from(tabSources).filter(([, owner]) => owner.webContentsId === webContents?.id).map(([id]) => id);
      return closeEditorTabs(electronModule, { editorIds });
    }

    function resolveSourceWebContents(electronModule, editorId) {
      const id = tabSources.get(editorId)?.webContentsId;
      if (!Number.isFinite(id)) return null;
      try {
        const wc = electronModule.webContents.fromId(id);
        if (!wc || wc.isDestroyed?.()) return null;
        return wc;
      } catch {
        return null;
      }
    }

    function invokeWebContents(electronModule, webContents, sendChannel, replyChannel, payload, timeoutMs) {
      const ipcMain = electronModule.ipcMain;
      if (!ipcMain || !webContents || webContents.isDestroyed?.()) {
        return Promise.resolve({ success: false, error: "Target window is gone" });
      }
      const requestId = payload.requestId || randomUUID();
      const message = { ...payload, requestId };
      return new Promise((resolve) => {
        let settled = false;
        let timeoutId = null;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          if (timeoutId !== null) clearTimeout(timeoutId);
          ipcMain.removeListener(replyChannel, onResult);
          webContents.removeListener("destroyed", onDestroyed);
          resolve(result);
        };
        function onResult(evt, result) {
          if (evt?.sender !== webContents) return;
          if (!result || result.requestId !== requestId) return;
          settle({ success: true, ...result });
        }
        function onDestroyed() {
          settle({ success: false, error: "Target window is gone" });
        }
        ipcMain.on(replyChannel, onResult);
        webContents.once("destroyed", onDestroyed);
        timeoutId = setTimeout(() => {
          settle({ success: false, error: "Timed out waiting for editor window" });
        }, timeoutMs);
        try {
          webContents.send(sendChannel, message);
        } catch (err) {
          settle({ success: false, error: err?.message || "Failed to send to renderer" });
        }
      });
    }

    function notifySourcesTabsClosed(electronModule, editorIds) {
      if (!Array.isArray(editorIds) || editorIds.length === 0) return;
      const bySource = new Map();
      for (const editorId of editorIds) {
        if (typeof editorId !== "string" || !editorId) continue;
        const owner = tabSources.get(editorId);
        const wc = resolveSourceWebContents(electronModule, editorId);
        tabSources.delete(editorId);
        if (!owner?.accepted || !wc) continue;
        const list = bySource.get(wc) || [];
        list.push(editorId);
        bySource.set(wc, list);
      }
      for (const [wc, ids] of bySource) {
        try {
          wc.send("netcatty:window:editorTabsClosed", { editorIds: ids });
        } catch {
          // ignore
        }
      }
    }

    function sendOpenTab(electronModule, win, snapshot, source, reused) {
      if (!source || source.isDestroyed?.()) return Promise.resolve({ success: false, error: "Source window is gone" });
      const owner = { webContentsId: source.id, accepted: false, opening: null };
      tabSources.set(snapshot.editorId, owner);
      owner.opening = (async () => {
        try {
          // All opens, including reuse during cold start, share the same load.
          await editorWindowLoaded;
          if (!isLiveWindow(win)) return { success: false, error: "Editor window is gone" };
          const result = await invokeWebContents(
            electronModule,
            win.webContents,
            "netcatty:window:editorOpenTab",
            "netcatty:window:editorOpenTabResult",
            snapshot,
            OPEN_TAB_TIMEOUT_MS,
          );
          if (!result.success || result.ok !== true || !isLiveWindow(win)) {
            return { success: false, error: result.error || "Editor did not accept the file" };
          }
          // Pending ownership keeps the source alive while opening, but only
          // accepted tabs may close the source copy during window cleanup.
          owner.accepted = true;
          showAndFocusWindow(win);
          return { success: true, reused };
        } catch (error) {
          return { success: false, error: error?.message || "Failed to open editor tab" };
        } finally {
          if (!owner.accepted && tabSources.get(snapshot.editorId) === owner) tabSources.delete(snapshot.editorId);
        }
      })();
      return owner.opening;
    }

    async function openEditorWindow(electronModule, options, payload) {
      const snapshot = sanitizeEditorSnapshot(payload);
      if (!snapshot) return { success: false, error: "Invalid editor payload" };

      const { BrowserWindow, shell } = electronModule;
      const { preload, devServerUrl, isDev, appIcon, isMac, electronDir, sourceWindow, sourceWebContents } = options;
      const source = sourceWebContents || sourceWindow?.webContents;

      const existing = getEditorWindow();
      if (existing) {
        return sendOpenTab(electronModule, existing, snapshot, source, true);
      }

      const osTheme = electronModule?.nativeTheme?.shouldUseDarkColors ? "dark" : "light";
      const effectiveTheme = currentTheme === "dark" || currentTheme === "light" ? currentTheme : osTheme;
      const frontendBackground = resolveFrontendBackgroundColor(electronDir || __dirname, effectiveTheme);
      const backgroundColor = frontendBackground || "#1a1a1a";
      const { x: editorX, y: editorY } = resolveSettingsWindowBounds(electronModule, {
        sourceWindow: sourceWindow || mainWindow,
        settingsWidth: EDITOR_WIDTH,
        settingsHeight: EDITOR_HEIGHT,
      });

      const windowsChrome = windowsFramelessContentChromeOptions();
      let editorWindowCloseConfirmed = false;
      let nativeClosePending = false;
      const win = new BrowserWindow({
        title: snapshot.fileName,
        width: EDITOR_WIDTH,
        height: EDITOR_HEIGHT,
        ...(editorX !== undefined && editorY !== undefined ? { x: editorX, y: editorY } : {}),
        minWidth: 640,
        minHeight: 420,
        backgroundColor,
        icon: appIcon,
        show: false,
        frame: false,
        ...(isMac ? { trafficLightPosition: { x: 12, y: 12 } } : {}),
        ...windowsChrome,
        webPreferences: {
          preload,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          spellcheck: false,
          backgroundThrottling: false,
          v8CacheOptions: V8_CACHE_OPTIONS,
        },
      });
      editorWindow = win;

      const releaseLifecycle = () => {
        if (editorWindow === win) {
          editorWindow = null;
          editorWindowLoaded = null;
        }
        const leftoverIds = Array.from(tabSources.keys());
        notifySourcesTabsClosed(electronModule, leftoverIds);
        tabSources.clear();
        unregisterAppContentWindow(win);
        notifyAppContentWindowClosed(win);
      };

      registerAppContentWindow(win, { queryDirtyEditors: true });

      try {
        win.webContents?.setWindowOpenHandler?.(createExternalOnlyWindowOpenHandler(shell));
      } catch {
        // ignore
      }

      win.on("close", (event) => {
        if (isQuitting || editorWindowCloseConfirmed) return;
        event.preventDefault();
        if (nativeClosePending) return;
        nativeClosePending = true;
        // OS close (Alt+F4/titlebar) uses the same renderer Save/Discard/Cancel
        // flow as closing an owner or a tab, rather than a dirty-only veto.
        closeEditorTabs(electronModule, { editorIds: Array.from(tabSources.keys()) })
          .then((result) => {
            if (!result.success || result.cancelled) return;
            editorWindowCloseConfirmed = true;
            if (isLiveWindow(win)) win.close();
          })
          .catch((error) => {
            console.warn("[EditorWindow] Close confirmation failed", error);
          })
          .finally(() => { nativeClosePending = false; });
      });
      win.on("closed", releaseLifecycle);
      win.on("page-title-updated", (e) => { e.preventDefault(); });

      try {
        win.setBackgroundColor(backgroundColor);
      } catch {
        // ignore
      }
      applyWindowOpacityToWindow(win);

      if (isMac) {
        try {
          win.setWindowButtonVisibility(true);
        } catch {
          // ignore
        }
        try {
          win.setWindowButtonPosition({ x: 12, y: 12 });
        } catch {
          // ignore
        }
      }

      // loadURL only guarantees document load, not that React installed the
      // receiver. Subscribe before navigation so a fast renderer cannot race us.
      const rendererReady = new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout);
          electronModule.ipcMain.removeListener("netcatty:window:editorReady", onReady);
          win.removeListener("closed", onClosed);
        };
        const onReady = (event) => {
          if (event.sender !== win.webContents) return;
          cleanup();
          resolve();
        };
        const onClosed = () => {
          cleanup();
          reject(new Error("Editor window closed before it was ready"));
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Timed out waiting for editor receiver"));
        }, OPEN_TAB_TIMEOUT_MS);
        electronModule.ipcMain.on("netcatty:window:editorReady", onReady);
        win.once("closed", onClosed);
      });
      const editorPath = "#/editor-window";
      const loadRenderer = async () => {
        try {
          if (isDev) {
            try {
              const baseUrl = getDevRendererBaseUrl(devServerUrl);
              await win.loadURL(`${baseUrl}${editorPath}`);
            } catch (e) {
              console.warn("[EditorWindow] Dev server not reachable", e);
              await win.loadURL(`app://netcatty/index.html${editorPath}`);
            }
          } else {
            await win.loadURL(`app://netcatty/index.html${editorPath}`);
          }
        } catch (error) {
          if (isLiveWindow(win)) win.destroy();
          throw error;
        }
      };
      editorWindowLoaded = Promise.all([loadRenderer(), rendererReady]).catch((error) => {
        if (isLiveWindow(win)) win.destroy();
        throw error;
      });
      return sendOpenTab(electronModule, win, snapshot, source, false);
    }

    function focusEditorTab(electronModule, editorId) {
      const win = getEditorWindow();
      if (!win) return { success: false, error: "Editor window is not open" };
      try {
        if (typeof editorId === "string" && editorId) {
          win.webContents.send("netcatty:window:editorActivateTab", { editorId });
        }
        showAndFocusWindow(win);
        return { success: true };
      } catch (err) {
        return { success: false, error: err?.message || "Failed to focus editor window" };
      }
    }

    async function closeEditorTabs(electronModule, payload) {
      const editorIds = Array.isArray(payload?.editorIds)
        ? payload.editorIds.filter((id) => typeof id === "string" && id)
        : [];
      if (editorIds.length === 0) return { success: true, cancelled: false, closedIds: [] };
      // Closing an owner or a placeholder during cold start must not overtake
      // its open receipt. Reuse the same readiness/ownership boundary.
      const opening = editorIds.map((id) => tabSources.get(id)?.opening).filter(Boolean);
      const opened = await Promise.all(opening);
      if (opened.some((result) => !result.success)) {
        return { success: false, cancelled: true, closedIds: [], error: "Editor transfer did not complete" };
      }
      try {
        await editorWindowLoaded;
      } catch (error) {
        return { success: false, cancelled: true, closedIds: [], error: error?.message || "Editor is not ready" };
      }
      const win = getEditorWindow();
      if (!win) {
        notifySourcesTabsClosed(electronModule, editorIds);
        return { success: true, cancelled: false, closedIds: editorIds };
      }
      const force = payload?.force === true;
      if (!force) showAndFocusWindow(win);
      const result = await invokeWebContents(
        electronModule,
        win.webContents,
        "netcatty:window:editorCloseTabs",
        "netcatty:window:editorCloseTabsResult",
        { editorIds, force },
        force ? CLOSE_TABS_FORCE_TIMEOUT_MS : CLOSE_TABS_PROMPT_TIMEOUT_MS,
      );
      if (!result.success) {
        if (force) {
          try {
            win.webContents.send("netcatty:window:editorCloseTabs", {
              requestId: randomUUID(),
              editorIds,
              force: true,
            });
          } catch {
            // ignore
          }
          notifySourcesTabsClosed(electronModule, editorIds);
          return { success: true, cancelled: false, closedIds: editorIds };
        }
        return { success: false, cancelled: true, closedIds: [], error: result.error };
      }
      const closedIds = Array.isArray(result.closedIds) ? result.closedIds : [];
      notifySourcesTabsClosed(electronModule, closedIds);
      if (result.cancelled === true) {
        return { success: true, cancelled: true, closedIds };
      }
      return { success: true, cancelled: false, closedIds };
    }

    async function saveEditorTab(electronModule, payload) {
      const snapshotLike = sanitizeEditorSnapshot({
        ...payload,
        fileName: payload?.fileName || "file",
        content: payload?.content,
        baselineContent: payload?.content,
        languageId: "plaintext",
        wordWrap: false,
        viewState: null,
      });
      if (!snapshotLike) return { ok: false, error: "Invalid save payload" };
      const source = resolveSourceWebContents(electronModule, snapshotLike.editorId);
      if (!source) return { ok: false, error: "SFTP editor bridge not registered — cannot save (no SFTP view mounted)" };
      const result = await invokeWebContents(
        electronModule,
        source,
        "netcatty:window:editorSaveRequest",
        "netcatty:window:editorSaveResult",
        {
          editorId: snapshotLike.editorId,
          sessionId: snapshotLike.sessionId,
          sftpTabId: snapshotLike.sftpTabId,
          hostId: snapshotLike.hostId,
          remotePath: snapshotLike.remotePath,
          content: typeof payload?.content === "string" ? payload.content : "",
        },
        SAVE_TIMEOUT_MS,
      );
      if (!result.success) return { ok: false, error: result.error || "Save failed" };
      if (result.ok === false) return { ok: false, error: result.error || "Save failed" };
      if (typeof result.liveConnectionId === "string" && result.liveConnectionId) {
        const win = getEditorWindow();
        try {
          win?.webContents.send("netcatty:window:editorRemapSession", {
            fromSessionId: snapshotLike.sessionId,
            toSessionId: result.liveConnectionId,
          });
        } catch {
          // ignore
        }
      }
      return {
        ok: true,
        liveConnectionId: result.liveConnectionId,
      };
    }

    async function dockEditorTab(electronModule, payload) {
      const snapshot = sanitizeEditorSnapshot(payload);
      if (!snapshot) return { success: false, error: "Invalid dock payload" };
      const source = resolveSourceWebContents(electronModule, snapshot.editorId);
      if (!source) return { success: false, error: "Source window is gone" };
      const result = await invokeWebContents(
        electronModule,
        source,
        "netcatty:window:editorDockRequest",
        "netcatty:window:editorDockResult",
        snapshot,
        DOCK_TIMEOUT_MS,
      );
      if (!result.success || result.ok === false) {
        return { success: false, error: result.error || "Failed to dock editor tab" };
      }
      tabSources.delete(snapshot.editorId);
      return { success: true };
    }

    function reportEditorDirty(electronModule, payload) {
      const editorId = typeof payload?.editorId === "string" ? payload.editorId : "";
      if (!editorId) return;
      const source = resolveSourceWebContents(electronModule, editorId);
      if (!source) return;
      try {
        source.send("netcatty:window:editorDirtyChanged", {
          editorId,
          dirty: payload?.dirty === true,
        });
      } catch {
        // ignore
      }
    }

    function reportEditorTabsClosed(electronModule, payload) {
      const editorIds = Array.isArray(payload?.editorIds)
        ? payload.editorIds.filter((id) => typeof id === "string" && id)
        : (typeof payload?.editorId === "string" ? [payload.editorId] : []);
      notifySourcesTabsClosed(electronModule, editorIds);
    }

    function remapEditorSession(electronModule, payload) {
      const fromSessionId = typeof payload?.fromSessionId === "string" ? payload.fromSessionId : "";
      const toSessionId = typeof payload?.toSessionId === "string" ? payload.toSessionId : "";
      if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return;
      const win = getEditorWindow();
      if (!win) return;
      try {
        win.webContents.send("netcatty:window:editorRemapSession", { fromSessionId, toSessionId });
      } catch {
        // ignore
      }
    }

    return {
      openEditorWindow,
      hasEditorTabsForSource,
      closeEditorTabsForSource,
      focusEditorTab,
      closeEditorTabs,
      saveEditorTab,
      dockEditorTab,
      reportEditorDirty,
      reportEditorTabsClosed,
      remapEditorSession,
      getEditorWindow,
    };
  }
}

module.exports = { createEditorWindowApi };
