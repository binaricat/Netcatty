/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

import { terminalLayoutSuppressStore } from '../../application/state/terminalLayoutSuppressStore';
import { terminalCwdStore } from '../../application/state/terminalCwdStore';
import { useSftpBackend } from '../../application/state/useSftpBackend';
import {
  isTransferNavigationTerminalTabId,
  pickHostForTransferNavigation,
  resolveSftpTransferNavigationHostLabel,
  resolveSftpTransferNavigationPath,
  resolveSftpTransferNavigationTarget,
} from '../../domain/sftpTransferNavigation';
import { collectSidePanelPanes, sidePanelLayoutHasTool } from '../../domain/sidePanelLayout';
import { collectSessionIds } from '../../domain/workspace';
import {
  moveSidePanelTabMap,
  moveSidePanelTabSet,
  remapMountedSidePanelTabIds,
  remapSidePanelTabMap,
  type SidePanelTabRemap,
} from '../../domain/workspaceSidePanelTabRemap';
import { AI_PANEL_FORCE_HIDE_SHELL } from '../ai/aiPanelDiagnostics';
import { toast } from '../ui/toast';
import { getTerminalSidePanelShellWidth } from './TerminalLayerSidePanelSection';
import type { RendererCwdSource } from '../terminal/sftpCwd';

type TerminalLayerEffectsContext = Record<string, any> & {
  sftpPaneClosedTabIdsRef: MutableRefObject<Set<string>>;
};

type RuntimeStateRef<T> = { current: Map<string, T> };

export type TerminalSessionRuntimeState = {
  terminalRendererCwdBySessionRef: RuntimeStateRef<string>;
  terminalRendererCwdSourceBySessionRef?: RuntimeStateRef<RendererCwdSource>;
  terminalOsc7SignalBySessionRef: RuntimeStateRef<number>;
  cwdProbeGenerationRef: RuntimeStateRef<number>;
  cwdProbeCancelersRef: RuntimeStateRef<() => void>;
};

export function clearTerminalSessionRuntimeState(
  state: TerminalSessionRuntimeState,
  sessionId: string,
): void {
  const cancelProbe = state.cwdProbeCancelersRef.current.get(sessionId);

  state.cwdProbeCancelersRef.current.delete(sessionId);
  state.cwdProbeGenerationRef.current.delete(sessionId);
  state.terminalOsc7SignalBySessionRef.current.delete(sessionId);
  state.terminalRendererCwdBySessionRef.current.delete(sessionId);
  state.terminalRendererCwdSourceBySessionRef?.current.delete(sessionId);

  // Keep terminalCwdStore in sync so SFTP follow does not reuse a closed session path.
  terminalCwdStore.setCwd(sessionId, null);

  if (cancelProbe) {
    try {
      cancelProbe();
    } catch {
      // Session teardown is best-effort: one faulty canceler must not retain state.
    }
  }
}

export function pruneTerminalSessionRuntimeState(
  state: TerminalSessionRuntimeState,
  liveSessionIds: ReadonlySet<string>,
): void {
  const trackedSessionIds = new Set<string>([
    ...state.terminalRendererCwdBySessionRef.current.keys(),
    ...(state.terminalRendererCwdSourceBySessionRef?.current.keys() ?? []),
    ...state.terminalOsc7SignalBySessionRef.current.keys(),
    ...state.cwdProbeGenerationRef.current.keys(),
    ...state.cwdProbeCancelersRef.current.keys(),
  ]);

  for (const sessionId of trackedSessionIds) {
    if (!liveSessionIds.has(sessionId)) {
      clearTerminalSessionRuntimeState(state, sessionId);
    }
  }
}

type TabMemoryRef = { current: Map<string, unknown> };

export type TerminalTabMemoryState = {
  lastSidePanelTabRef: TabMemoryRef;
  notesReturnTabRef: TabMemoryRef;
  sftpLastPathForSourceRef: TabMemoryRef;
};

export function pruneTerminalTabMemoryState(
  state: TerminalTabMemoryState,
  liveTabIds: ReadonlySet<string>,
): void {
  for (const memoryRef of [
    state.lastSidePanelTabRef,
    state.notesReturnTabRef,
    state.sftpLastPathForSourceRef,
  ]) {
    for (const tabId of memoryRef.current.keys()) {
      if (!liveTabIds.has(tabId)) memoryRef.current.delete(tabId);
    }
  }
}

export function useTerminalLayerEffects(ctx: TerminalLayerEffectsContext) {
  const { openPath } = useSftpBackend();
  const { activeSidePanelTab, activeSidePanelLayout, activeTabId, activeTabIdRef, activeWorkspace, activityTrackedSessions, cancelAnimationFrame, ChunkedEscapeFilter, clearTopTabsPreviewVars, document, dropHint, effectiveHosts, filterTabsMap, focusedSessionId, getSessionActivityIdsToClear, handleToggleAiFromTopBar, handleToggleScriptsSidePanel, handleToggleSidePanel, hasNotifiableTerminalOutput, isComposeBarOpen, isFocusMode, isTerminalLayerVisible, lastSidePanelTabRef, Map, onConnectToHost, onSessionData, onSplitSessionRef, onToggleBroadcastRef, onToggleWorkspaceViewModeRef, prevFocusedSessionIdRef, refocusActiveTerminalSession, requestAnimationFrame, ResizeObserver, sessionActivityStore, sessions, Set, setAiMountedTabIds, setDropHint, setNotesMountedTabIds, setScriptsMountedTabIds, setSystemMountedTabIds, setSftpHostForTab, setSftpInitialLocationForTab, setSftpPendingUploadsForTab, setSidePanelOpenTabs, setSidePanelLayouts, setThemeMountedTabIds, setWorkspaceArea, shouldMeasureTerminalLayerLayout, sidePanelPosition, sidePanelWidth, sftpActiveHost, sftpHostForTab, sftpPaneClosedTabIdsRef, shouldMarkSessionActivity, sidePanelOpenTabs, splitHorizontalHandlersRef, splitVerticalHandlersRef, toggleScriptsSidePanelRef, toggleSidePanelRef, validAIScopeTargetIds, validSessionActivityIds, window, workspaceBroadcastHandlersRef, workspaceFocusHandlersRef, workspaceInnerRef, workspaces } = ctx;

  const activeWorkspaceId = activeWorkspace?.id;
  const activeWorkspaceViewMode = activeWorkspace?.viewMode;
  const previousWorkspacesRef = useRef(workspaces);
  const previousSessionWorkspaceRef = useRef(
    new Map(sessions.map((session: { id: string; workspaceId?: string }) => [session.id, session.workspaceId])),
  );

  useEffect(() => {
    const previousWorkspaces = previousWorkspacesRef.current;
    const previousIds = new Set(previousWorkspaces.map((workspace: { id: string }) => workspace.id));
    const nextIds = new Set(workspaces.map((workspace: { id: string }) => workspace.id));
    const previousSessionWorkspace = previousSessionWorkspaceRef.current;
    const remaps: SidePanelTabRemap[] = [];

    for (const workspace of workspaces) {
      if (previousIds.has(workspace.id)) continue;
      remaps.push({
        kind: 'promote',
        fromTabIds: collectSessionIds(workspace.root),
        toTabId: workspace.id,
        preferredFromTabId: workspace.focusedSessionId,
      });
    }

    for (const session of sessions) {
      const previousWorkspaceId = previousSessionWorkspace.get(session.id);
      if (!session.workspaceId || session.workspaceId === previousWorkspaceId) continue;
      // Orphan (or other workspace) joined an existing workspace tab.
      if (previousIds.has(session.workspaceId)) {
        const workspace = workspaces.find((entry: { id: string }) => entry.id === session.workspaceId);
        const focusedSessionId = workspace?.focusedSessionId;
        remaps.push({
          kind: 'promote',
          fromTabIds: focusedSessionId
            ? [focusedSessionId, session.id]
            : [session.id],
          toTabId: session.workspaceId,
          preferredFromTabId: focusedSessionId ?? session.id,
        });
      }
    }

    for (const workspace of previousWorkspaces) {
      if (nextIds.has(workspace.id)) continue;
      const memberTerminalIds = collectSessionIds(workspace.root)
        .filter((sessionId: string) => validAIScopeTargetIds.has(sessionId));
      remaps.push({
        kind: 'demote',
        fromTabId: workspace.id,
        toTabIds: memberTerminalIds,
        preferredToTabId: (
          memberTerminalIds.includes(workspace.focusedSessionId)
            ? workspace.focusedSessionId
            : memberTerminalIds[0]
        ),
      });
    }

    previousWorkspacesRef.current = workspaces;
    previousSessionWorkspaceRef.current = new Map(
      sessions.map((session: { id: string; workspaceId?: string }) => [session.id, session.workspaceId]),
    );
    if (remaps.length === 0) return;

    setSidePanelOpenTabs((prev: Map<string, any>) => {
      let next = prev;
      for (const remap of remaps) {
        next = remapSidePanelTabMap(next, remap);
      }
      return next;
    });
    // Copy split trees with the open-tool map so reconcile does not replace a
    // multi-pane layout with a fresh single-tool root on the destination tab.
    setSidePanelLayouts((prev: Map<string, any>) => {
      let next = prev;
      for (const remap of remaps) {
        next = remapSidePanelTabMap(next, remap);
      }
      return next;
    });
    // SFTP portals/transfers are keyed by tab id — move ownership instead of
    // cloning so the workspace panel keeps the live browser + transfer owner.
    setSftpHostForTab((prev: Map<string, any>) => {
      let next = prev;
      for (const remap of remaps) {
        next = moveSidePanelTabMap(next, remap);
      }
      return next;
    });
    setSftpInitialLocationForTab((prev: Map<string, any>) => {
      let next = prev;
      for (const remap of remaps) {
        next = moveSidePanelTabMap(next, remap);
      }
      return next;
    });
    setSftpPendingUploadsForTab((prev: Map<string, any>) => {
      let next = prev;
      for (const remap of remaps) {
        next = moveSidePanelTabMap(next, remap);
      }
      return next;
    });
    let sftpOwners = sftpHostForTab as ReadonlyMap<string, any>;
    for (const remap of remaps) {
      sftpPaneClosedTabIdsRef.current = moveSidePanelTabSet(
        sftpPaneClosedTabIdsRef.current,
        remap,
        { ownerTabIds: new Set(sftpOwners.keys()) },
      );
      sftpOwners = moveSidePanelTabMap(sftpOwners, remap);
    }
    setAiMountedTabIds((prev: string[]) => {
      let next = prev;
      for (const remap of remaps) {
        next = remapMountedSidePanelTabIds(next, remap);
      }
      return next;
    });
    setNotesMountedTabIds((prev: string[]) => {
      let next = prev;
      for (const remap of remaps) {
        next = remapMountedSidePanelTabIds(next, remap);
      }
      return next;
    });
    setScriptsMountedTabIds((prev: string[]) => {
      let next = prev;
      for (const remap of remaps) {
        next = remapMountedSidePanelTabIds(next, remap);
      }
      return next;
    });
    setSystemMountedTabIds((prev: string[]) => {
      let next = prev;
      for (const remap of remaps) {
        next = remapMountedSidePanelTabIds(next, remap);
      }
      return next;
    });
    setThemeMountedTabIds((prev: string[]) => {
      let next = prev;
      for (const remap of remaps) {
        next = remapMountedSidePanelTabIds(next, remap);
      }
      return next;
    });
  }, [
    sessions,
    setAiMountedTabIds,
    setNotesMountedTabIds,
    setScriptsMountedTabIds,
    setSftpHostForTab,
    setSftpInitialLocationForTab,
    setSftpPendingUploadsForTab,
    setSidePanelLayouts,
    setSidePanelOpenTabs,
    setSystemMountedTabIds,
    setThemeMountedTabIds,
    validAIScopeTargetIds,
    workspaces,
  ]);

  const isSidePanelOpenForCurrentTab = activeTabId ? sidePanelOpenTabs.has(activeTabId) : false;
  const sidePanelShellWidth = getTerminalSidePanelShellWidth({
    activeSidePanelTab,
    forceHideAiShell: AI_PANEL_FORCE_HIDE_SHELL
      && (!activeSidePanelLayout || collectSidePanelPanes(activeSidePanelLayout.root).length <= 1),
    isSidePanelOpenForCurrentTab,
    resizePreviewWidth: null,
    sidePanelWidth,
  });

  const activityEscapeFiltersRef = useRef<any>(new Map());

  const remeasureScheduledRef = useRef(false);
  const layoutEffectSnapshotRef = useRef({
    workspaceId: undefined as string | undefined,
    viewMode: undefined as string | undefined,
    composeBarOpen: false,
    shellWidth: 0,
    width: 0,
    height: 0,
  });

  const remeasureWorkspaceArea = useCallback(() => {
    const el = workspaceInnerRef.current;
    if (!el) return;
    const width = el.clientWidth;
    const height = el.clientHeight;
    if (width <= 0 || height <= 0) return;
    setWorkspaceArea((prev) => (
      prev.width === width && prev.height === height
        ? prev
        : { width, height }
    ));
  }, [setWorkspaceArea, workspaceInnerRef]);

  const scheduleWorkspaceAreaRemeasure = useCallback(() => {
    if (remeasureScheduledRef.current) return;
    remeasureScheduledRef.current = true;
    remeasureWorkspaceArea();
    requestAnimationFrame(() => {
      remeasureWorkspaceArea();
      requestAnimationFrame(() => {
        remeasureWorkspaceArea();
        remeasureScheduledRef.current = false;
      });
    });
  }, [remeasureWorkspaceArea, requestAnimationFrame]);

  useEffect(() => {
    if (!isTerminalLayerVisible) {
      if (typeof clearTopTabsPreviewVars === 'function') {
        clearTopTabsPreviewVars();
      }
    }
  }, [clearTopTabsPreviewVars, isTerminalLayerVisible]);

  useEffect(() => {
      sidePanelOpenTabs.forEach((tab, tabId) => {
        lastSidePanelTabRef.current.set(tabId, tab);
      });
    }, [sidePanelOpenTabs]);
  
  useEffect(() => {
      const validSessionIds = new Set(sessions.map((session) => session.id));
  
      for (const [id] of splitHorizontalHandlersRef.current) {
        if (!validSessionIds.has(id)) {
          splitHorizontalHandlersRef.current.delete(id);
        }
      }
      for (const [id] of splitVerticalHandlersRef.current) {
        if (!validSessionIds.has(id)) {
          splitVerticalHandlersRef.current.delete(id);
        }
      }
  
      for (const session of sessions) {
        if (!splitHorizontalHandlersRef.current.has(session.id)) {
          splitHorizontalHandlersRef.current.set(session.id, () => {
            onSplitSessionRef.current?.(session.id, 'horizontal');
          });
        }
        if (!splitVerticalHandlersRef.current.has(session.id)) {
          splitVerticalHandlersRef.current.set(session.id, () => {
            onSplitSessionRef.current?.(session.id, 'vertical');
          });
        }
      }
    }, [sessions]);
  
  useEffect(() => {
      const validWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  
      for (const [id] of workspaceFocusHandlersRef.current) {
        if (!validWorkspaceIds.has(id)) {
          workspaceFocusHandlersRef.current.delete(id);
        }
      }
      for (const [id] of workspaceBroadcastHandlersRef.current) {
        if (!validWorkspaceIds.has(id)) {
          workspaceBroadcastHandlersRef.current.delete(id);
        }
      }
  
      for (const workspace of workspaces) {
        if (!workspaceFocusHandlersRef.current.has(workspace.id)) {
          workspaceFocusHandlersRef.current.set(workspace.id, () => {
            onToggleWorkspaceViewModeRef.current?.(workspace.id);
          });
        }
        if (!workspaceBroadcastHandlersRef.current.has(workspace.id)) {
          workspaceBroadcastHandlersRef.current.set(workspace.id, () => {
            onToggleBroadcastRef.current?.(workspace.id);
          });
        }
      }
    }, [workspaces]);
  
  useEffect(() => {
      setSidePanelOpenTabs(prev => filterTabsMap(prev, validAIScopeTargetIds));
      setSftpHostForTab(prev => filterTabsMap(prev, validAIScopeTargetIds));
      setSftpInitialLocationForTab(prev => filterTabsMap(prev, validAIScopeTargetIds));
      setSftpPendingUploadsForTab(prev => filterTabsMap(prev, validAIScopeTargetIds));
      setAiMountedTabIds((prev) => prev.filter((tabId) => validAIScopeTargetIds.has(tabId)));
      setNotesMountedTabIds((prev) => prev.filter((tabId) => validAIScopeTargetIds.has(tabId)));
      setScriptsMountedTabIds((prev) => prev.filter((tabId) => validAIScopeTargetIds.has(tabId)));
      setSystemMountedTabIds((prev) => prev.filter((tabId) => validAIScopeTargetIds.has(tabId)));
      setThemeMountedTabIds((prev) => prev.filter((tabId) => validAIScopeTargetIds.has(tabId)));
      sessionActivityStore.prune(validSessionActivityIds);
    }, [validSessionActivityIds, validAIScopeTargetIds]);
  
  useEffect(() => {
      if (!workspaceInnerRef.current) return;
      const el = workspaceInnerRef.current;
      const updateSize = () => {
        // Ignore zero-size reads while the layer is hidden so split rects are
        // not recomputed from a 1×1 fallback until the real layout is available.
        if (!shouldMeasureTerminalLayerLayout) return;
        remeasureWorkspaceArea();
      };
      updateSize();
      const observer = new ResizeObserver(() => updateSize());
      observer.observe(el);
      // Re-measure when a drag ends so pane rects match the committed layout.
      const unsubscribeSuppress = terminalLayoutSuppressStore.subscribe(() => {
        if (!terminalLayoutSuppressStore.getActive()) {
          scheduleWorkspaceAreaRemeasure();
        }
      });
      return () => {
        unsubscribeSuppress();
        observer.disconnect();
      };
    }, [remeasureWorkspaceArea, scheduleWorkspaceAreaRemeasure, shouldMeasureTerminalLayerLayout, workspaceInnerRef]);

  // Discrete layout changes (side panel toggle, compose bar, workspace tab/view mode)
  // can miss a ResizeObserver tick; host-tree width is handled by the observer
  // because it updates continuously during drag.
  useLayoutEffect(() => {
    if (!shouldMeasureTerminalLayerLayout) return;
    const el = workspaceInnerRef.current;
    const width = el?.clientWidth ?? 0;
    const height = el?.clientHeight ?? 0;
    const prev = layoutEffectSnapshotRef.current;
    const dimensionsUnchanged = width > 0
      && height > 0
      && prev.width === width
      && prev.height === height
      && prev.shellWidth === sidePanelShellWidth;
    if (
      dimensionsUnchanged
      && prev.workspaceId === activeWorkspaceId
      && prev.viewMode === activeWorkspaceViewMode
      && prev.composeBarOpen === isComposeBarOpen
    ) {
      return;
    }
    layoutEffectSnapshotRef.current = {
      workspaceId: activeWorkspaceId,
      viewMode: activeWorkspaceViewMode,
      composeBarOpen: isComposeBarOpen,
      shellWidth: sidePanelShellWidth,
      width,
      height,
    };
    scheduleWorkspaceAreaRemeasure();
  }, [
    activeWorkspaceId,
    activeWorkspaceViewMode,
    isComposeBarOpen,
    scheduleWorkspaceAreaRemeasure,
    shouldMeasureTerminalLayerLayout,
    sidePanelPosition,
    sidePanelShellWidth,
  ]);
  
  // Keep sftpHostForTab in sync with focus changes in workspace mode
    // so that the toggle check uses the currently displayed host.
    useEffect(() => {
      if (!activeTabId || !sftpActiveHost) return;
      if (!sidePanelLayoutHasTool(activeSidePanelLayout, 'sftp')) return;
      const stored = sftpHostForTab.get(activeTabId);
      if (stored?.id === sftpActiveHost.id
        && stored?.hostname === sftpActiveHost.hostname
        && stored?.port === sftpActiveHost.port
        && stored?.protocol === sftpActiveHost.protocol) return;
      setSftpHostForTab(prev => {
        const next = new Map(prev);
        next.set(activeTabId, sftpActiveHost);
        return next;
      });
    }, [activeSidePanelLayout, activeTabId, sftpActiveHost, sftpHostForTab]);
  
  useEffect(() => {
      if (!toggleScriptsSidePanelRef) return;
      toggleScriptsSidePanelRef.current = handleToggleScriptsSidePanel;
      return () => {
        toggleScriptsSidePanelRef.current = null;
      };
    }, [toggleScriptsSidePanelRef, handleToggleScriptsSidePanel]);
  
  useEffect(() => {
      if (!toggleSidePanelRef) return;
      toggleSidePanelRef.current = handleToggleSidePanel;
      return () => {
        toggleSidePanelRef.current = null;
      };
    }, [toggleSidePanelRef, handleToggleSidePanel]);
  
  // Listen for global AI panel toggle (from TopTabs button). Uses the toggle
    // handler so a second click on an already-open AI panel closes it.
    useEffect(() => {
      const handler = () => handleToggleAiFromTopBar();
      window.addEventListener('netcatty:toggle-ai-panel', handler);
      return () => window.removeEventListener('netcatty:toggle-ai-panel', handler);
    }, [handleToggleAiFromTopBar]);

  useEffect(() => {
    const applySftpTargetOnTab = (tabId: string, host: any, targetDirectory: string) => {
      sftpPaneClosedTabIdsRef.current.delete(tabId);
      // Bump initialLocation even when the host is already selected so the
      // path-navigation effect re-runs after reopen.
      setSftpHostForTab((prev: Map<string, any>) => new Map(prev).set(tabId, host));
      setSftpInitialLocationForTab((prev: Map<string, any>) => {
        const next = new Map(prev);
        next.delete(tabId);
        next.set(tabId, {
          hostId: host.id,
          path: targetDirectory,
        });
        return next;
      });
      setSidePanelOpenTabs((prev: Map<string, any>) => new Map(prev).set(tabId, 'sftp'));
    };

    /** When the user is on vault/editor (or no tab), open the host then attach SFTP. */
    const openHostThenSftp = (host: any, targetDirectory: string) => {
      if (typeof onConnectToHost !== 'function') {
        toast.error('Could not open target folder', 'SFTP');
        return;
      }
      const previousTabId = activeTabIdRef.current;
      let sessionOrTabId: string | void;
      try {
        sessionOrTabId = onConnectToHost(host);
      } catch {
        toast.error('Could not open target folder', 'SFTP');
        return;
      }

      const tryApply = (tabId: string | null | undefined) => {
        if (!isTransferNavigationTerminalTabId(tabId)) return false;
        applySftpTargetOnTab(tabId!, host, targetDirectory);
        return true;
      };

      // connectToHost returns the new session id, which is also the top-tab id
      // for non-workspace connections.
      if (typeof sessionOrTabId === 'string' && tryApply(sessionOrTabId)) return;

      const openWhenTabReady = (attempt = 0) => {
        const tabId = activeTabIdRef.current;
        if (tabId && tabId !== previousTabId && tryApply(tabId)) return;
        if (attempt >= 12) {
          // Last chance: use whatever terminal tab is active now.
          if (!tryApply(activeTabIdRef.current)) {
            toast.error('Could not open target folder', 'SFTP');
          }
          return;
        }
        window.setTimeout(() => openWhenTabReady(attempt + 1), 16);
      };
      openWhenTabReady();
    };

    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const task = detail?.task ?? detail;
      const forResume = detail?.forResume === true;
      if (!task) return;

      const navigation = resolveSftpTransferNavigationTarget(task, forResume);
      if (navigation.kind === 'local-path') {
        const localDir = resolveSftpTransferNavigationPath(task, false);
        void openPath(localDir).then((result) => {
          if (!result?.success) {
            toast.error(result?.error || 'Could not open target folder', 'SFTP');
          }
        }).catch(() => {
          toast.error('Could not open target folder', 'SFTP');
        });
        return;
      }

      const currentTabId = activeTabIdRef.current;
      if (navigation.kind === 'local-copy-panel') {
        if (!isTransferNavigationTerminalTabId(currentTabId)) {
          // Local-copy has no remote host to connect; need an existing terminal tab.
          if (forResume) return;
          toast.error('Open a terminal tab first to browse this transfer', 'SFTP');
          return;
        }
        sftpPaneClosedTabIdsRef.current.delete(currentTabId!);
        setSidePanelOpenTabs((prev: Map<string, any>) => new Map(prev).set(currentTabId!, 'sftp'));
        return;
      }

      // Prefer vault id/label; then live SFTP panel hosts (drag-drop uploads
      // often lack targetHostLabel, and open-folder should still jump the pane).
      const hostLabel = resolveSftpTransferNavigationHostLabel(task, navigation.useSourcePath)
        || task.targetHostLabel
        || task.sourceHostLabel;
      const liveHosts: any[] = [];
      if (currentTabId && sftpHostForTab?.get?.(currentTabId)) liveHosts.push(sftpHostForTab.get(currentTabId));
      if (sftpActiveHost) liveHosts.push(sftpActiveHost);
      if (sftpHostForTab && typeof sftpHostForTab.values === 'function') {
        for (const candidate of sftpHostForTab.values()) liveHosts.push(candidate);
      }
      const host = pickHostForTransferNavigation({
        hostId: navigation.hostId,
        hostLabel,
        vaultHosts: effectiveHosts ?? [],
        liveHosts,
        // In-progress uploads almost always target the currently open SFTP host.
        allowLiveUploadFallback: !forResume && task.direction === 'upload',
      });
      if (!host) {
        // Dedicated resume opens its own vault session without the panel.
        // Opening the destination folder needs a resolvable host.
        if (!forResume) {
          toast.error('Could not open target folder', 'SFTP');
        }
        return;
      }

      const targetDirectory = resolveSftpTransferNavigationPath(task, navigation.useSourcePath);

      // Already on a terminal/workspace tab → open SFTP there.
      if (isTransferNavigationTerminalTabId(currentTabId)) {
        applySftpTargetOnTab(currentTabId!, host, targetDirectory);
        return;
      }

      // No terminal tab (vault / editor / empty): open the target host first,
      // then land the SFTP panel on the transfer directory.
      openHostThenSftp(host, targetDirectory);
    };
    window.addEventListener('netcatty:open-sftp-transfer-target', handler);
    return () => window.removeEventListener('netcatty:open-sftp-transfer-target', handler);
  }, [activeTabIdRef, effectiveHosts, onConnectToHost, openPath, setSftpHostForTab, setSftpInitialLocationForTab, setSidePanelOpenTabs, sftpActiveHost, sftpHostForTab, window]);
  
  useEffect(() => {
      const sessionIdsToClear = getSessionActivityIdsToClear(activeTabId, sessions);
      if (sessionIdsToClear.length === 1) {
        sessionActivityStore.clearTab(sessionIdsToClear[0]);
        return;
      }
      if (sessionIdsToClear.length > 1) {
        sessionActivityStore.clearTabs(sessionIdsToClear);
      }
    }, [activeTabId, sessions]);
  
  useEffect(() => {
      const activeSessionIds = new Set(activityTrackedSessions.map((session) => session.id));
      for (const sessionId of activityEscapeFiltersRef.current.keys()) {
        if (!activeSessionIds.has(sessionId)) {
          activityEscapeFiltersRef.current.delete(sessionId);
        }
      }

      const unsubscribers = activityTrackedSessions.map((session) => {
        let filter = activityEscapeFiltersRef.current.get(session.id);
        if (!filter) {
          filter = new ChunkedEscapeFilter();
          activityEscapeFiltersRef.current.set(session.id, filter);
        }
        return onSessionData(session.id, (chunk) => {
          const hasNotifiableOutput = hasNotifiableTerminalOutput(filter, chunk);
          if (!shouldMarkSessionActivity(activeTabIdRef.current, session)) {
            return;
          }
          if (sessionActivityStore.getSnapshot()[session.id]) {
            return;
          }
          if (!hasNotifiableOutput) return;
  
          sessionActivityStore.setTabActive(session.id, true);
        });
      });
  
      return () => {
        for (const unsubscribe of unsubscribers) {
          unsubscribe();
        }
      };
    }, [activityTrackedSessions, onSessionData]);

  // MCP/SDK approval IPC is owned by AppWithProviders so External MCP approvals
  // work before TerminalLayer lazy-mounts. Do not re-subscribe here.

  useEffect(() => {
      if (isFocusMode && dropHint) {
        setDropHint(null);
      }
    }, [isFocusMode, dropHint]);
  
  const wasTerminalLayerVisibleRef = useRef(false);
  const prevActiveTabIdRef = useRef<string | undefined>(undefined);

  // Restore keyboard focus after switching work tabs.
  // Call the existing focus primitive directly — it already schedules rAF +
  // retry (focusTerminalSessionInput). An outer rAF here only delayed focus.
  useEffect(() => {
    if (!isTerminalLayerVisible) {
      prevActiveTabIdRef.current = activeTabId;
      return;
    }

    const tabChanged =
      prevActiveTabIdRef.current !== undefined &&
      prevActiveTabIdRef.current !== activeTabId;
    prevActiveTabIdRef.current = activeTabId;

    if (!tabChanged || !refocusActiveTerminalSession) return;
    refocusActiveTerminalSession();
  }, [activeTabId, isTerminalLayerVisible, refocusActiveTerminalSession]);

  // When focusedSessionId changes or terminal layer becomes visible,
    // focus the corresponding terminal to restore :focus-within CSS state
    useEffect(() => {
      // Only handle split view mode (not focus mode)
      if (isFocusMode || !focusedSessionId || !activeWorkspace) {
        wasTerminalLayerVisibleRef.current = isTerminalLayerVisible;
        return;
      }
  
      // Trigger on focusedSessionId change OR when layer becomes visible again
      const sessionChanged = prevFocusedSessionIdRef.current !== focusedSessionId;
      const layerBecameVisible = isTerminalLayerVisible && !wasTerminalLayerVisibleRef.current;
      wasTerminalLayerVisibleRef.current = isTerminalLayerVisible;
      if (!sessionChanged && !layerBecameVisible) return;
      const prevFocusedId = sessionChanged ? prevFocusedSessionIdRef.current : undefined;
      prevFocusedSessionIdRef.current = focusedSessionId;
  
      // First, blur the currently focused terminal immediately
      if (prevFocusedId) {
        const prevPane = document.querySelector(`[data-session-id="${prevFocusedId}"]`);
        if (prevPane) {
          const prevTextarea = prevPane.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement | null;
          if (prevTextarea) {
            prevTextarea.blur();
          }
        }
      }
  
      const focusTarget = () => {
        const targetPane = document.querySelector(`[data-session-id="${focusedSessionId}"]`);
        if (targetPane) {
          const textarea = targetPane.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement | null;
          if (textarea && document.activeElement !== textarea) {
            textarea.focus();
          }
        }
      };
  
      // One sync attempt + one rAF; avoid the historical 50ms third focus.
      focusTarget();
      let rafId: number | null = null;
      if (typeof requestAnimationFrame === 'function') {
        rafId = requestAnimationFrame(focusTarget);
      }

      return () => {
        if (rafId !== null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(rafId);
        }
      };
    }, [focusedSessionId, isFocusMode, activeWorkspace, isTerminalLayerVisible]);
}
