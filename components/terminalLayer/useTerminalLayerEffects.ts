/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */
import { useEffect, useLayoutEffect } from 'react';

type TerminalLayerEffectsContext = Record<string, any>;

export function useTerminalLayerEffects(ctx: TerminalLayerEffectsContext) {
  const { activeSidePanelTab, activeTabId, activeTabIdRef, activeTopTabsThemeId, activeWorkspace, activityTrackedSessions, appliedPreviewSessionRef, applyTerminalPreviewVars, applyTopTabsPreviewVars, cancelAnimationFrame, ChunkedEscapeFilter, clearTerminalPreviewVars, clearTimeout, clearTopTabsPreviewVars, document, dropHint, filterTabsMap, focusedSessionId, followAppTerminalTheme, getSessionActivityIdsToClear, handleToggleAiFromTopBar, handleToggleScriptsSidePanel, handleToggleSidePanel, hasNotifiableTerminalOutput, isFocusMode, isTerminalLayerVisible, lastSidePanelTabRef, Map, Math, onSessionData, onSplitSessionRef, onToggleBroadcastRef, onToggleWorkspaceViewModeRef, onUpdateSplitSizes, prevFocusedSessionIdRef, previewTargetSessionId, requestAnimationFrame, ResizeObserver, resizing, sessionActivityStore, sessions, Set, setDropHint, setResizing, setSftpHostForTab, setSftpInitialLocationForTab, setSftpPendingUploadsForTab, setSidePanelOpenTabs, setThemePreview, setTimeout, setupMcpApprovalBridge, setWorkspaceArea, sftpActiveHost, sftpHostForTab, shouldMarkSessionActivity, sidePanelOpenTabs, splitHorizontalHandlersRef, splitVerticalHandlersRef, terminalRendererCwdBySessionRef, themeCommitTimerRef, themePreview, toggleScriptsSidePanelRef, toggleSidePanelRef, validAIScopeTargetIds, validSessionActivityIds, visibleFocusedThemeId, window, workspaceBroadcastHandlersRef, workspaceFocusHandlersRef, workspaceInnerRef, workspaces } = ctx;

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
      sessionActivityStore.prune(validSessionActivityIds);
    }, [validSessionActivityIds, validAIScopeTargetIds]);
  
  useEffect(() => {
      if (!workspaceInnerRef.current) return;
      const el = workspaceInnerRef.current;
      const updateSize = () => {
        const width = el.clientWidth;
        const height = el.clientHeight;
        setWorkspaceArea((prev) => (
          prev.width === width && prev.height === height
            ? prev
            : { width, height }
        ));
      };
      updateSize();
      const observer = new ResizeObserver(() => updateSize());
      observer.observe(el);
      return () => observer.disconnect();
    }, [activeWorkspace]);
  
  useEffect(() => {
      if (!resizing) return;
      let rafId: number | null = null;
      let lastDelta = 0;
      const applySizes = () => {
        const dimension = resizing.direction === 'vertical' ? resizing.startArea.w : resizing.startArea.h;
        if (dimension <= 0) return;
        const total = resizing.startSizes.reduce((acc, n) => acc + n, 0) || 1;
        const pxSizes = resizing.startSizes.map(s => (s / total) * dimension);
        const i = resizing.index;
        let a = pxSizes[i] + lastDelta;
        let b = pxSizes[i + 1] - lastDelta;
        const minPx = Math.min(120, dimension / 2);
        if (a < minPx) {
          const diff = minPx - a;
          a = minPx;
          b -= diff;
        }
        if (b < minPx) {
          const diff = minPx - b;
          b = minPx;
          a -= diff;
        }
        const newPxSizes = [...pxSizes];
        newPxSizes[i] = Math.max(minPx, a);
        newPxSizes[i + 1] = Math.max(minPx, b);
        const totalPx = newPxSizes.reduce((acc, n) => acc + n, 0) || 1;
        const newSizes = newPxSizes.map(n => n / totalPx);
        onUpdateSplitSizes(resizing.workspaceId, resizing.splitId, newSizes);
      };
      const onMove = (e: MouseEvent) => {
        lastDelta = resizing.direction === 'vertical' ? e.clientX - resizing.startClient.x : e.clientY - resizing.startClient.y;
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          applySizes();
        });
      };
      const onUp = () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        applySizes();
        setResizing(null);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      return () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
    }, [resizing, onUpdateSplitSizes]);
  
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
      if (activeTopTabsThemeId) {
        applyTopTabsPreviewVars(activeTopTabsThemeId);
        return;
      }
      clearTopTabsPreviewVars();
    }, [activeTopTabsThemeId, applyTopTabsPreviewVars]);
  
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
  
  // When focusedSessionId changes or terminal layer becomes visible,
    // focus the corresponding terminal to restore :focus-within CSS state
    useEffect(() => {
      // Only handle split view mode (not focus mode)
      if (isFocusMode || !focusedSessionId || !activeWorkspace) return;
  
      // Trigger on focusedSessionId change OR when layer becomes visible again
      const sessionChanged = prevFocusedSessionIdRef.current !== focusedSessionId;
      if (!sessionChanged && !isTerminalLayerVisible) return;
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
  
      // Focus the new terminal multiple times to fight against xterm's focus restoration
      const focusTarget = () => {
        const targetPane = document.querySelector(`[data-session-id="${focusedSessionId}"]`);
        if (targetPane) {
          const textarea = targetPane.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement | null;
          if (textarea) {
            textarea.focus();
          }
        }
      };
  
      // Focus immediately
      focusTarget();
  
      // Focus again after short delays to override any competing focus attempts
      const timer1 = setTimeout(focusTarget, 10);
      const timer2 = setTimeout(focusTarget, 50);
      const timer3 = setTimeout(focusTarget, 100);
  
      return () => {
        clearTimeout(timer1);
        clearTimeout(timer2);
        clearTimeout(timer3);
      };
    }, [focusedSessionId, isFocusMode, activeWorkspace, isTerminalLayerVisible]);
}
