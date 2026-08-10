/**
 * SftpSidePanel - SFTP file browser rendered as a resizable side panel
 *
 * Reuses SftpView's components (SftpPaneView, SftpContextProvider, etc.)
 * to provide a unified SFTP experience. Renders a single pane (left side only).
 *
 * IMPORTANT: Does NOT use the global activeTabStore to avoid conflicts with
 * the main SftpView tab. Instead manages pane visibility internally.
 *
 * Used in TerminalLayer to provide SFTP alongside terminal sessions.
 */

import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { SftpSidePanelDeferredMount } from "./SftpSidePanelDeferredMount";
import { TERMINAL_SIDE_PANEL_INNER_HEADER_CLASS } from "./terminalLayer/terminalSidePanelChrome";
import { formatHostPort } from "../domain/host";
import { useI18n } from "../application/i18n/I18nProvider";
import { useSftpState } from "../application/state/useSftpState";
import {
  useReportSftpTransferOwnerActivity,
} from "../application/state/sftp/useSftpTransferLifecycle";
import { registerEditorSftpWriterScoped } from "../application/state/editorSftpBridge";
import {
  editorTabStore,
  useEditorTabPresenceRevision,
} from "../application/state/editorTabStore";
import { releaseEditorTabSaveCoordinator } from "../application/state/editorTabSave";
import { useSftpBackend } from "../application/state/useSftpBackend";
import { useSftpFileAssociations } from "../application/state/useSftpFileAssociations";
import { getParentPath, isConcreteTransferTargetPath } from "../application/state/sftp/utils";
import { buildCacheKey } from "../application/state/sftp/sharedRemoteHostCache";
import { resolveSftpAutoConnectPath } from "../application/state/sftp/sftpReopenLocation";
import {
  isBrowseSessionInteractive,
  listRemoteBrowseConnectionIds,
  listRemoteBrowseSftpTabIds,
} from "../application/state/sftp/browseSessionLifecycle";
import { logger } from "../lib/logger";
import type { DropEntry } from "../lib/sftpFileUtils";
import { Host, Identity, KnownHost, SSHKey } from "../types";
import type { TransferTask } from "../types";
import { toast } from "./ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { DistroAvatar } from "./DistroAvatar";
import { reportSftpUploadResults } from "./sftp/reportSftpUploadResults";

import { SftpPaneView } from "./sftp/SftpPaneView";
import { SftpOverlays } from "./sftp/SftpOverlays";
import { SftpTransferQueue } from "./sftp/SftpTransferQueue";
import { SftpContextProvider } from "./sftp";
import { useSftpViewPaneCallbacks } from "./sftp/hooks/useSftpViewPaneCallbacks";
import { useSftpViewTabs } from "./sftp/hooks/useSftpViewTabs";
import { useSftpKeyboardShortcuts } from "./sftp/hooks/useSftpKeyboardShortcuts";
import { sftpFocusStore } from "../application/state/sftp/sftpFocusStore";
import { keepOnlyPaneSelections } from "./sftp/hooks/selectionScope";
import { KeyBinding, HotkeyScheme } from "../domain/models";
import {
  mergeLatestFollowTerminalCwdHostSetting,
  runInitialFollowTerminalCwdSync,
  resolveHostFollowTerminalCwd,
  shouldApplyFollowTerminalCwdSyncResult,
  shouldClearBlockedFollowOnReach,
  shouldFollowTerminalCwdNavigate,
  type SftpFollowTerminalCwdBlock,
} from "./sftp/sftpFollowTerminalCwd";
import {
  canLocateSftpPathInTerminal,
  resolveLocateSftpPathInTerminalAction,
  resolveLocateSftpPathSessionId,
} from "../domain/sftpLocatePathInTerminal";
import { classifyDistroId } from "../domain/host";
import { useTerminalBackend } from "../application/state/useTerminalBackend";
import { isTerminalSensitiveInputActive } from "./terminal/runtime/terminalSensitiveInputRegistry";
import { isTerminalReadyForCommandInjection } from "./terminal/runtime/terminalCommandInjectionReadyRegistry";
import { getNextSftpToolbarDisplayPath } from "./sftp/SftpPaneToolbar";
import { scheduleDeferredTerminalFocus } from "./systemManager/tmuxActionFocus";
import {
  connectionKeyMatchesHost,
  findReusableSftpSidePanelTab,
  shouldAcceptPendingSftpUpload,
  shouldResetSftpSidePanelSourceSession,
  shouldSkipSftpSidePanelAutoConnect,
} from "./sftp/sftpSidePanelAutoConnect";
import {
  pruneSftpSidePanelTabConnectionKeys,
  recallSftpSidePanelPath,
  rememberSftpSidePanelPath,
} from "./sftp/sftpSidePanelConnectionMemory";
import {
  listSftpConnectedHosts,
  resolveSftpTransferSourceSessionId,
  sftpHostEndpointsEqual,
  sftpPickerSessionsEqual,
} from "../domain/sftpConnectedHosts";
import type { TerminalSession } from "../domain/models";

interface SftpSidePanelProps {
  transferOwnerId: string;
  hosts: Host[];
  writableHosts?: Host[];
  sessions?: TerminalSession[];
  keys: SSHKey[];
  identities: Identity[];
  knownHosts?: KnownHost[];
  updateHosts: (hosts: Host[]) => void;
  onAddKnownHost?: (knownHost: KnownHost) => void;
  sftpDefaultViewMode: "list" | "tree";
  /** The host to connect to (follows focused terminal) */
  activeHost: Host | null;
  /** The terminal session id whose SSH connection can be reused for SFTP */
  activeSessionId?: string | null;
  /** Focused terminal session (includes mosh/et/local) for locate-path writes */
  focusedSessionId?: string | null;
  initialLocation?: { hostId: string; path: string } | null;
  onInitialLocationApplied?: (location: { hostId: string; path: string }) => void;
  onCurrentPathChange?: (location: { hostId: string; connectionKey: string; path: string }) => void;
  onActiveTransfersChange?: (count: number) => void;
  /** External-editor temps that must keep this owner mounted after panel close. */
  onActiveExternalEditsChange?: (count: number) => void;
  showWorkspaceHostHeader?: boolean;
  isVisible?: boolean;
  renderOverlays?: boolean;
  pendingUpload?: {
    requestId: string;
    hostId: string;
    connectionKey: string;
    targetPath?: string;
    entries: DropEntry[];
  } | null;
  onPendingUploadHandled?: (requestId: string) => void;
  sftpDoubleClickBehavior: "open" | "transfer";
  sftpAutoSync: boolean;
  sftpShowHiddenFiles: boolean;
  sftpUseCompressedUpload: boolean;
  hotkeyScheme: HotkeyScheme;
  keyBindings: KeyBinding[];
  editorWordWrap: boolean;
  setEditorWordWrap: (value: boolean) => void;
  onGetTerminalCwd?: (options?: {
    preferFreshBackend?: boolean;
    allowRendererFallback?: boolean;
  }) => Promise<string | null>;
  activeTerminalCwd?: string | null;
  sftpFollowTerminalCwd?: boolean;
  onSftpFollowTerminalCwdChange?: (enabled: boolean, host?: Host | null) => void;
  onRequestTerminalFocus?: () => void;
  terminalSettings?: { keepaliveInterval: number; keepaliveCountMax: number };
}

const SftpSidePanelInner: React.FC<SftpSidePanelProps> = ({
  transferOwnerId,
  hosts,
  writableHosts,
  sessions = [],
  keys,
  identities,
  knownHosts = [],
  updateHosts,
  onAddKnownHost,
  sftpDefaultViewMode,
  activeHost,
  activeSessionId,
  focusedSessionId = null,
  initialLocation,
  onInitialLocationApplied,
  onCurrentPathChange,
  onActiveTransfersChange,
  onActiveExternalEditsChange,
  showWorkspaceHostHeader = false,
  isVisible = true,
  renderOverlays = true,
  pendingUpload = null,
  onPendingUploadHandled,
  sftpDoubleClickBehavior,
  sftpAutoSync,
  sftpShowHiddenFiles,
  sftpUseCompressedUpload,
  hotkeyScheme,
  keyBindings,
  editorWordWrap,
  setEditorWordWrap,
  onGetTerminalCwd,
  activeTerminalCwd = null,
  sftpFollowTerminalCwd = false,
  onSftpFollowTerminalCwdChange,
  onRequestTerminalFocus,
  terminalSettings,
}) => {
  const { t } = useI18n();

  const hostWriteSource = writableHosts ?? hosts;
  const connectedHosts = useMemo(() => {
    const hostsById = new Map<string, Host>(
      hosts.map((host) => [host.id, host]),
    );
    return listSftpConnectedHosts(sessions, hostsById);
  }, [hosts, sessions]);

  const resolveTransferSourceSessionId = useCallback((hostId: string, host?: Host) => {
    const hostsById = new Map<string, Host>(hosts.map((h) => [h.id, h]));
    // Walk all sessions (not the picker one-per-hostId list) so multi-tab
    // same hostId with different live endpoints can still match.
    return resolveSftpTransferSourceSessionId(sessions, hostsById, hostId, host);
  }, [hosts, sessions]);

  // Browse restore can run before the session list reflects the focused tab;
  // prefer the active source when its visible endpoint matches the pane host.
  const resolveBrowseSourceSessionId = useCallback((hostId: string, host?: Host) => {
    if (
      activeSessionId
      && activeHost
      && activeHost.id === hostId
      && (!host || sftpHostEndpointsEqual(activeHost, host))
    ) {
      return activeSessionId;
    }
    return resolveTransferSourceSessionId(hostId, host);
  }, [activeHost, activeSessionId, resolveTransferSourceSessionId]);

  const fileWatchHandlers = useMemo(() => ({
    onFileWatchSynced: (payload: { remotePath: string }) => {
      const fileName = payload.remotePath.split('/').pop() || payload.remotePath;
      toast.success(t('sftp.autoSync.success', { fileName }));
      logger.info("[SFTP] File auto-synced to remote", payload);
    },
    onFileWatchError: (payload: { error: string }) => {
      toast.error(t('sftp.autoSync.error', { error: payload.error }));
      logger.error("[SFTP] File auto-sync failed", payload);
    },
  }), [t]);

  const ownedEditorSessionIdsRef = useRef<ReadonlySet<string>>(new Set());
  const ownedEditorSftpTabIdsRef = useRef<ReadonlySet<string>>(new Set());
  const activeExternalEditCountRef = useRef(0);
  // Re-render on tab open/close/session remap only — not on every editor keystroke.
  useEditorTabPresenceRevision();
  const hasOwnedEditorTab = editorTabStore.hasOwnedEditorForSftpOwner({
    sessionIds: ownedEditorSessionIdsRef.current,
    sftpTabIds: ownedEditorSftpTabIdsRef.current,
  });

  const sftpOptions = useMemo(() => ({
    ...fileWatchHandlers,
    transferOwnerId,
    canPrepareTransferAdoption: isVisible,
    // Drive progress React paints: false while retained-but-hidden after close.
    surfaceVisible: isVisible,
    // A promoted editor still saves through this owner after the side panel
    // becomes hidden, so its browse channel must stay alive until the editor closes.
    // External editor temps (Notepad++ etc.) likewise need the session: parking
    // calls closeSftp which deletes those local files.
    interactive: isBrowseSessionInteractive({
      surfaceVisible: isVisible,
      hasOwnedEditorTab,
      hasActiveExternalEdit: activeExternalEditCountRef.current > 0,
    }),
    useCompressedUpload: sftpUseCompressedUpload,
    defaultShowHiddenFiles: sftpShowHiddenFiles,
    autoConnectLocalOnMount: false,
    terminalSettings,
    knownHosts,
    onAddKnownHost,
    resolveTransferSourceSessionId,
    resolveBrowseSourceSessionId,
  }), [
    fileWatchHandlers,
    hasOwnedEditorTab,
    isVisible,
    transferOwnerId,
    sftpUseCompressedUpload,
    sftpShowHiddenFiles,
    terminalSettings,
    knownHosts,
    onAddKnownHost,
    resolveTransferSourceSessionId,
    resolveBrowseSourceSessionId,
  ]);

  const sftp = useSftpState(hosts, keys, identities, sftpOptions);
  activeExternalEditCountRef.current = sftp.activeExternalEditCount ?? 0;
  ownedEditorSessionIdsRef.current = new Set(
    listRemoteBrowseConnectionIds([
      ...sftp.leftTabs.tabs,
      ...sftp.rightTabs.tabs,
    ]),
  );
  ownedEditorSftpTabIdsRef.current = new Set(
    listRemoteBrowseSftpTabIds([
      ...sftp.leftTabs.tabs,
      ...sftp.rightTabs.tabs,
    ]),
  );
  const {
    showSaveDialog,
    selectDirectory,
    listSftp,
    mkdirLocal,
    deleteLocalFile,
    listLocalDir,
    listDrives,
    openPath,
  } = useSftpBackend();

  const sftpRef = useRef(sftp);
  sftpRef.current = sftp;

  const { getConnectionCacheKey, leftPane } = sftp;

  useEffect(() => {
    /** Per-task locks so resume-all can prepare multiple transfers sequentially. */
    const connectingTaskIds = new Set<string>();
    const queue: Array<() => Promise<void>> = [];
    let draining = false;

    const drain = async () => {
      if (draining) return;
      draining = true;
      try {
        while (queue.length > 0) {
          const job = queue.shift();
          if (job) await job();
        }
      } finally {
        draining = false;
      }
    };

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{
        task: TransferTask;
        targetOwnerId: string;
        reportFailure?: (error: string) => void;
      }>).detail;
      if (detail?.targetOwnerId !== transferOwnerId) return;
      const task = detail.task;
      if (!task) return;
      if (connectingTaskIds.has(task.id)) return;

      queue.push(async () => {
        connectingTaskIds.add(task.id);
        try {
          const resolveHost = (hostId?: string, hostLabel?: string) => {
            if (!hostId && !hostLabel) return "local" as const;
            const byId = hostId ? hosts.find((host) => host.id === hostId) : undefined;
            if (byId) return byId;
            const needle = (hostLabel || "").trim().toLowerCase();
            if (!needle) return undefined;
            return hosts.find((host) => (
              (host.label || "").trim().toLowerCase() === needle
              || (host.hostname || "").trim().toLowerCase() === needle
            ));
          };
          const source = resolveHost(task.sourceHostId, task.sourceHostLabel);
          const target = resolveHost(task.targetHostId, task.targetHostLabel);
          if (!source || !target) {
            const missingEndpoint = !source ? "source" : "target";
            detail.reportFailure?.(
              `Cannot find the ${missingEndpoint} host in your vault. Resume will try a dedicated connection, or re-add the host.`,
            );
            return;
          }
          const sourceDirectory = task.isDirectory ? task.sourcePath : getParentPath(task.sourcePath);
          const targetDirectory = task.isDirectory ? task.targetPath : getParentPath(task.targetPath);
          // Downloads only need the remote source; still open local on the other
          // pane so adoption can match both endpoints for stream restarts.
          if (source !== "local") {
            await sftpRef.current.connect("left", source, {
              forceNewTab: true,
              initialPath: sourceDirectory,
            });
            const sourcePane = sftpRef.current.leftPane;
            if (sourcePane.connection?.status !== "connected") {
              throw new Error(sourcePane.connection?.error || sourcePane.error || "Source server authentication failed");
            }
          } else {
            await sftpRef.current.connect("left", "local", {
              forceNewTab: true,
              initialPath: sourceDirectory,
            });
          }
          if (target !== "local") {
            await sftpRef.current.connect("right", target, {
              forceNewTab: true,
              initialPath: targetDirectory,
            });
            const targetPane = sftpRef.current.rightPane;
            if (targetPane.connection?.status !== "connected") {
              throw new Error(targetPane.connection?.error || targetPane.error || "Target server authentication failed");
            }
          } else {
            await sftpRef.current.connect("right", "local", {
              forceNewTab: true,
              initialPath: targetDirectory,
            });
            const targetPane = sftpRef.current.rightPane;
            if (targetPane.connection?.status !== "connected") {
              throw new Error(targetPane.connection?.error || targetPane.error || "Local folder is unavailable");
            }
          }
        } catch (error) {
          detail.reportFailure?.(error instanceof Error ? error.message : String(error));
        } finally {
          connectingTaskIds.delete(task.id);
        }
      });
      void drain();
    };
    window.addEventListener("netcatty:prepare-sftp-transfer-resume", handler);
    return () => window.removeEventListener("netcatty:prepare-sftp-transfer-resume", handler);
  }, [hosts, transferOwnerId]);

  useReportSftpTransferOwnerActivity({
    ownerId: transferOwnerId,
    activeTransfersCount: sftp.activeTransfersCount,
    onActiveTransfersChange,
  });

  // Parent retain-on-close only sees transfers unless we also publish external
  // editor temp activity (closeSftp deletes those files on unmount).
  const onActiveExternalEditsChangeRef = useRef(onActiveExternalEditsChange);
  onActiveExternalEditsChangeRef.current = onActiveExternalEditsChange;
  useLayoutEffect(() => {
    onActiveExternalEditsChangeRef.current?.(sftp.activeExternalEditCount ?? 0);
  }, [sftp.activeExternalEditCount]);

  // Register this instance's writeTextFileByConnection with the editor bridge
  // so editor tabs promoted from SFTP files opened in a terminal side panel
  // can still route saves through this useSftpState.
  //
  // Intentionally no deps — go through sftpRef so SFTP state churn (transfers,
  // tab switches, listings) doesn't make this unregister+reregister on every
  // re-render.
  useEffect(() => {
    return registerEditorSftpWriterScoped((connectionId, expectedHostId, filePath, content, encoding, sftpTabId) =>
      sftpRef.current.writeTextFileByConnection(connectionId, expectedHostId, filePath, content, encoding, sftpTabId),
    );
  }, []);

  // When this side panel unmounts (its hosting terminal tab was closed) we
  // force-close any editor tabs bound to connections this panel owned — the
  // save channel is gone with the SFTP session and there's no way to recover
  // it. Dirty state is dropped intentionally; the user closed the terminal
  // knowing the file was open.
  //
  // Collect every connection id across all left/right tabs — the panel can
  // host multiple SFTP tabs per side, and an editor tab promoted from an
  // inactive-pane tab would otherwise be stranded by the unmount.
  useEffect(() => {
    return () => {
      const s = sftpRef.current;
      if (!s) return;
      const ownedSessionIds: string[] = [];
      const ownedSftpTabIds: string[] = [];
      for (const tab of [...(s.leftTabs?.tabs ?? []), ...(s.rightTabs?.tabs ?? [])]) {
        ownedSftpTabIds.push(tab.id);
        const id = tab.connection?.id;
        if (id) ownedSessionIds.push(id);
      }
      if (ownedSessionIds.length === 0 && ownedSftpTabIds.length === 0) return;
      const closed = editorTabStore.forceCloseByOwners({
        sessionIds: ownedSessionIds,
        sftpTabIds: ownedSftpTabIds,
      });
      closed.forEach(releaseEditorTabSaveCoordinator);
    };
  }, []);

  const behaviorRef = useRef(sftpDoubleClickBehavior);
  behaviorRef.current = sftpDoubleClickBehavior;

  const autoSyncRef = useRef(sftpAutoSync);
  autoSyncRef.current = sftpAutoSync;

  const connectedKeyRef = useRef<string | null>(null);
  const connectedHostObjRef = useRef<Host | null>(null);
  const lastSourceSessionIdRef = useRef<string | null>(null);
  const lastAppliedInitialLocationKeyRef = useRef<string | null>(null);
  const handledPendingUploadIdRef = useRef<string | null>(null);
  const tabConnectionKeyMapRef = useRef<Map<string, string>>(new Map());
  /** Last browsed path per endpoint — survives session switches while the panel stays open. */
  const lastBrowsedPathByConnectionKeyRef = useRef<Map<string, string>>(new Map());
  const [interactiveWorkActive, setInteractiveWorkActive] = useState(false);
  const [sftpUiReady, setSftpUiReady] = useState(false);

  useEffect(() => {
    pruneSftpSidePanelTabConnectionKeys(
      tabConnectionKeyMapRef.current,
      [
        ...sftp.leftTabs.tabs.map((tab) => tab.id),
        ...sftp.rightTabs.tabs.map((tab) => tab.id),
      ],
    );
  }, [sftp.leftTabs.tabs, sftp.rightTabs.tabs]);

  const runAutoConnect = useCallback(() => {
    if (!activeHost) return;

    const s = sftpRef.current;
    const hasActiveWork = interactiveWorkActive
      || (s.activeFileWatchCountRef?.current ?? 0) > 0
      || (s.activeExternalEditCount ?? 0) > 0;

    const proto = activeHost.protocol;
    if (proto === 'serial' || activeHost.id?.startsWith('serial-')) {
      connectedKeyRef.current = null;
      return;
    }
    if (proto === 'local' || activeHost.id?.startsWith('local-')) {
      if (hasActiveWork) return;
      const leftConn = s.leftPane.connection;
      if (leftConn?.isLocal) {
        connectedKeyRef.current = "local";
        return;
      }
      const existingLocalTab = s.leftTabs.tabs.find((tab) =>
        tab.connection?.isLocal && tab.connection.status === "connected",
      );
      if (existingLocalTab) {
        s.selectTab("left", existingLocalTab.id);
        connectedKeyRef.current = "local";
        return;
      }
      connectedKeyRef.current = "local";
      const needsNewTab = !!(leftConn && leftConn.status === "connected");
      if (needsNewTab) {
        s.connect("left", "local", { forceNewTab: true });
      } else if (leftConn) {
        void s.disconnect("left").then(() => s.connect("left", "local"));
      } else {
        s.connect("left", "local");
      }
      return;
    }

    const connectionKey = buildCacheKey(
      activeHost.id,
      activeHost.hostname,
      activeHost.port,
      activeHost.protocol,
      activeHost.sftpSudo,
      activeHost.username,
      activeHost.sftpFileProtocol,
    );
    const sessionChanged = shouldResetSftpSidePanelSourceSession(
      lastSourceSessionIdRef.current,
      activeSessionId,
    );

    const hasBackendSession = (connectionId: string) => !!s.getSftpIdForConnection(connectionId);
    const activeTab = s.leftTabs.tabs.find((tab) => tab.id === s.leftTabs.activeTabId) ?? null;
    const activeConnectionId = activeTab?.connection?.id;
    const liveConnectionKey = activeConnectionId
      ? s.getConnectionCacheKey?.(activeConnectionId) ?? null
      : null;
    const activeTabConnectionKey = liveConnectionKey
      ?? (activeTab ? tabConnectionKeyMapRef.current.get(activeTab.id) ?? null : null);
    if (activeTab && activeTabConnectionKey) {
      tabConnectionKeyMapRef.current.set(activeTab.id, activeTabConnectionKey);
    }
    // Rebind when the focused terminal session changes: saved host keys can lag
    // live session endpoints (edited host / unsaved user). Still keep the
    // browsed path sticky via remembered initialPath below.
    if (
      !sessionChanged
      && shouldSkipSftpSidePanelAutoConnect(
        connectionKey,
        connectedKeyRef.current,
        activeTab,
        activeConnectionId ? hasBackendSession(activeConnectionId) : false,
        activeTabConnectionKey,
      )
    ) {
      if (activeSessionId) {
        lastSourceSessionIdRef.current = activeSessionId;
      }
      return;
    }
    // Defer advancing the session cursor while interactive work blocks rebind,
    // so sessionChanged stays true once the editor/dialog closes.
    if (hasActiveWork) return;
    if (activeSessionId) {
      lastSourceSessionIdRef.current = activeSessionId;
    }

    logger.info("[SftpSidePanel] Auto-connect triggered", {
      hostId: activeHost.id,
      hostLabel: activeHost.label,
      protocol: activeHost.protocol,
      hostname: activeHost.hostname,
      sessionChanged,
    });

    const tabs = s.leftTabs.tabs;
    // Session focus changes must rebind SFTP onto the new terminal SSH session
    // (proxy/jump path can differ even when hostId/hostname/port/user match).
    // Same-endpoint rebind happens in place below with remembered initialPath so
    // we keep the browsed directory without stacking tabs.
    const existingTab = sessionChanged
      ? null
      : findReusableSftpSidePanelTab(
        tabs,
        activeHost.id,
        connectionKey,
        tabConnectionKeyMapRef.current,
        hasBackendSession,
        (connectionId) => s.getConnectionCacheKey?.(connectionId) ?? null,
      );
    if (existingTab) {
      s.selectTab("left", existingTab.id);
      // selectTab does not update reconnect metadata; keep lastConnectedHost
      // aligned with the tab we just activated so channel drops rebind correctly.
      // Pass tab id explicitly — selectTab has not flushed activeTabId yet.
      s.setLastConnectedHost?.("left", activeHost, existingTab.id);
      connectedKeyRef.current = connectionKey;
      connectedHostObjRef.current = activeHost;
      // Session memory keys are per terminal session; republish the visible
      // path so reopening SFTP from the newly focused session keeps this dir.
      const path = existingTab.connection?.currentPath;
      if (
        path
        && existingTab.connection
        && !existingTab.connection.isLocal
      ) {
        onCurrentPathChangeRef.current?.({
          hostId: existingTab.connection.hostId,
          connectionKey,
          path,
        });
      }
      return;
    }

    // Capture the visible path before rebind so session switches keep it even
    // if the path-memory effect has not written this endpoint yet.
    if (
      sessionChanged
      && activeTab?.connection
      && !activeTab.connection.isLocal
      && activeTab.connection.status === "connected"
      && activeTab.connection.currentPath
      && activeTabConnectionKey === connectionKey
    ) {
      rememberSftpSidePanelPath(
        lastBrowsedPathByConnectionKeyRef.current,
        connectionKey,
        activeTab.connection.currentPath,
      );
      onCurrentPathChangeRef.current?.({
        hostId: activeTab.connection.hostId,
        connectionKey,
        path: activeTab.connection.currentPath,
      });
    }

    const currentConn = s.leftPane.connection;
    // Replace in place only when it is safe. Keep the old tab when:
    // - local is active (distinct endpoint)
    // - the target endpoint key differs
    // - same-endpoint rebind would drop a connection still used by promoted
    //   editor tabs (they save via the old connection id)
    const currentConnectionKey = currentConn && !currentConn.isLocal
      ? (
        s.getConnectionCacheKey?.(currentConn.id)
        ?? tabConnectionKeyMapRef.current.get(s.leftPane.id)
        ?? null
      )
      : null;
    const hasEditorBoundToCurrentConnection = !!(
      currentConn
      && editorTabStore.getTabs().some((tab) =>
        tab.sessionId === currentConn.id || tab.sftpTabId === s.leftPane.id,
      )
    );
    const hasActiveTransferOnCurrentConnection = !!(
      currentConn
      && s.transfers.some((task) => (
        (task.status === "pending" || task.status === "transferring")
        && (
          task.sourceConnectionId === currentConn.id
          || task.targetConnectionId === currentConn.id
        )
      ))
    );
    const needsNewTab = !!(
      currentConn
      && currentConn.status === "connected"
      && (
        currentConn.isLocal
        || (
          currentConnectionKey
          && currentConnectionKey !== connectionKey
        )
        // Same-endpoint rebind closes the old connection in place; keep a tab
        // when editors or in-flight transfers still depend on that connection id.
        || (
          sessionChanged
          && (hasEditorBoundToCurrentConnection || hasActiveTransferOnCurrentConnection)
        )
      )
    );
    const rememberedPath = recallSftpSidePanelPath(
      lastBrowsedPathByConnectionKeyRef.current,
      connectionKey,
    );
    const initialPath = resolveSftpAutoConnectPath({
      explicitPath:
        initialLocation?.hostId === activeHost.id ? initialLocation.path : null,
      rememberedPath,
    });

    connectedKeyRef.current = connectionKey;
    connectedHostObjRef.current = activeHost;
    s.connect("left", activeHost, {
      sourceSessionId: activeSessionId ?? undefined,
      ...(initialPath ? { initialPath } : undefined),
      ...(needsNewTab ? { forceNewTab: true } : undefined),
      onTabCreated: (tabId) => {
        tabConnectionKeyMapRef.current.set(tabId, connectionKey);
      },
    });
  }, [activeHost, activeSessionId, initialLocation, interactiveWorkActive]);

  useEffect(() => {
    if (!activeHost || !isVisible) return;

    let cancelled = false;
    const frameId = requestAnimationFrame(() => {
      if (!cancelled) runAutoConnect();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
    };
  }, [activeHost, activeSessionId, interactiveWorkActive, isVisible, runAutoConnect]);

  useEffect(() => {
    const connection = sftp.leftPane.connection;
    if (!connection || connection.status === "error" || connection.status === "disconnected") {
      connectedKeyRef.current = null;
    }
  }, [sftp.leftPane.connection, sftp.leftPane.connection?.status]);

  useEffect(() => {
    if (!activeHost || !initialLocation) return;
    if (initialLocation.hostId !== activeHost.id || !initialLocation.path) return;

    const activePane = sftpRef.current.leftPane;
    const connection = activePane.connection;
    if (!connection || connection.isLocal || connection.hostId !== activeHost.id) return;
    if (connection.status !== "connected") return;

    const locationKey = `${connectedKeyRef.current}:${initialLocation.path}`;
    if (lastAppliedInitialLocationKeyRef.current === locationKey) return;

    lastAppliedInitialLocationKeyRef.current = locationKey;
    onInitialLocationApplied?.(initialLocation);

    if (connection.currentPath === initialLocation.path) {
      return;
    }

    sftpRef.current.navigateTo("left", initialLocation.path);
  }, [
    activeHost,
    initialLocation,
    onInitialLocationApplied,
    sftp.leftPane,
  ]);

  const onCurrentPathChangeRef = useRef(onCurrentPathChange);
  onCurrentPathChangeRef.current = onCurrentPathChange;
  useEffect(() => {
    const connection = sftp.leftPane.connection;
    if (!connection || connection.isLocal) return;
    if (connection.status !== "connected") return;
    if (!connection.currentPath) return;

    // Prefer the connect-time endpoint map (includes session overrides / picker
    // switches). Fall back to rebuilding from the host object only when missing.
    let connectionKey =
      sftp.getConnectionCacheKey?.(connection.id)
      ?? tabConnectionKeyMapRef.current.get(sftp.leftPane.id)
      ?? null;
    if (!connectionKeyMatchesHost(connectionKey, connection.hostId)) {
      const host =
        (activeHost?.id === connection.hostId ? activeHost : null)
        ?? hosts.find((candidate) => candidate.id === connection.hostId)
        ?? null;
      if (!host) return;
      connectionKey = buildCacheKey(
        host.id,
        host.hostname,
        host.port,
        host.protocol,
        host.sftpSudo,
        host.username,
        host.sftpFileProtocol,
      );
    }
    tabConnectionKeyMapRef.current.set(sftp.leftPane.id, connectionKey);

    rememberSftpSidePanelPath(
      lastBrowsedPathByConnectionKeyRef.current,
      connectionKey,
      connection.currentPath,
    );
    onCurrentPathChangeRef.current?.({
      hostId: connection.hostId,
      connectionKey,
      path: connection.currentPath,
    });
  }, [
    activeHost,
    hosts,
    sftp,
    sftp.leftPane.connection,
    sftp.leftPane.connection?.currentPath,
    sftp.leftPane.connection?.hostId,
    sftp.leftPane.connection?.status,
    sftp.leftPane.id,
  ]);

  useEffect(() => {
    if (!pendingUpload || !activeHost) return;
    if (handledPendingUploadIdRef.current === pendingUpload.requestId) return;

    const activePane = leftPane;
    const connection = activePane.connection;
    // Prefer the live connection cache key (includes session overrides). Fall
    // back to the tab map only when the connect-time stamp is not yet readable.
    const paneConnectionKey = connection && !connection.isLocal
      ? (
        getConnectionCacheKey?.(connection.id)
        ?? tabConnectionKeyMapRef.current.get(activePane.id)
        ?? null
      )
      : null;
    if (!shouldAcceptPendingSftpUpload({
      pendingHostId: pendingUpload.hostId,
      pendingConnectionKey: pendingUpload.connectionKey,
      activeHostId: activeHost.id,
      connection,
      paneConnectionKey,
    }) || !connection) {
      return;
    }

    handledPendingUploadIdRef.current = pendingUpload.requestId;

    const pinnedConnectionId = connection.id;
    const pinnedTabId = activePane.id;
    const runUpload = async () => {
      try {
        const results = await sftpRef.current.uploadExternalEntries("left", pendingUpload.entries, {
          targetPath: pendingUpload.targetPath,
          connectionId: pinnedConnectionId,
          tabId: pinnedTabId,
        });
        reportSftpUploadResults({ results, t, toast });
      } catch (error) {
        logger.error("[SftpSidePanel] Failed to upload dropped files:", error);
        handledPendingUploadIdRef.current = null;
        toast.error(
          error instanceof Error ? error.message : t("sftp.error.uploadFailed"),
          "SFTP",
        );
        return;
      } finally {
        onPendingUploadHandled?.(pendingUpload.requestId);
      }
    };

    void runUpload();
  }, [
    activeHost,
    getConnectionCacheKey,
    leftPane,
    onPendingUploadHandled,
    pendingUpload,
    t,
  ]);

  return (
    <SftpSidePanelDeferredMount ready={sftpUiReady} onReady={() => setSftpUiReady(true)}>
      <SftpSidePanelInteractiveBody
        hosts={hosts}
        hostWriteSource={hostWriteSource}
        connectedHosts={connectedHosts}
        sessions={sessions}
        updateHosts={updateHosts}
        sftp={sftp}
        sftpRef={sftpRef}
        sftpDefaultViewMode={sftpDefaultViewMode}
        activeHost={activeHost}
        activeSessionId={activeSessionId}
        focusedSessionId={focusedSessionId}
        showWorkspaceHostHeader={showWorkspaceHostHeader}
        renderOverlays={renderOverlays}
        sftpDoubleClickBehavior={sftpDoubleClickBehavior}
        sftpAutoSync={sftpAutoSync}
        hotkeyScheme={hotkeyScheme}
        keyBindings={keyBindings}
        editorWordWrap={editorWordWrap}
        setEditorWordWrap={setEditorWordWrap}
        onGetTerminalCwd={onGetTerminalCwd}
        activeTerminalCwd={activeTerminalCwd}
        sftpFollowTerminalCwd={sftpFollowTerminalCwd}
        onSftpFollowTerminalCwdChange={onSftpFollowTerminalCwdChange}
        onRequestTerminalFocus={onRequestTerminalFocus}
        isVisible={isVisible}
        behaviorRef={behaviorRef}
        autoSyncRef={autoSyncRef}
        connectedHostObjRef={connectedHostObjRef}
        connectedKeyRef={connectedKeyRef}
        onInteractiveWorkChange={setInteractiveWorkActive}
        listSftp={listSftp}
        mkdirLocal={mkdirLocal}
        deleteLocalFile={deleteLocalFile}
        showSaveDialog={showSaveDialog}
        selectDirectory={selectDirectory}
        listLocalDir={listLocalDir}
        listDrives={listDrives}
        openPath={openPath}
        t={t}
      />
    </SftpSidePanelDeferredMount>
  );
};

type SftpSidePanelInteractiveBodyProps = {
  hosts: Host[];
  hostWriteSource: Host[];
  connectedHosts: import("../domain/sftpConnectedHosts").SftpConnectedHostEntry[];
  sessions: TerminalSession[];
  updateHosts: (hosts: Host[]) => void;
  sftp: ReturnType<typeof useSftpState>;
  sftpRef: MutableRefObject<ReturnType<typeof useSftpState>>;
  sftpDefaultViewMode: "list" | "tree";
  activeHost: Host | null;
  activeSessionId?: string | null;
  focusedSessionId?: string | null;
  showWorkspaceHostHeader: boolean;
  renderOverlays: boolean;
  sftpDoubleClickBehavior: "open" | "transfer";
  sftpAutoSync: boolean;
  hotkeyScheme: HotkeyScheme;
  keyBindings: KeyBinding[];
  editorWordWrap: boolean;
  setEditorWordWrap: (value: boolean) => void;
  onGetTerminalCwd?: (options?: {
    preferFreshBackend?: boolean;
    allowRendererFallback?: boolean;
  }) => Promise<string | null>;
  activeTerminalCwd?: string | null;
  sftpFollowTerminalCwd: boolean;
  onSftpFollowTerminalCwdChange?: (enabled: boolean, host?: Host | null) => void;
  onRequestTerminalFocus?: () => void;
  isVisible: boolean;
  behaviorRef: MutableRefObject<"open" | "transfer">;
  autoSyncRef: MutableRefObject<boolean>;
  connectedHostObjRef: MutableRefObject<Host | null>;
  connectedKeyRef: MutableRefObject<string | null>;
  onInteractiveWorkChange: (active: boolean) => void;
  listSftp: ReturnType<typeof useSftpBackend>["listSftp"];
  mkdirLocal: ReturnType<typeof useSftpBackend>["mkdirLocal"];
  deleteLocalFile: ReturnType<typeof useSftpBackend>["deleteLocalFile"];
  showSaveDialog: ReturnType<typeof useSftpBackend>["showSaveDialog"];
  selectDirectory: ReturnType<typeof useSftpBackend>["selectDirectory"];
  listLocalDir: ReturnType<typeof useSftpBackend>["listLocalDir"];
  listDrives: ReturnType<typeof useSftpBackend>["listDrives"];
  openPath: ReturnType<typeof useSftpBackend>["openPath"];
  t: ReturnType<typeof useI18n>["t"];
};

const SftpSidePanelInteractiveBody: React.FC<SftpSidePanelInteractiveBodyProps> = ({
  hosts,
  hostWriteSource,
  connectedHosts,
  sessions,
  updateHosts,
  sftp,
  sftpRef,
  sftpDefaultViewMode,
  activeHost,
  activeSessionId = null,
  focusedSessionId = null,
  showWorkspaceHostHeader,
  renderOverlays,
  hotkeyScheme,
  keyBindings,
  editorWordWrap,
  setEditorWordWrap,
  onGetTerminalCwd,
  activeTerminalCwd = null,
  sftpFollowTerminalCwd,
  onSftpFollowTerminalCwdChange,
  onRequestTerminalFocus,
  isVisible,
  behaviorRef,
  autoSyncRef,
  connectedHostObjRef,
  connectedKeyRef,
  onInteractiveWorkChange,
  listSftp,
  mkdirLocal,
  deleteLocalFile,
  showSaveDialog,
  selectDirectory,
  listLocalDir,
  listDrives,
  openPath,
  t,
}) => {
  const panelRootRef = useRef<HTMLDivElement>(null);
  const dialogActionScopeIdRef = useRef(`sftp-side-panel:${crypto.randomUUID()}`);
  const terminalBackend = useTerminalBackend();
  const [hasPaneFocus, setHasPaneFocus] = useState(false);
  const [pendingFollowOverride, setPendingFollowOverride] = useState<{
    hostId: string;
    value: boolean;
  } | null>(null);

  useSftpKeyboardShortcuts({
    keyBindings,
    hotkeyScheme,
    sftpRef,
    dialogActionScopeId: dialogActionScopeIdRef.current,
    isActive: hasPaneFocus,
  });

  const { getOpenerForFile, setOpenerForExtension } = useSftpFileAssociations();
  const getOpenerForFileRef = useRef(getOpenerForFile);
  getOpenerForFileRef.current = getOpenerForFile;

  const handleToggleHiddenFiles = useCallback((paneId: string) => {
    const pane = sftpRef.current.leftTabs.tabs.find((tab) => tab.id === paneId);
    if (!pane) return;
    sftpRef.current.setShowHiddenFiles("left", paneId, !pane.showHiddenFiles);
  }, [sftpRef]);

  const syncFocusedSelection = useCallback((tabId: string | null) => {
    if (tabId) {
      keepOnlyPaneSelections(sftpRef.current, { side: "left", tabId });
      return;
    }
    keepOnlyPaneSelections(sftpRef.current, null);
  }, [sftpRef]);

  const handlePaneFocus = useCallback(() => {
    sftpFocusStore.setFocusedSide("left");
    setHasPaneFocus(true);
    syncFocusedSelection(sftpRef.current.getActiveTabId("left"));
  }, [sftpRef, syncFocusedSelection]);

  // NOTE: We intentionally do NOT sync to activeTabStore here.
  // activeTabStore is a global singleton shared with SftpView.
  // Writing to it here would corrupt SftpView's left pane visibility.

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const elementTarget = target instanceof Element ? target : null;
      const isPortalInteraction = !!elementTarget?.closest(
        '#netcatty-context-menu-root, [role="dialog"], [data-radix-popper-content-wrapper]',
      );
      if (isPortalInteraction) {
        return;
      }

      if (panelRootRef.current?.contains(target)) {
        sftpFocusStore.setFocusedSide("left");
        setHasPaneFocus(true);
        syncFocusedSelection(sftpRef.current.getActiveTabId("left"));
      } else {
        setHasPaneFocus(false);
        syncFocusedSelection(null);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [sftpRef, syncFocusedSelection]);

  const {
    leftCallbacks,
    rightCallbacks,
    dragCallbacks,
    draggedFiles,
    permissionsState,
    setPermissionsState,
    showTextEditor,
    setShowTextEditor,
    textEditorTarget,
    setTextEditorTarget,
    textEditorContent,
    setTextEditorContent,
    showFileOpenerDialog,
    setShowFileOpenerDialog,
    fileOpenerTarget,
    setFileOpenerTarget,
    handleSaveTextFile,
    onPromoteToTab,
    handleFileOpenerSelect,
    handleSelectSystemApp,
  } = useSftpViewPaneCallbacks({
    sftpRef,
    behaviorRef,
    autoSyncRef,
    getOpenerForFileRef,
    setOpenerForExtension,
    t,
    listSftp,
    mkdirLocal,
    deleteLocalFile,
    showSaveDialog,
    selectDirectory,
    getSftpIdForConnection: sftp.getSftpIdForConnection,
    listLocalFiles: listLocalDir,
    listDrives,
  });

  const {
    leftPanes,
    showHostPickerLeft,
    showHostPickerRight,
    hostSearchLeft,
    hostSearchRight,
    setShowHostPickerLeft,
    setShowHostPickerRight,
    setHostSearchLeft,
    setHostSearchRight,
    handleHostSelectLeft,
    handleHostSelectRight,
  } = useSftpViewTabs({ sftp, sftpRef });

  useEffect(() => {
    onInteractiveWorkChange(showTextEditor || !!permissionsState || showFileOpenerDialog);
  }, [onInteractiveWorkChange, permissionsState, showFileOpenerDialog, showTextEditor]);

  // When a host switch is deferred or the picker connects a different host,
  // actions should follow the visible SFTP connection, not the incoming default.
  const displayHost = useMemo(() => {
    const conn = sftp.leftPane.connection;
    if (conn && !conn.isLocal) {
      const latestHost = hosts.find((h) => h.id === conn.hostId) ?? null;
      const pendingFollowValue = pendingFollowOverride?.hostId === conn.hostId
        ? pendingFollowOverride.value
        : undefined;
      // Prefer the stored Host object from connect time — it preserves
      // session-time overrides that the vault host may lack.
      if (connectedHostObjRef.current && connectedHostObjRef.current.id === conn.hostId) {
        return mergeLatestFollowTerminalCwdHostSetting(
          connectedHostObjRef.current,
          latestHost,
          pendingFollowValue,
        );
      }
      return latestHost ?? activeHost;
    }
    return activeHost;
  }, [activeHost, connectedHostObjRef, hosts, pendingFollowOverride, sftp.leftPane.connection]);

  useEffect(() => {
    if (!pendingFollowOverride) return;
    const latestHost = hosts.find((host) => host.id === pendingFollowOverride.hostId);
    if (latestHost?.sftpFollowTerminalCwd === pendingFollowOverride.value) {
      setPendingFollowOverride(null);
    }
  }, [hosts, pendingFollowOverride]);

  useEffect(() => {
    setPendingFollowOverride(null);
  }, [sftp.leftPane.connection?.id]);

  const followTerminalCwdHost = useMemo(() => {
    if (sftp.leftPane.connection?.isLocal) return null;
    return displayHost;
  }, [displayHost, sftp.leftPane.connection?.isLocal]);

  const effectiveFollowTerminalCwd = resolveHostFollowTerminalCwd(
    followTerminalCwdHost?.sftpFollowTerminalCwd,
    sftpFollowTerminalCwd,
  );

  const canFollowTerminalCwd = useMemo(() => {
    if (!onGetTerminalCwd || !followTerminalCwdHost) return false;
    const proto = followTerminalCwdHost.protocol;
    if (proto === "local" || proto === "serial") return false;
    if (followTerminalCwdHost.id?.startsWith("local-") || followTerminalCwdHost.id?.startsWith("serial-")) return false;
    return true;
  }, [followTerminalCwdHost, onGetTerminalCwd]);

  const hasActiveWork = showTextEditor || !!permissionsState || showFileOpenerDialog
    || (sftp.activeFileWatchCountRef?.current ?? 0) > 0
    || (sftp.activeExternalEditCount ?? 0) > 0;

  const blockedFollowRef = useRef<SftpFollowTerminalCwdBlock | null>(null);
  const handledFollowRef = useRef<SftpFollowTerminalCwdBlock | null>(null);
  const followSyncGenerationRef = useRef(0);
  const effectiveFollowTerminalCwdRef = useRef(effectiveFollowTerminalCwd);
  const canFollowTerminalCwdRef = useRef(canFollowTerminalCwd);
  const activeTerminalCwdRef = useRef(activeTerminalCwd);
  const connectionId = sftp.leftPane.connection?.id ?? null;
  const connectionIdRef = useRef(connectionId);
  const connectionPath = sftp.leftPane.connection?.currentPath ?? null;
  const isVisibleRef = useRef(isVisible);
  const hasActiveWorkRef = useRef(hasActiveWork);
  effectiveFollowTerminalCwdRef.current = effectiveFollowTerminalCwd;
  canFollowTerminalCwdRef.current = canFollowTerminalCwd;
  activeTerminalCwdRef.current = activeTerminalCwd;
  connectionIdRef.current = connectionId;
  isVisibleRef.current = isVisible;
  hasActiveWorkRef.current = hasActiveWork;

  const invalidateInFlightFollowSync = useCallback(() => {
    followSyncGenerationRef.current += 1;
    blockedFollowRef.current = null;
    handledFollowRef.current = null;
  }, []);

  useEffect(() => {
    invalidateInFlightFollowSync();
  }, [
    activeTerminalCwd,
    followTerminalCwdHost?.id,
    connectionId,
    invalidateInFlightFollowSync,
  ]);

  useEffect(() => {
    if (effectiveFollowTerminalCwd) return;
    invalidateInFlightFollowSync();
  }, [effectiveFollowTerminalCwd, invalidateInFlightFollowSync]);

  useEffect(() => {
    const blockedFollow = blockedFollowRef.current;
    if (
      shouldClearBlockedFollowOnReach(
        blockedFollow,
        connectionId,
        connectionPath,
        sftp.leftPane.loading,
      )
    ) {
      blockedFollowRef.current = null;
      handledFollowRef.current = blockedFollow;
    }
  }, [connectionId, connectionPath, sftp.leftPane.loading]);

  // Match toolbar path semantics: keep the last confirmed path while navigateTo
  // has optimistically replaced connection.currentPath during an uncached load.
  const confirmedLocatePathRef = useRef(connectionPath ?? "");
  const prevLocateConnectionIdRef = useRef(connectionId ?? undefined);
  const [confirmedLocatePath, setConfirmedLocatePath] = useState(connectionPath ?? "");
  useEffect(() => {
    const previousConnectionId = prevLocateConnectionIdRef.current;
    prevLocateConnectionIdRef.current = connectionId ?? undefined;
    setConfirmedLocatePath((previousDisplayPath) => {
      const next = getNextSftpToolbarDisplayPath({
        previousDisplayPath,
        previousConnectionId,
        connectionId: connectionId ?? undefined,
        currentPath: connectionPath ?? undefined,
        loading: sftp.leftPane.loading,
      });
      confirmedLocatePathRef.current = next;
      return next;
    });
  }, [connectionId, connectionPath, sftp.leftPane.loading]);

  const handleGoToTerminalCwd = useCallback(async () => {
    if (!onGetTerminalCwd) return;
    const cwd = await onGetTerminalCwd({ preferFreshBackend: true });
    if (!cwd) return;
    const navigateResult = await sftpRef.current.navigateTo("left", cwd);
    if (navigateResult === "reached") {
      blockedFollowRef.current = null;
      const connection = sftpRef.current.leftPane.connection;
      if (connection?.id) {
        handledFollowRef.current = { connectionId: connection.id, terminalCwd: cwd };
      }
    }
  }, [onGetTerminalCwd, sftpRef]);

  const locatePathInTerminalContext = useMemo(() => {
    const connection = sftp.leftPane.connection;
    const locateSessionId = resolveLocateSftpPathSessionId({
      activeSessionId,
      focusedSessionId,
    });
    const session = sessions.find((candidate) => candidate.id === locateSessionId) ?? null;
    const host = displayHost ?? activeHost;
    const isNetworkDevice = host?.deviceType === "network"
      || classifyDistroId(host?.distro) === "network-device";
    return {
      path: confirmedLocatePath || connection?.currentPath,
      sessionId: locateSessionId,
      sessionStatus: session?.status,
      sessionHostId: session?.hostId,
      sftpHostId: connection?.hostId,
      sftpIsLocal: Boolean(connection?.isLocal),
      protocol: session?.protocol ?? host?.protocol,
      shellType: session?.shellType,
      isNetworkDevice,
      moshEnabled: session?.moshEnabled,
      etEnabled: session?.etEnabled,
      sessionHostname: session?.hostname,
      sessionUsername: session?.username,
      sessionPort: session?.port,
      sftpHostname: host?.hostname,
      sftpUsername: host?.username,
      sftpPort: host?.port,
    };
  }, [
    activeHost,
    activeSessionId,
    confirmedLocatePath,
    displayHost,
    focusedSessionId,
    sessions,
    sftp.leftPane.connection,
  ]);

  const canLocatePathInTerminal = canLocateSftpPathInTerminal(locatePathInTerminalContext);

  const handleLocatePathInTerminal = useCallback(() => {
    const connection = sftpRef.current.leftPane.connection;
    const locateSessionId = resolveLocateSftpPathSessionId({
      activeSessionId,
      focusedSessionId,
    });
    const session = sessions.find((candidate) => candidate.id === locateSessionId) ?? null;
    const host = displayHost ?? activeHost;
    const isNetworkDevice = host?.deviceType === "network"
      || classifyDistroId(host?.distro) === "network-device";
    const action = resolveLocateSftpPathInTerminalAction({
      // Prefer the path shown in the toolbar, not an in-flight optimistic cwd.
      path: confirmedLocatePathRef.current || connection?.currentPath,
      sessionId: locateSessionId,
      sessionStatus: session?.status,
      sessionHostId: session?.hostId,
      sftpHostId: connection?.hostId,
      sftpIsLocal: Boolean(connection?.isLocal),
      protocol: session?.protocol ?? host?.protocol,
      shellType: session?.shellType,
      isNetworkDevice,
      moshEnabled: session?.moshEnabled,
      etEnabled: session?.etEnabled,
      sessionHostname: session?.hostname,
      sessionUsername: session?.username,
      sessionPort: session?.port,
      sftpHostname: host?.hostname,
      sftpUsername: host?.username,
      sftpPort: host?.port,
    });
    if (!action) return;
    // Never inject cd into a password/sudo prompt (same guard as snippets/broadcast).
    if (isTerminalSensitiveInputActive(action.sessionId)) return;
    // Only submit at an idle shell prompt -- never append into typed input or a TUI.
    if (!isTerminalReadyForCommandInjection(action.sessionId)) return;
    terminalBackend.writeToSession(action.sessionId, action.data, { automated: true });
    scheduleDeferredTerminalFocus(onRequestTerminalFocus);
  }, [
    activeHost,
    activeSessionId,
    displayHost,
    focusedSessionId,
    onRequestTerminalFocus,
    sessions,
    sftpRef,
    terminalBackend,
  ]);

  const syncFollowToTerminalCwd = useCallback(async () => {
    if (!onGetTerminalCwd || !effectiveFollowTerminalCwd || !canFollowTerminalCwd) {
      return;
    }

    const syncGeneration = followSyncGenerationRef.current;

    const usesLiveTerminalCwd = Boolean(activeTerminalCwd);
    let terminalCwd = activeTerminalCwd;
    if (!terminalCwd) {
      terminalCwd = await onGetTerminalCwd({ preferFreshBackend: true });
    }
    if (!terminalCwd) return;
    if (!shouldApplyFollowTerminalCwdSyncResult({
      syncGeneration,
      currentGeneration: followSyncGenerationRef.current,
      followEnabled: effectiveFollowTerminalCwdRef.current,
      canFollow: canFollowTerminalCwdRef.current,
    })) {
      return;
    }

    const connection = sftpRef.current.leftPane.connection;
    if (!shouldFollowTerminalCwdNavigate({
      followEnabled: effectiveFollowTerminalCwdRef.current,
      isVisible,
      terminalCwd,
      currentPath: connection?.currentPath,
      connectionId: connection?.id,
      hasActiveWork,
      isConnected: Boolean(connection && !connection.isLocal && connection.status === "connected"),
      blockedFollow: blockedFollowRef.current,
      handledFollow: handledFollowRef.current,
    })) {
      if (
        connection?.id
        && !connection.isLocal
        && connection.status === "connected"
        && connection.currentPath === terminalCwd
      ) {
        handledFollowRef.current = { connectionId: connection.id, terminalCwd };
      }
      return;
    }

    const expectedConnectionId = connection?.id ?? null;
    const shouldApplyCurrentFollowSync = () => (
      shouldApplyFollowTerminalCwdSyncResult({
        syncGeneration,
        currentGeneration: followSyncGenerationRef.current,
        followEnabled: effectiveFollowTerminalCwdRef.current,
        canFollow: canFollowTerminalCwdRef.current,
        expectedConnectionId,
        liveConnectionId: connectionIdRef.current,
        paneConnectionId: sftpRef.current.leftPane.connection?.id ?? null,
        expectedTerminalCwd: terminalCwd,
        liveTerminalCwd: activeTerminalCwdRef.current,
        requireLiveTerminalCwd: usesLiveTerminalCwd,
      })
    );
    const navigateResult = await sftpRef.current.navigateTo("left", terminalCwd, {
      shouldApply: shouldApplyCurrentFollowSync,
    });
    if (!shouldApplyFollowTerminalCwdSyncResult({
      syncGeneration,
      currentGeneration: followSyncGenerationRef.current,
      followEnabled: effectiveFollowTerminalCwdRef.current,
      canFollow: canFollowTerminalCwdRef.current,
    })) {
      return;
    }

    const currentConnection = sftpRef.current.leftPane.connection;
    if (!currentConnection || currentConnection.id !== connection?.id) {
      return;
    }

    if (navigateResult === "failed" && currentConnection.id) {
      blockedFollowRef.current = { connectionId: currentConnection.id, terminalCwd };
    } else if (navigateResult === "superseded" && currentConnection.id) {
      handledFollowRef.current = { connectionId: currentConnection.id, terminalCwd };
    } else if (navigateResult === "reached") {
      blockedFollowRef.current = null;
      handledFollowRef.current = { connectionId: currentConnection.id, terminalCwd };
    }
  }, [
    activeTerminalCwd,
    canFollowTerminalCwd,
    effectiveFollowTerminalCwd,
    hasActiveWork,
    isVisible,
    onGetTerminalCwd,
    sftpRef,
  ]);

  const handleToggleFollowTerminalCwd = useCallback(() => {
    const nextEnabled = !effectiveFollowTerminalCwd;
    invalidateInFlightFollowSync();
    if (followTerminalCwdHost?.id) {
      setPendingFollowOverride({ hostId: followTerminalCwdHost.id, value: nextEnabled });
    }
    onSftpFollowTerminalCwdChange?.(nextEnabled, followTerminalCwdHost);
  }, [effectiveFollowTerminalCwd, followTerminalCwdHost, invalidateInFlightFollowSync, onSftpFollowTerminalCwdChange]);

  useEffect(() => {
    if (!effectiveFollowTerminalCwd || !canFollowTerminalCwd || !isVisible || hasActiveWork) return;
    void syncFollowToTerminalCwd();
  }, [
    activeTerminalCwd,
    canFollowTerminalCwd,
    effectiveFollowTerminalCwd,
    hasActiveWork,
    isVisible,
    connectionId,
    sftp.leftPane.connection?.status,
    sftp.leftPane.connection?.isLocal,
    syncFollowToTerminalCwd,
  ]);

  // First open resync (#2335). While the SFTP panel is closed, the per-command
  // cwd probe does not run, so `activeTerminalCwd` can be stale (it still points
  // at the login home even though the terminal has since `cd`-ed elsewhere). On
  // that stale value the normal follow sync sees currentPath === terminalCwd and
  // does nothing, leaving the panel at home. When the panel first becomes
  // visible for a connected remote, force one fresh backend probe (bypassing the
  // stale cache) and navigate to the terminal's real cwd. Reset on hide so
  // reopening after another `cd` resyncs again.
  const initialFollowSyncedConnRef = useRef<string | null>(null);
  const initialFollowRetryRef = useRef<{ connectionId: string | null; attempts: number }>({
    connectionId: null,
    attempts: 0,
  });
  const initialFollowRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialFollowMountedRef = useRef(true);
  const [initialFollowRetryNonce, setInitialFollowRetryNonce] = useState(0);
  useEffect(() => {
    initialFollowMountedRef.current = true;
    return () => {
      initialFollowMountedRef.current = false;
      if (initialFollowRetryTimerRef.current) clearTimeout(initialFollowRetryTimerRef.current);
    };
  }, []);
  useEffect(() => {
    if (!isVisible || initialFollowRetryRef.current.connectionId !== connectionId) {
      initialFollowSyncedConnRef.current = null;
      initialFollowRetryRef.current = { connectionId, attempts: 0 };
      if (initialFollowRetryTimerRef.current) {
        clearTimeout(initialFollowRetryTimerRef.current);
        initialFollowRetryTimerRef.current = null;
      }
    }
  }, [connectionId, isVisible]);
  useEffect(() => {
    if (!effectiveFollowTerminalCwd || !canFollowTerminalCwd || !isVisible || hasActiveWork) return;
    const connection = sftpRef.current.leftPane.connection;
    if (
      !connection
      || connection.isLocal
      || connection.status !== "connected"
      || !connection.id
    ) {
      return;
    }
    if (initialFollowSyncedConnRef.current === connection.id) return;
    if (initialFollowRetryRef.current.connectionId !== connection.id) {
      initialFollowRetryRef.current = { connectionId: connection.id, attempts: 0 };
    }
    if (initialFollowRetryRef.current.attempts >= 3) return;
    initialFollowRetryRef.current.attempts += 1;
    initialFollowSyncedConnRef.current = connection.id;
    const expectedConnectionId = connection.id;
    // Snapshot the (possibly stale) cached cwd so we can neutralize it below.
    const staleTerminalCwd = activeTerminalCwdRef.current;
    const syncGeneration = followSyncGenerationRef.current;
    // Follow is still eligible: same generation, still enabled/allowed, still
    // visible, and no interactive work has begun. Re-checked live via refs so a
    // probe that resolves after the panel is hidden or an editor/dialog opens
    // does not move the pane while follow should be paused (#2335).
    const followCurrentlyEligible = () => (
      initialFollowMountedRef.current
      && effectiveFollowTerminalCwdRef.current
      && canFollowTerminalCwdRef.current
      && isVisibleRef.current
      && !hasActiveWorkRef.current
      && sftpRef.current.leftPane.connection?.id === expectedConnectionId
      && !sftpRef.current.leftPane.connection?.isLocal
      && sftpRef.current.leftPane.connection?.status === "connected"
    );
    const followStillEligible = () => (
      syncGeneration === followSyncGenerationRef.current
      && followCurrentlyEligible()
    );
    const clearAttemptAndRetry = () => {
      if (initialFollowSyncedConnRef.current === expectedConnectionId) {
        initialFollowSyncedConnRef.current = null;
      }
      if (
        !initialFollowMountedRef.current
        || !followCurrentlyEligible()
        || initialFollowRetryRef.current.attempts >= 3
      ) {
        return;
      }
      if (initialFollowRetryTimerRef.current) clearTimeout(initialFollowRetryTimerRef.current);
      initialFollowRetryTimerRef.current = setTimeout(() => {
        initialFollowRetryTimerRef.current = null;
        setInitialFollowRetryNonce((value) => value + 1);
      }, 250);
    };
    void runInitialFollowTerminalCwdSync({
      expectedConnectionId,
      staleTerminalCwd,
      getFreshTerminalCwd: () => onGetTerminalCwd?.({
        preferFreshBackend: true,
        allowRendererFallback: false,
      }),
      isEligible: followStillEligible,
      getConnection: () => sftpRef.current.leftPane.connection,
      navigate: (cwd, shouldApply) => sftpRef.current.navigateTo("left", cwd, { shouldApply }),
      setHandled: (value) => { handledFollowRef.current = value; },
      setBlocked: (value) => { blockedFollowRef.current = value; },
    }).then((completed) => {
      if (!completed) clearAttemptAndRetry();
    });
  }, [
    canFollowTerminalCwd,
    effectiveFollowTerminalCwd,
    hasActiveWork,
    initialFollowRetryNonce,
    isVisible,
    onGetTerminalCwd,
    sftpRef,
    activeTerminalCwd,
    sftp.leftPane.connection?.id,
    sftp.leftPane.connection?.isLocal,
    sftp.leftPane.connection?.status,
  ]);

  const MAX_VISIBLE_TRANSFERS = 5;
  const visibleTransfers = useMemo(() => {
    const connection = sftp.leftPane.connection;
    if (!connection) return [];
    // Filter transfers to those relevant to the active connection's host,
    // so workspace focus switches don't show transfers from other hosts.
    const filtered = sftp.transfers.filter((t) => {
      if (t.parentTaskId) return false; // Child tasks rendered by SftpTransferQueue
      if (connection.isLocal) {
        return t.sourceConnectionId === connection.id || t.targetConnectionId === connection.id;
      }
      return t.targetHostId === connection.hostId || t.sourceConnectionId === connection.id || t.targetConnectionId === connection.id;
    });
    return [...filtered].reverse().slice(0, MAX_VISIBLE_TRANSFERS);
  }, [sftp.transfers, sftp.leftPane.connection]);

  const handleRevealTransferTarget = useCallback(
    async (task: TransferTask) => {
      if (!isConcreteTransferTargetPath(task)) return;
      const connection = sftpRef.current.leftPane.connection;
      const revealPath = task.isDirectory ? task.targetPath : getParentPath(task.targetPath);

      if (task.targetConnectionId === "local") {
        try {
          const result = await openPath(revealPath);
          if (result.success) return;
        } catch {
          // Show the localized error below.
        }
        toast.error(t("sftp.transfers.openTargetFolderError"), "SFTP");
        return;
      }

      if (!connection || connection.isLocal) return;

      await sftpRef.current.navigateTo("left", revealPath, { force: true });
    },
    [openPath, sftpRef, t],
  );

  const canRevealTransferTarget = useCallback(
    (task: TransferTask) => {
      if (task.status !== "completed") return false;
      if (!isConcreteTransferTargetPath(task)) return false;
      if (task.targetConnectionId === "local") {
        return true;
      }
      if (task.direction !== "upload" && task.direction !== "remote-to-remote") return false;

      const connection = sftp.leftPane.connection;
      if (!connection || connection.isLocal) return false;

      if (task.targetHostId) {
        if (connection.hostId !== task.targetHostId) return false;
        // If the transfer recorded a full endpoint key, use it to
        // distinguish same-hostId uploads with different session overrides.
        if (task.targetConnectionKey) {
          return connectedKeyRef.current === task.targetConnectionKey;
        }
        return true;
      }

      return connection.id === task.targetConnectionId;
    },
    [connectedKeyRef, sftp.leftPane.connection],
  );

  const canCopyTransferTargetPath = useCallback(
    (task: TransferTask) => task.status === "completed" && isConcreteTransferTargetPath(task),
    [],
  );

  const handleCopyTransferTargetPath = useCallback(
    async (task: TransferTask) => {
      if (!isConcreteTransferTargetPath(task)) return;
      try {
        await navigator.clipboard.writeText(task.targetPath);
        toast.success(t("sftp.transfers.copyTargetPathSuccess"), "SFTP");
      } catch {
        toast.error(t("sftp.transfers.copyTargetPathError"), "SFTP");
      }
    },
    [t],
  );

  // Determine the active pane to render (without using global activeTabStore)
  const activeLeftPaneId = sftp.leftTabs.activeTabId;

  return (
    <SftpContextProvider
      hosts={hosts}
      connectedHosts={connectedHosts}
      writableHosts={hostWriteSource}
      updateHosts={updateHosts}
      draggedFiles={draggedFiles}
      dragCallbacks={dragCallbacks}
      leftCallbacks={leftCallbacks}
      rightCallbacks={rightCallbacks}
    >
      <div
        ref={panelRootRef}
        className="h-full flex flex-col bg-background overflow-hidden"
        data-section="terminal-sftp-panel"
        onClick={handlePaneFocus}
      >
        {showWorkspaceHostHeader && displayHost && (
          <div
            className={`${TERMINAL_SIDE_PANEL_INNER_HEADER_CLASS} border-b border-border/50 bg-muted/20 px-3 flex items-center`}
            data-section="terminal-sftp-host-header"
          >
            <div className="flex items-center gap-2 min-w-0">
              <DistroAvatar
                host={displayHost}
                fallback={displayHost.label.slice(0, 2).toUpperCase()}
                size="sm"
                className="h-5 w-5 rounded-sm shrink-0"
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="min-w-0 flex-1 max-w-[calc(100%-1.75rem)] text-[11px] leading-5 truncate cursor-default">
                    <span className="font-medium">
                      {displayHost.label}
                    </span>
                    <span className="mx-1 text-muted-foreground">·</span>
                    <span className="font-mono text-muted-foreground">
                      {(displayHost.username || "root")}@{displayHost.hostname}:{displayHost.port || 22}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  {`${displayHost.label} · ${(displayHost.username || "root")}@${formatHostPort(displayHost.hostname, displayHost.port || 22)}`}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        )}
        {/* File browser pane - render only the active pane */}
        <div className="relative flex-1 min-h-0">
          {leftPanes.map((pane, idx) => {
            // Manage visibility locally instead of via activeTabStore
            const isActive = activeLeftPaneId
              ? pane.id === activeLeftPaneId
              : idx === 0;
            if (!isActive) return null;

            return (
              <div key={pane.id} className="absolute inset-0 z-10">
                <SftpPaneView
                  side="left"
                  pane={pane}
                  dialogActionScopeId={dialogActionScopeIdRef.current}
                  isPaneFocused={hasPaneFocus}
                  sftpDefaultViewMode={sftpDefaultViewMode}
                  showHeader
                  showEmptyHeader
                  forceActive
                  onToggleShowHiddenFiles={() => handleToggleHiddenFiles(pane.id)}
                  onGoToTerminalCwd={onGetTerminalCwd ? handleGoToTerminalCwd : undefined}
                  onLocatePathInTerminal={canLocatePathInTerminal ? handleLocatePathInTerminal : undefined}
                  followTerminalCwd={canFollowTerminalCwd ? effectiveFollowTerminalCwd : undefined}
                  onToggleFollowTerminalCwd={canFollowTerminalCwd ? handleToggleFollowTerminalCwd : undefined}
                />
              </div>
            );
          })}
        </div>
        <SftpTransferQueue
          sftp={sftp}
          visibleTransfers={visibleTransfers}
          allTransfers={sftp.transfers}
          canRevealTransferTarget={canRevealTransferTarget}
          onRevealTransferTarget={handleRevealTransferTarget}
          canCopyTransferTargetPath={canCopyTransferTargetPath}
          onCopyTransferTargetPath={handleCopyTransferTargetPath}
        />
      </div>

      {renderOverlays && (
        <SftpOverlays
          hosts={hosts}
          connectedHosts={connectedHosts}
          sftp={sftp}
          visibleTransfers={visibleTransfers}
          showTransferQueue={false}
          canRevealTransferTarget={canRevealTransferTarget}
          onRevealTransferTarget={handleRevealTransferTarget}
          canCopyTransferTargetPath={canCopyTransferTargetPath}
          onCopyTransferTargetPath={handleCopyTransferTargetPath}
          showHostPickerLeft={showHostPickerLeft}
          showHostPickerRight={showHostPickerRight}
          hostSearchLeft={hostSearchLeft}
          hostSearchRight={hostSearchRight}
          setShowHostPickerLeft={setShowHostPickerLeft}
          setShowHostPickerRight={setShowHostPickerRight}
          setHostSearchLeft={setHostSearchLeft}
          setHostSearchRight={setHostSearchRight}
          handleHostSelectLeft={handleHostSelectLeft}
          handleHostSelectRight={handleHostSelectRight}
          permissionsState={permissionsState}
          setPermissionsState={setPermissionsState}
          showTextEditor={showTextEditor}
          setShowTextEditor={setShowTextEditor}
          textEditorTarget={textEditorTarget}
          setTextEditorTarget={setTextEditorTarget}
          textEditorContent={textEditorContent}
          setTextEditorContent={setTextEditorContent}
          handleSaveTextFile={handleSaveTextFile}
          editorWordWrap={editorWordWrap}
          setEditorWordWrap={setEditorWordWrap}
          hotkeyScheme={hotkeyScheme}
          keyBindings={keyBindings}
          showFileOpenerDialog={showFileOpenerDialog}
          setShowFileOpenerDialog={setShowFileOpenerDialog}
          fileOpenerTarget={fileOpenerTarget}
          setFileOpenerTarget={setFileOpenerTarget}
          handleFileOpenerSelect={handleFileOpenerSelect}
          handleSelectSystemApp={handleSelectSystemApp}
          onPromoteToTab={onPromoteToTab}
          onRequestTerminalFocus={onRequestTerminalFocus}
          t={t}
        />
      )}
    </SftpContextProvider>
  );
};

const sidePanelAreEqual = (prev: SftpSidePanelProps, next: SftpSidePanelProps): boolean =>
  prev.hosts === next.hosts &&
  prev.writableHosts === next.writableHosts &&
  sftpPickerSessionsEqual(prev.sessions, next.sessions) &&
  prev.keys === next.keys &&
  prev.identities === next.identities &&
  prev.knownHosts === next.knownHosts &&
  prev.updateHosts === next.updateHosts &&
  prev.onAddKnownHost === next.onAddKnownHost &&
  prev.sftpDefaultViewMode === next.sftpDefaultViewMode &&
  prev.activeHost === next.activeHost &&
  prev.activeSessionId === next.activeSessionId &&
  prev.focusedSessionId === next.focusedSessionId &&
  prev.showWorkspaceHostHeader === next.showWorkspaceHostHeader &&
  prev.isVisible === next.isVisible &&
  prev.renderOverlays === next.renderOverlays &&
  prev.pendingUpload?.requestId === next.pendingUpload?.requestId &&
  prev.onPendingUploadHandled === next.onPendingUploadHandled &&
  prev.sftpDoubleClickBehavior === next.sftpDoubleClickBehavior &&
  prev.sftpAutoSync === next.sftpAutoSync &&
  prev.sftpShowHiddenFiles === next.sftpShowHiddenFiles &&
  prev.sftpUseCompressedUpload === next.sftpUseCompressedUpload &&
  prev.hotkeyScheme === next.hotkeyScheme &&
  prev.keyBindings === next.keyBindings &&
  prev.editorWordWrap === next.editorWordWrap &&
  prev.setEditorWordWrap === next.setEditorWordWrap &&
  prev.onGetTerminalCwd === next.onGetTerminalCwd &&
  prev.activeTerminalCwd === next.activeTerminalCwd &&
  prev.sftpFollowTerminalCwd === next.sftpFollowTerminalCwd &&
  prev.onSftpFollowTerminalCwdChange === next.onSftpFollowTerminalCwdChange &&
  prev.onRequestTerminalFocus === next.onRequestTerminalFocus &&
  prev.onCurrentPathChange === next.onCurrentPathChange &&
  prev.onActiveTransfersChange === next.onActiveTransfersChange &&
  prev.onActiveExternalEditsChange === next.onActiveExternalEditsChange &&
  prev.initialLocation?.hostId === next.initialLocation?.hostId &&
  prev.initialLocation?.path === next.initialLocation?.path &&
  // Only the keepalive fields of terminalSettings affect SFTP connection
  // resolution today; compare them directly rather than the whole object.
  prev.terminalSettings?.keepaliveInterval === next.terminalSettings?.keepaliveInterval &&
  prev.terminalSettings?.keepaliveCountMax === next.terminalSettings?.keepaliveCountMax;

export const SftpSidePanel = memo(SftpSidePanelInner, sidePanelAreEqual);
SftpSidePanel.displayName = "SftpSidePanel";
