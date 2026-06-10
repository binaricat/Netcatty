/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import { terminalLayoutSuppressStore } from '../../application/state/terminalLayoutSuppressStore';
import { AI_PANEL_FORCE_HIDE_SHELL } from '../ai/aiPanelDiagnostics';
import { getTerminalSidePanelShellWidth } from './TerminalLayerSidePanelSection';

type TerminalLayerEffectsContext = Record<string, any>;

export function useTerminalLayerEffects(ctx: TerminalLayerEffectsContext) {
  const { activeSidePanelTab, activeTabId, activeTabIdRef, activeTopTabsThemeId, activeWorkspace, activityTrackedSessions, appliedPreviewSessionRef, applyTerminalPreviewVars, applyTopTabsPreviewVars, cancelAnimationFrame, ChunkedEscapeFilter, clearTerminalPreviewVars, clearTimeout, clearTopTabsPreviewVars, document, dropHint, filterTabsMap, focusedSessionId, followAppTerminalTheme, getSessionActivityIdsToClear, handleToggleAiFromTopBar, handleToggleScriptsSidePanel, handleToggleSidePanel, hasNotifiableTerminalOutput, isComposeBarOpen, isFocusMode, isTerminalLayerVisible, lastSidePanelTabRef, Map, onSessionData, onSplitSessionRef, onToggleBroadcastRef, onToggleWorkspaceViewModeRef, prevFocusedSessionIdRef, previewTargetSessionId, refocusActiveTerminalSession, requestAnimationFrame, ResizeObserver, sessionActivityStore, sessions, Set, setAiMountedTabIds, setDropHint, setScriptsMountedTabIds, setSftpHostForTab, setSftpInitialLocationForTab, setSftpPendingUploadsForTab, setSidePanelOpenTabs, setThemeMountedTabIds, setThemePreview, setTimeout, setupMcpApprovalBridge, setWorkspaceArea, sidePanelPosition, sidePanelWidth, sftpActiveHost, sftpHostForTab, shouldMarkSessionActivity, sidePanelOpenTabs, splitHorizontalHandlersRef, splitVerticalHandlersRef, terminalRendererCwdBySessionRef, themeCommitTimerRef, themePreview, toggleScriptsSidePanelRef, toggleSidePanelRef, validAIScopeTargetIds, validSessionActivityIds, visibleFocusedThemeId, window, workspaceBroadcastHandlersRef, workspaceFocusHandlersRef, workspaceInnerRef, workspaces } = ctx;

  const activeWorkspaceId = activeWorkspace?.id;
  const activeWorkspaceViewMode = activeWorkspace?.viewMode;

  const isSidePanelOpenForCurrentTab = activeTabId ? sidePanelOpenTabs.has(activeTabId) : false;
  const sidePanelShellWidth = getTerminalSidePanelShellWidth({
    activeSidePanelTab,
    forceHideAiShell: AI_PANEL_FORCE_HIDE_SHELL,
    isSidePanelOpenForCurrentTab,
    resizePreviewWidth: null,
    sidePanelWidth,
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
    remeasureWorkspaceArea();
    requestAnimationFrame(() => {
      remeasureWorkspaceArea();
      requestAnimationFrame(remeasureWorkspaceArea);
    });
  }, [remeasureWorkspaceArea, requestAnimationFrame]);

  useEffect(() => {
      const liveSessionIds = new Set(sessions.map((session) => session.id));
      for (const sessionId of terminalRendererCwdBySessionRef.current.keys()) {
        if (!liveSessionIds.has(sessionId)) {
          terminalRendererCwdBySessionRef.current.delete(sessionId);
        }
      }
    }, [sessions]);
  
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
      setScriptsMountedTabIds((prev) => prev.filter((tabId) => validAIScopeTargetIds.has(tabId)));
      setThemeMountedTabIds((prev) => prev.filter((tabId) => validAIScopeTargetIds.has(tabId)));
      sessionActivityStore.prune(validSessionActivityIds);
    }, [validSessionActivityIds, validAIScopeTargetIds]);
  
  useEffect(() => {
      if (!workspaceInnerRef.current) return;
      const el = workspaceInnerRef.current;
      const updateSize = () => {
        // Ignore zero-size reads while the layer is hidden so split rects are
        // not recomputed from a 1×1 fallback until the real layout is available.
        if (!isTerminalLayerVisible) return;
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
    }, [isTerminalLayerVisible, remeasureWorkspaceArea, scheduleWorkspaceAreaRemeasure, workspaceInnerRef]);

  // Discrete layout changes (side panel toggle, compose bar, workspace tab/view mode)
  // can miss a ResizeObserver tick; host-tree width is handled by the observer
  // because it updates continuously during drag.
  useEffect(() => {
      if (!isTerminalLayerVisible) return;
      scheduleWorkspaceAreaRemeasure();
    }, [
      activeWorkspaceId,
      activeWorkspaceViewMode,
      isComposeBarOpen,
      isTerminalLayerVisible,
      scheduleWorkspaceAreaRemeasure,
      sidePanelPosition,
      sidePanelShellWidth,
    ]);
  
  // Keep sftpHostForTab in sync with focus changes in workspace mode
    // so that the toggle check uses the currently displayed host.
    useEffect(() => {
      if (!activeTabId || !sftpActiveHost) return;
      if (sidePanelOpenTabs.get(activeTabId) !== 'sftp') return;
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
    }, [activeTabId, sftpActiveHost, sidePanelOpenTabs, sftpHostForTab]);
  
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
      const unsubscribers = activityTrackedSessions.map((session) => {
        const filter = new ChunkedEscapeFilter();
        return onSessionData(session.id, (chunk) => {
          if (!hasNotifiableTerminalOutput(filter, chunk)) return;
  
          if (!shouldMarkSessionActivity(activeTabIdRef.current, session)) {
            return;
          }
  
          sessionActivityStore.setTabActive(session.id, true);
        });
      });
  
      return () => {
        for (const unsubscribe of unsubscribers) {
          unsubscribe();
        }
      };
    }, [activityTrackedSessions, onSessionData]);
  
  useEffect(() => {
      return () => {
        if (themeCommitTimerRef.current) {
          clearTimeout(themeCommitTimerRef.current);
        }
        clearTerminalPreviewVars(appliedPreviewSessionRef.current);
        clearTopTabsPreviewVars();
      };
    }, []);
  
  useEffect(() => {
      const appliedSessionId = appliedPreviewSessionRef.current;
      if (
        appliedSessionId &&
        (appliedSessionId !== themePreview.targetSessionId || !themePreview.themeId)
      ) {
        clearTerminalPreviewVars(appliedSessionId);
        appliedPreviewSessionRef.current = null;
      }
  
      if (themePreview.targetSessionId && themePreview.themeId) {
        applyTerminalPreviewVars(themePreview.targetSessionId, themePreview.themeId);
        appliedPreviewSessionRef.current = themePreview.targetSessionId;
      }
    }, [applyTerminalPreviewVars, themePreview]);
  
  useLayoutEffect(() => {
      if (!isTerminalLayerVisible) {
        clearTopTabsPreviewVars();
        return;
      }
      if (activeTopTabsThemeId) {
        applyTopTabsPreviewVars(activeTopTabsThemeId);
        return;
      }
      if (typeof document !== 'undefined' && document.documentElement.dataset.activeChromeTheme) return;
      clearTopTabsPreviewVars();
    }, [activeTopTabsThemeId, applyTopTabsPreviewVars, isTerminalLayerVisible]);
  
  useEffect(() => {
      if (!followAppTerminalTheme) return;
      if (themeCommitTimerRef.current) {
        clearTimeout(themeCommitTimerRef.current);
        themeCommitTimerRef.current = null;
      }
      const appliedSessionId = appliedPreviewSessionRef.current;
      if (appliedSessionId) {
        clearTerminalPreviewVars(appliedSessionId);
        appliedPreviewSessionRef.current = null;
      }
      clearTopTabsPreviewVars();
      if (themePreview.targetSessionId || themePreview.themeId) {
        setThemePreview({ targetSessionId: null, themeId: null });
      }
    }, [followAppTerminalTheme, themePreview.targetSessionId, themePreview.themeId]);
  
  useEffect(() => {
      const panelOpen = activeSidePanelTab === 'theme' && !!previewTargetSessionId;
      const shouldKeepPreview =
        panelOpen &&
        themePreview.targetSessionId === previewTargetSessionId &&
        !!themePreview.targetSessionId &&
        !!themePreview.themeId;
  
      if (shouldKeepPreview) return;
  
      const appliedSessionId = appliedPreviewSessionRef.current;
      if (appliedSessionId) {
        clearTerminalPreviewVars(appliedSessionId);
        appliedPreviewSessionRef.current = null;
      }
      if (themePreview.targetSessionId || themePreview.themeId) {
        setThemePreview({ targetSessionId: null, themeId: null });
      }
    }, [activeSidePanelTab, previewTargetSessionId, themePreview.targetSessionId, themePreview.themeId]);
  
  useEffect(() => {
      if (
        themePreview.targetSessionId === previewTargetSessionId &&
        themePreview.themeId &&
        themePreview.themeId === visibleFocusedThemeId
      ) {
        setThemePreview({ targetSessionId: null, themeId: null });
      }
    }, [previewTargetSessionId, themePreview, visibleFocusedThemeId]);
  
  // Keep MCP/SDK-agent approval IPC listener alive for the entire terminal lifecycle.
    // Must live here (TerminalLayer), not inside the AI panel subtree, so closing
    // or hiding the panel never tears down approval handling mid-execution.
    useEffect(() => {
      return setupMcpApprovalBridge();
    }, []);
  
  useEffect(() => {
      if (isFocusMode && dropHint) {
        setDropHint(null);
      }
    }, [isFocusMode, dropHint]);
  
  const wasTerminalLayerVisibleRef = useRef(false);
  const prevActiveTabIdRef = useRef<string | undefined>(undefined);

  // Restore keyboard focus to the active terminal after switching work tabs.
  useEffect(() => {
    if (!isTerminalLayerVisible) {
      prevActiveTabIdRef.current = activeTabId;
      return;
    }

    const tabChanged =
      prevActiveTabIdRef.current !== undefined &&
      prevActiveTabIdRef.current !== activeTabId;
    prevActiveTabIdRef.current = activeTabId;

    if (!tabChanged) return;
    refocusActiveTerminalSession?.();
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
  
      focusTarget();
      let rafId: number | null = null;
      if (typeof requestAnimationFrame === 'function') {
        rafId = requestAnimationFrame(focusTarget);
      }
      const timerId = setTimeout(focusTarget, 50);
  
      return () => {
        if (rafId !== null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(rafId);
        }
        clearTimeout(timerId);
      };
    }, [focusedSessionId, isFocusMode, activeWorkspace, isTerminalLayerVisible]);
}
