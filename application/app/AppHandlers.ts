/* eslint-disable @typescript-eslint/no-explicit-any */
import type React from 'react';
import type { Host, HostProtocol, TerminalSession } from '../../types';
import type { PassphraseRequest } from '../../components/PassphraseModal';
import type { TerminalPopupPayload } from '../../domain/systemManager/types';
import { getEffectiveHostDistro } from '../../domain/host';
import { sanitizeHostIconFields } from '../../domain/hostIcon';
import { resolveEffectiveTerminalProtocol } from '../../domain/terminalProtocol';
import { getTerminalPassthroughActions } from '../state/useGlobalHotkeys';
import { buildNumberShortcutTabTargets } from './tabShortcutTargets';

type AppContextGetter = () => Record<string, any>;
const TERMINAL_PASSTHROUGH_ACTIONS = getTerminalPassthroughActions();

async function deliverKeyboardInteractiveResponse(
  ctx: Record<string, any>,
  requestId: string,
  responses: string[],
  cancelled: boolean,
) {
  const { netcattyBridge, t, toast } = ctx;
  const bridge = netcattyBridge.get();
  if (!bridge?.respondKeyboardInteractive) {
    toast.error(t('common.unknownError'), t('common.error'));
    return false;
  }
  try {
    const result = await bridge.respondKeyboardInteractive(requestId, responses, cancelled);
    if (!result?.success) {
      toast.error(result?.error || t('common.unknownError'), t('common.error'));
      return false;
    }
    return true;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t('common.unknownError'), t('common.error'));
    return false;
  }
}

export const getLogHostVisualSnapshot = (host: Host) => {
  const icon = sanitizeHostIconFields(host);
  return {
    hostOs: host.os,
    hostDistro: getEffectiveHostDistro(host) || undefined,
    hostIconMode: icon.iconMode,
    hostIconId: icon.iconId,
    ...(icon.iconColorMode ? { hostIconColorMode: icon.iconColorMode } : {}),
    ...(icon.iconColor ? { hostIconColor: icon.iconColor } : {}),
    ...(icon.iconColorCustom ? { hostIconColorCustom: icon.iconColorCustom } : {}),
  };
};

/**
 * AI silent sessions stay out of the tab bar. Opening them via tray should
 * attach a terminal-popup window to the same live PTY (same sessionId) instead
 * of activating them as a main-window tab (tab-less terminal surface) or
 * spawning a new shell via connection reuse.
 */
export function buildAiSilentSessionPopupPayload(session: TerminalSession): TerminalPopupPayload {
  const { hiddenFromTabs: _hiddenFromTabs, ...sourceSession } = session;
  return {
    title: session.hostLabel || 'Terminal',
    parentSessionId: session.id,
    startupCommand: '',
    attachSessionId: session.id,
    sourceSession: {
      ...sourceSession,
    },
  };
}

export async function handleTrayJumpToSessionImpl(getCtx: AppContextGetter, sessionId: string) {
  const {
    sessions,
    setActiveTabId,
    setWorkspaceFocusedSession,
    netcattyBridge,
    toast,
    t,
  } = getCtx();
  const session = sessions.find((item: TerminalSession) => item.id === sessionId);
  if (!session) return;

  if (session.hiddenFromTabs) {
    // Leave the main surface if this silent session was already activated
    // (legacy jump path left a terminal with no tab chrome).
    const getActiveTabId = getCtx().getActiveTabId as (() => string) | undefined;
    if (!getActiveTabId || getActiveTabId() === sessionId) {
      setActiveTabId('vault');
    }

    const bridge = netcattyBridge?.get?.();
    if (!bridge?.openTerminalPopup) {
      toast?.error?.(t?.('tabs.copyTabToNewWindowFailed') ?? 'Failed to open tab in a new window');
      return;
    }
    try {
      const result = await bridge.openTerminalPopup(buildAiSilentSessionPopupPayload(session));
      if (!result?.success) {
        toast?.error?.(
          result?.error
            || t?.('tabs.copyTabToNewWindowFailed')
            || 'Failed to open tab in a new window',
        );
      }
    } catch (err) {
      toast?.error?.(
        err instanceof Error
          ? err.message
          : (t?.('tabs.copyTabToNewWindowFailed') ?? 'Failed to open tab in a new window'),
      );
    }
    return;
  }

  // Visible sessions still live in the main window; bring it forward now that
  // the tray jump IPC no longer auto-focuses main (silent AI sessions open a
  // popup instead and must not steal main-window focus).
  void netcattyBridge?.get?.()?.openMainWindow?.();

  if (session.workspaceId) {
    setActiveTabId(session.workspaceId);
    setWorkspaceFocusedSession(session.workspaceId, sessionId);
    return;
  }
  setActiveTabId(sessionId);
}

export function handleTrayTogglePortForwardImpl(getCtx: AppContextGetter, ruleId: string, start: boolean) {
  const { hasRuntimeTunnel, hosts, identities, keys, knownHosts, portForwardingRules, resolveEffectiveHost, startTunnel, stopTunnel, t, terminalSettings, toast } = getCtx();
{
    const rule = portForwardingRules.find((item) => item.id === ruleId);
    if (!rule) return;
    const host = rule.hostId ? hosts.find((item) => item.id === rule.hostId) : undefined;
    if (!host) {
      toast.error(t("pf.error.hostNotFound"));
      return;
    }

    if (start) {
      if (!hasRuntimeTunnel(ruleId)) {
        const effectiveHost = resolveEffectiveHost(host);
        void startTunnel(rule, effectiveHost, hosts.map(resolveEffectiveHost), keys, identities, (status, error) => {
          if (status === "error" && error) toast.error(error);
        }, rule.autoStart, terminalSettings, knownHosts);
      }
      return;
    }

    void stopTunnel(ruleId).then((result) => {
      if (!result.success && result.error) toast.error(result.error);
    });
  }
}

export function handleTrayPanelConnectImpl(getCtx: AppContextGetter, hostId: string) {
  const { addConnectionLog, connectToHost, hosts, identities, keys, resolveEffectiveHost, resolveHostAuth, systemInfoRef, t, toast } = getCtx();
  {
    const host = hosts.find((item) => item.id === hostId);
    if (!host) {
      toast.error(t("pf.error.hostNotFound"));
      return;
    }

    const effectiveHost = resolveEffectiveHost(host);

    const { username, hostname: localHost } = systemInfoRef.current;
    if (effectiveHost.protocol === 'serial') {
      const portName = host.hostname.split('/').pop() || host.hostname;
      const sessionId = connectToHost(effectiveHost);
      addConnectionLog({
        sessionId,
        hostId: host.id,
        hostLabel: host.label || `Serial: ${portName}`,
        hostname: host.hostname,
        username,
        protocol: 'serial',
        ...getLogHostVisualSnapshot(effectiveHost),
        startTime: Date.now(),
        localUsername: username,
        localHostname: localHost,
        saved: false,
      });
      return sessionId;
    }

    const protocol = resolveEffectiveTerminalProtocol(effectiveHost);
    const resolvedAuth = resolveHostAuth({ host: effectiveHost, keys, identities });
    const sessionId = connectToHost(effectiveHost);
    addConnectionLog({
      sessionId,
      hostId: host.id,
      hostLabel: host.label,
      hostname: host.hostname,
      username: resolvedAuth.username || 'root',
      protocol,
      ...getLogHostVisualSnapshot(effectiveHost),
      startTime: Date.now(),
      localUsername: username,
      localHostname: localHost,
      saved: false,
    });
    return sessionId;
  }
}

export function handleTrayPanelConnectRequestImpl(getCtx: AppContextGetter, hostId: string) {
  const { connectNow, isVaultInitialized, queueConnect } = getCtx();
  if (!hostId) return;
  if (!isVaultInitialized) {
    queueConnect(hostId);
    return;
  }
  connectNow(hostId);
}

export function flushQueuedTrayPanelConnectHostsImpl(getCtx: AppContextGetter) {
  const { connectNow, pendingHostIds, setPendingHostIds } = getCtx();
  if (!Array.isArray(pendingHostIds) || pendingHostIds.length === 0) return;
  const hostIds = [...pendingHostIds];
  setPendingHostIds([]);
  hostIds.forEach((hostId: string) => connectNow(hostId));
}

export function handleGlobalHotkeyKeyDownImpl(getCtx: AppContextGetter, e: KeyboardEvent) {
  const { HOTKEY_DEBUG, closeTabKeyStr, executeHotkeyAction, hotkeyScheme, keyBindings, matchesKeyBinding } = getCtx();
{
    const isMac = hotkeyScheme === 'mac';
    const target = e.target as HTMLElement;
    const isCloseTabHotkey = closeTabKeyStr ? matchesKeyBinding(e, closeTabKeyStr, isMac) : false;
    const dialogHotkeyScope = target.closest?.('[data-hotkey-close-tab="true"]');

    if (isCloseTabHotkey && dialogHotkeyScope) {
      return;
    }

    if (isCloseTabHotkey) {
      const openDialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"]'));
      const topmostOpenDialog = openDialogs[openDialogs.length - 1] ?? null;
      const topmostDialogClose = topmostOpenDialog?.querySelector<HTMLElement>('[data-dialog-close="true"]');
      if (topmostDialogClose) {
        e.preventDefault();
        e.stopPropagation();
        topmostDialogClose.click();
        return;
      }
    }

    const isFormElement = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
    const isMonacoElement =
      target instanceof HTMLElement &&
      !!target.closest?.('.monaco-editor, .monaco-diff-editor, .monaco-inputbox');
    const isXtermInput =
      target instanceof HTMLElement &&
      !!target.closest?.(".xterm, .xterm-helper-textarea, .xterm-screen, .xterm-viewport");

    const quickSwitchBinding = keyBindings.find((binding) => binding.action === 'quickSwitch');
    const quickSwitchKeyStr = quickSwitchBinding ? (isMac ? quickSwitchBinding.mac : quickSwitchBinding.pc) : null;
    const isQuickSwitchHotkey = quickSwitchKeyStr ? matchesKeyBinding(e, quickSwitchKeyStr, isMac) : false;

    if ((isFormElement || isMonacoElement) && !isXtermInput && e.key !== 'Escape' && !isQuickSwitchHotkey) {
      return;
    }

    const isTerminalElement =
      target instanceof HTMLElement &&
      !!target.closest?.(".xterm, .xterm-helper-textarea, .xterm-screen, .xterm-viewport");
    const isTerminalInPath = Boolean(
      e.composedPath?.().some(
        (node) =>
          node instanceof HTMLElement &&
          (node.classList.contains("xterm") ||
            node.classList.contains("xterm-helper-textarea") ||
            node.classList.contains("xterm-screen") ||
            node.classList.contains("xterm-viewport") ||
            node.hasAttribute("data-session-id")),
      ),
    );

    for (const binding of keyBindings) {
      const keyStr = isMac ? binding.mac : binding.pc;
      if (!matchesKeyBinding(e, keyStr, isMac)) continue;
      if (HOTKEY_DEBUG) console.log('[Hotkeys] Matched binding:', binding.action, keyStr);
      if (binding.category === 'sftp') {
        continue;
      }
      if (TERMINAL_PASSTHROUGH_ACTIONS.has(binding.action)) {
        if (isTerminalElement) {
          return;
        }
        continue;
      }

      e.preventDefault();
      e.stopPropagation();
      if (HOTKEY_DEBUG) {
        console.log('[Hotkeys] Global handle', {
          action: binding.action,
          key: e.key,
          meta: e.metaKey,
          ctrl: e.ctrlKey,
          alt: e.altKey,
          shift: e.shiftKey,
          targetTag: target?.tagName,
          isTerminalElement,
          isTerminalInPath,
        });
      }
      executeHotkeyAction(binding.action, e);
      return;
    }
  }
}

export function handleEscapeKeyDownImpl(getCtx: AppContextGetter, e: KeyboardEvent) {
  const { isQuickSwitcherOpen, setIsQuickSwitcherOpen } = getCtx();
{
    if (e.key === 'Escape' && isQuickSwitcherOpen) {
      setIsQuickSwitcherOpen(false);
    }
  }
}

export async function handleKeyboardInteractiveSubmitImpl(
  getCtx: AppContextGetter,
  requestId: string,
  responses: string[],
  savePassword?: string,
) {
  const ctx = getCtx();
  const {
    hosts,
    hostsRef,
    keyboardInteractiveQueue,
    sessions,
    setKeyboardInteractiveQueue,
    updateHosts,
  } = ctx;
{
    if (!await deliverKeyboardInteractiveResponse(ctx, requestId, responses, false)) return false;
    const request = keyboardInteractiveQueue.find(r => r.requestId === requestId);
    const session = request?.sessionId
      ? sessions.find(s => s.id === request.sessionId)
      : undefined;
    const explicitHostId = typeof request?.hostId === "string" ? request.hostId : undefined;
    const canUseExplicitHost = !!explicitHostId;
    // Only mutate the destination host when the prompting hostname matches —
    // jump-host challenges without an explicit hostId must not rewrite the target host.
    const canUpdateDestinationHost = !!(
      session?.hostId
      && (!request?.hostname || request.hostname === session.hostname)
    );
    const hostIdToUpdate = canUseExplicitHost
      ? explicitHostId
      : canUpdateDestinationHost
        ? session.hostId
        : undefined;
    const latestHosts = hostsRef?.current ?? hosts;
    const host = hostIdToUpdate
      ? latestHosts.find((h: Host) => h.id === hostIdToUpdate)
      : undefined;
    // Save password to host if requested - never for second-factor / EDR prompts
    // (allowSavePassword === false) so a secondary secret cannot overwrite the
    // host login password (#2150 / Codex review on #2151).
    if (savePassword && host && request?.allowSavePassword !== false) {
      updateHosts(latestHosts.map((h: Host) => h.id === host.id ? {
        ...h,
        password: savePassword,
        savePassword: true,
      } : h));
    }
    // Remove from queue by requestId
    setKeyboardInteractiveQueue(prev => prev.filter(r => r.requestId !== requestId));
    return true;
  }
}

export async function handleKeyboardInteractiveCancelImpl(getCtx: AppContextGetter, requestId: string) {
  const ctx = getCtx();
  const { setKeyboardInteractiveQueue } = ctx;
{
    if (!await deliverKeyboardInteractiveResponse(ctx, requestId, [], true)) return false;
    // Remove from queue by requestId
    setKeyboardInteractiveQueue(prev => prev.filter(r => r.requestId !== requestId));
    return true;
  }
}

export async function handlePassphraseSubmitImpl(getCtx: AppContextGetter, requestId: string, passphrase: string, remember: boolean) {
  const { keysRef, netcattyBridge, passphraseQueue, rememberKeyPassphrase, setPassphraseQueue, updateKeys } = getCtx();
{
    const bridge = netcattyBridge.get();
    const request = passphraseQueue.find((r: PassphraseRequest) => r.requestId === requestId);

    // Save passphrase if requested
    if (remember && request?.keyPath) {
      console.log('[App] Saving passphrase for:', request.keyPath);
      try {
        await rememberKeyPassphrase({
          keyPath: request.keyPath,
          passphrase,
          keys: keysRef.current,
          updateKeys,
          setCurrentKeys: (updated) => {
            keysRef.current = updated;
          },
        });
      } catch (err) {
        console.warn('[App] Failed to save passphrase:', err);
      }
    }

    if (bridge?.respondPassphrase) {
      void bridge.respondPassphrase(requestId, passphrase, false);
    }

    setPassphraseQueue(prev => prev.filter(r => r.requestId !== requestId));
  }
}

export function handlePassphraseCancelImpl(getCtx: AppContextGetter, requestId: string) {
  const { netcattyBridge, setPassphraseQueue } = getCtx();
{
    const bridge = netcattyBridge.get();
    if (bridge?.respondPassphrase) {
      // Cancel = stop the entire passphrase flow
      void bridge.respondPassphrase(requestId, '', true);
    }
    setPassphraseQueue(prev => prev.filter(r => r.requestId !== requestId));
  }
}

export function handlePassphraseSkipImpl(getCtx: AppContextGetter, requestId: string) {
  const { netcattyBridge, setPassphraseQueue } = getCtx();
{
    const bridge = netcattyBridge.get();
    if (bridge?.respondPassphraseSkip) {
      // Skip = skip this key but continue asking for others
      void bridge.respondPassphraseSkip(requestId);
    } else if (bridge?.respondPassphrase) {
      // Fallback for older API
      void bridge.respondPassphrase(requestId, '', false);
    }
    setPassphraseQueue(prev => prev.filter(r => r.requestId !== requestId));
  }
}

export function createLocalTerminalWithCurrentShellImpl(getCtx: AppContextGetter) {
  const { classifyLocalShellType, createLocalTerminal, discoveredShells, resolveShellSetting, terminalSettings } = getCtx();
{
    const resolved = resolveShellSetting(terminalSettings.localShell, discoveredShells, terminalSettings.localShellArgs);
    const matchedShell = discoveredShells.find(s => s.id === terminalSettings.localShell);
    return createLocalTerminal({
      shellType: classifyLocalShellType(resolved?.command || terminalSettings.localShell, navigator.userAgent),
      shell: resolved?.command,
      shellArgs: resolved?.args,
      shellName: matchedShell?.name,
      shellIcon: matchedShell?.icon,
    });
  }
}

export function splitSessionWithCurrentShellImpl(getCtx: AppContextGetter, sessionId: string, direction: 'horizontal' | 'vertical') {
  const { classifyLocalShellType, discoveredShells, resolveShellSetting, splitSession, terminalSettings } = getCtx();
{
    const resolved = resolveShellSetting(terminalSettings.localShell, discoveredShells);
    return splitSession(sessionId, direction, {
      localShellType: classifyLocalShellType(resolved?.command || terminalSettings.localShell, navigator.userAgent),
    });
  }
}

export function copySessionWithCurrentShellImpl(getCtx: AppContextGetter, sessionId: string) {
  const { classifyLocalShellType, copySession, discoveredShells, resolveShellSetting, terminalSettings } = getCtx();
{
    const resolved = resolveShellSetting(terminalSettings.localShell, discoveredShells);
    return copySession(sessionId, {
      localShellType: classifyLocalShellType(resolved?.command || terminalSettings.localShell, navigator.userAgent),
    });
  }
}

export async function copySessionToNewWindowWithCurrentShellImpl(getCtx: AppContextGetter, sessionId: string) {
  const { classifyLocalShellType, discoveredShells, netcattyBridge, resolveShellSetting, sessions, terminalSettings, t, toast } = getCtx();
{
    const sourceSession = sessions.find((session: { id: string }) => session.id === sessionId);
    if (!sourceSession) return false;

    const resolved = resolveShellSetting(terminalSettings.localShell, discoveredShells);
    const bridge = netcattyBridge.get();
    if (!bridge?.openSessionInNewWindow) {
      toast?.error?.(t?.('tabs.copyTabToNewWindowFailed') ?? 'Failed to open tab in a new window');
      return false;
    }

    const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    try {
      const result = await bridge.openSessionInNewWindow({
        title: sourceSession.hostLabel,
        sourceSession,
        localShellType: classifyLocalShellType(resolved?.command || terminalSettings.localShell, userAgent),
      });
      const success = result?.success === true;
      if (!success) toast?.error?.(t?.('tabs.copyTabToNewWindowFailed') ?? 'Failed to open tab in a new window');
      return success;
    } catch {
      toast?.error?.(t?.('tabs.copyTabToNewWindowFailed') ?? 'Failed to open tab in a new window');
      return false;
    }
  }
}

export async function confirmIfBusyLocalTerminalImpl(getCtx: AppContextGetter, sessionIds: string[]) {
  const { netcattyBridge, sessions, t } = getCtx();
{
      const bridge = netcattyBridge.get();
      const localIds = sessionIds.filter((id) => {
        const s = sessions.find((x) => x.id === id);
        return s?.protocol === 'local';
      });
      const busyCommands: string[] = [];
      for (const id of localIds) {
        const children = (await bridge?.ptyGetChildProcesses?.(id)) ?? [];
        if (children.length > 0) {
          busyCommands.push(children[0].command);
        }
      }
      if (busyCommands.length === 0) return true;

      const primary = busyCommands[0];
      const extraCount = busyCommands.length - 1;
      const message =
        extraCount > 0
          ? t('confirm.closeBusyTerminal.messageWithMore', {
              command: primary,
              count: extraCount,
            })
          : t('confirm.closeBusyTerminal.message', { command: primary });

      const ok = await bridge?.confirmCloseBusy?.({
        command: primary,
        title: t('confirm.closeBusyTerminal.title'),
        message,
        cancelLabel: t('confirm.closeBusyTerminal.cancel'),
        closeLabel: t('confirm.closeBusyTerminal.close'),
      });
      return ok === true;
    }
}

export async function closeTabsBatchImpl(getCtx: AppContextGetter, targetIds: string[]) {
  const { closeLogView, closeSessions, closeTabsInFlightRef, closeWorkspace, confirmIfBusyLocalTerminal, logViews, sessions, workspaces } = getCtx();
{
      if (targetIds.length === 0) return true;
      if (closeTabsInFlightRef.current) return false;

      // Expand workspace ids into their constituent session ids so the busy
      // probe sees every local shell that's about to be killed.
      const sessionIdsToProbe: string[] = [];
      for (const tabId of targetIds) {
        const ws = workspaces.find((w) => w.id === tabId);
        if (ws) {
          for (const s of sessions) {
            if (s.workspaceId === tabId) sessionIdsToProbe.push(s.id);
          }
        } else if (sessions.find((s) => s.id === tabId)) {
          sessionIdsToProbe.push(tabId);
        }
      }

      closeTabsInFlightRef.current = true;
      try {
        const ok = await confirmIfBusyLocalTerminal(sessionIdsToProbe);
        if (!ok) return false;
        const standaloneSessionIds = targetIds.filter((tabId) => (
          sessions.some((session) => session.id === tabId)
        ));
        if (standaloneSessionIds.length > 0) {
          closeSessions(standaloneSessionIds);
        }
        for (const tabId of targetIds) {
          if (workspaces.find((w) => w.id === tabId)) {
            closeWorkspace(tabId);
          } else if (logViews.find((lv) => lv.id === tabId)) {
            closeLogView(tabId);
          }
        }
        return true;
      } finally {
        closeTabsInFlightRef.current = false;
      }
    }
}

export function executeHotkeyActionImpl(getCtx: AppContextGetter, action: string, e: KeyboardEvent) {
  const { IS_DEV, MOVE_FOCUS_DEBOUNCE_MS, activeTabStore, addConnectionLogRef, closePluginViewTab, closeSession, closeTabInFlightRef, closeWorkspace, collectSessionIds, confirmIfBusyLocalTerminal, createLocalTerminalWithCurrentShell, editorTabs, fromEditorTabId, handleOpenSettingsRef, handleRequestCloseEditorTabRef, isEditorTabId, isPluginViewTabId, isQuickSwitcherOpen, lastMoveFocusTimeRef, moveFocusInWorkspace, orderedTabs, resolveCloseIntent, resolveSnippetsShortcutIntent, sessions, setActiveTabId, setAddToWorkspaceDialog, setIsQuickSwitcherOpen, setNavigateToSection, settings, splitSessionWithCurrentShell, systemInfoRef, toEditorTabId, toggleBroadcast, toggleScriptsSidePanelRef, toggleSidePanelRef, toggleWorkspaceViewMode, workspaces } = getCtx();
{
    const shortcutTabs = buildNumberShortcutTabTargets({
      showSftpTab: settings.showSftpTab ?? true,
      shellOnlyTabNumberShortcuts: settings.shellOnlyTabNumberShortcuts ?? false,
      orderedTabs,
      editorTabIds: editorTabs.map((t) => toEditorTabId(t.id)),
    });
    switch (action) {
      case 'switchToTab': {
        // Get the number key pressed (1-9)
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= 9) {
          if (num <= shortcutTabs.length) {
            setActiveTabId(shortcutTabs[num - 1]);
          }
        }
        break;
      }
      case 'nextTab': {
        const currentId = activeTabStore.getActiveTabId();
        const currentIdx = shortcutTabs.indexOf(currentId);
        if (currentIdx !== -1 && shortcutTabs.length > 0) {
          const nextIdx = (currentIdx + 1) % shortcutTabs.length;
          setActiveTabId(shortcutTabs[nextIdx]);
        } else if (shortcutTabs.length > 0) {
          setActiveTabId(shortcutTabs[0]);
        }
        break;
      }
      case 'prevTab': {
        const currentId = activeTabStore.getActiveTabId();
        const currentIdx = shortcutTabs.indexOf(currentId);
        if (currentIdx !== -1 && shortcutTabs.length > 0) {
          const prevIdx = (currentIdx - 1 + shortcutTabs.length) % shortcutTabs.length;
          setActiveTabId(shortcutTabs[prevIdx]);
        } else if (shortcutTabs.length > 0) {
          setActiveTabId(shortcutTabs[shortcutTabs.length - 1]);
        }
        break;
      }
      case 'closeTab': {
        const currentId = activeTabStore.getActiveTabId();
        if (!currentId || currentId === 'vault' || currentId === 'sftp') break;
        if (closeTabInFlightRef.current) break;

        if (isPluginViewTabId?.(currentId)) {
          closePluginViewTab?.(currentId);
          break;
        }

        // Editor tabs route through their own dirty-confirm close flow.
        if (isEditorTabId(currentId)) {
          const editorId = fromEditorTabId(currentId);
          if (editorId) handleRequestCloseEditorTabRef.current(editorId);
          break;
        }

        const session = sessions.find((s) => s.id === currentId) ?? null;
        const workspace = workspaces.find((w) => w.id === currentId) ?? null;

        const focusIsInsideTerminal = !!document.activeElement?.closest('[data-session-id]');

        const intent = resolveCloseIntent({
          activeTabId: currentId,
          workspace: workspace ? { id: workspace.id, focusedSessionId: workspace.focusedSessionId } : null,
          sessionForTab: session,
          focusIsInsideTerminal,
        });

        closeTabInFlightRef.current = true;
        (async () => {
          try {
            switch (intent.kind) {
              case 'closeTerminal':
              case 'closeSingleTab': {
                const ok = await confirmIfBusyLocalTerminal([intent.sessionId]);
                if (ok) closeSession(intent.sessionId);
                return;
              }
              case 'closeWorkspace': {
                const ids = sessions.filter((s) => s.workspaceId === intent.workspaceId).map((s) => s.id);
                const ok = await confirmIfBusyLocalTerminal(ids);
                if (ok) closeWorkspace(intent.workspaceId);
                return;
              }
              case 'noop':
              default:
                return;
            }
          } finally {
            closeTabInFlightRef.current = false;
          }
        })();

        break;
      }
      case 'closeSession': {
        const currentId = activeTabStore.getActiveTabId();
        if (!currentId || currentId === 'vault' || currentId === 'sftp') break;
        if (closeTabInFlightRef.current) break;

        const session = sessions.find((s) => s.id === currentId) ?? null;
        const workspace = workspaces.find((w) => w.id === currentId) ?? null;

        closeTabInFlightRef.current = true;
        (async () => {
          try {
            // If active tab is a workspace, close the focused session (pane)
            if (workspace) {
              // Validate focusedSessionId is still valid — it can become stale
              // if the previously focused session was already closed
              const aliveIds = collectSessionIds(workspace.root);
              const focusedId = aliveIds.includes(workspace.focusedSessionId)
                ? workspace.focusedSessionId
                : aliveIds[0];
              if (focusedId) {
                const ok = await confirmIfBusyLocalTerminal([focusedId]);
                if (ok) closeSession(focusedId);
              }
            } else if (session) {
              // Standalone session tab — close the session
              const ok = await confirmIfBusyLocalTerminal([session.id]);
              if (ok) closeSession(session.id);
            }
          } finally {
            closeTabInFlightRef.current = false;
          }
        })();
        break;
      }
      case 'newTab':
      case 'openLocal': {
        const sessionId = createLocalTerminalWithCurrentShell();
        addConnectionLogRef.current({
          sessionId,
          hostId: '',
          hostLabel: 'Local Terminal',
          hostname: 'localhost',
          username: systemInfoRef.current.username,
          protocol: 'local',
          startTime: Date.now(),
          localUsername: systemInfoRef.current.username,
          localHostname: systemInfoRef.current.hostname,
          saved: false,
        });
        break;
      }
      case 'openHosts':
        setActiveTabId('vault');
        break;
      case 'openSftp':
        if (settings.showSftpTab) {
          setActiveTabId('sftp');
        }
        break;
      case 'quickSwitch':
        setIsQuickSwitcherOpen(!isQuickSwitcherOpen);
        break;
      case 'commandPalette':
        setIsQuickSwitcherOpen(true);
        break;
      case 'newWorkspace':
        // Dedicated shortcut to launch the AddToWorkspaceDialog in
        // create mode — same entry as QuickSwitcher's "New Workspace"
        // button, but without having to open QS first.
        setAddToWorkspaceDialog({ mode: 'create' });
        break;
      case 'portForwarding':
        // Navigate to vault and open port forwarding section
        setActiveTabId('vault');
        setNavigateToSection('port');
        break;
      case 'snippets':
        {
          const currentId = activeTabStore.getActiveTabId();
          const intent = resolveSnippetsShortcutIntent({
            activeTabId: currentId,
            sessionForTab: sessions.find((s) => s.id === currentId) ?? null,
            workspaceForTab: workspaces.find((w) => w.id === currentId) ?? null,
            terminalScriptsToggleAvailable: !!toggleScriptsSidePanelRef.current,
          });

          if (intent.kind === 'toggleTerminalScripts') {
            toggleScriptsSidePanelRef.current();
            break;
          }

          setActiveTabId('vault');
          setNavigateToSection('snippets');
        }
        break;
      case 'toggleSidePanel':
        toggleSidePanelRef.current?.();
        break;
      case 'broadcast': {
        // Toggle broadcast mode for the active workspace
        const currentId = activeTabStore.getActiveTabId();
        const activeWs = workspaces.find(w => w.id === currentId);
        if (activeWs) {
          toggleBroadcast(activeWs.id);
        }
        break;
      }
      case 'openSettings':
        handleOpenSettingsRef.current();
        break;
      case 'splitHorizontal': {
        const currentId = activeTabStore.getActiveTabId();
        const activeSession = sessions.find(s => s.id === currentId);
        const activeWs = workspaces.find(w => w.id === currentId);
        if (activeSession && !activeSession.workspaceId) {
          splitSessionWithCurrentShell(activeSession.id, 'horizontal');
        } else if (activeWs) {
          const liveIds = collectSessionIds(activeWs.root);
          const targetId = (activeWs.focusedSessionId && liveIds.includes(activeWs.focusedSessionId))
            ? activeWs.focusedSessionId
            : liveIds[0];
          if (targetId) splitSessionWithCurrentShell(targetId, 'horizontal');
        }
        break;
      }
      case 'splitVertical': {
        const currentId = activeTabStore.getActiveTabId();
        const activeSession = sessions.find(s => s.id === currentId);
        const activeWs = workspaces.find(w => w.id === currentId);
        if (activeSession && !activeSession.workspaceId) {
          splitSessionWithCurrentShell(activeSession.id, 'vertical');
        } else if (activeWs) {
          const liveIds = collectSessionIds(activeWs.root);
          const targetId = (activeWs.focusedSessionId && liveIds.includes(activeWs.focusedSessionId))
            ? activeWs.focusedSessionId
            : liveIds[0];
          if (targetId) splitSessionWithCurrentShell(targetId, 'vertical');
        }
        break;
      }
      case 'togglePaneZoom': {
        // Toggle workspace between split and focus (zoom) mode
        const currentId = activeTabStore.getActiveTabId();
        const activeWs = workspaces.find(w => w.id === currentId);
        if (activeWs) {
          toggleWorkspaceViewMode(activeWs.id);
        }
        break;
      }
      case 'moveFocus': {
        // Debounce to prevent double-triggering when focus switches between terminals
        const now = Date.now();
        if (now - lastMoveFocusTimeRef.current < MOVE_FOCUS_DEBOUNCE_MS) {
          if (IS_DEV) console.log('[App] moveFocus debounced, ignoring');
          break;
        }
        lastMoveFocusTimeRef.current = now;

        // Move focus between split panes
        if (IS_DEV) console.log('[App] moveFocus action triggered, key:', e.key);
        const direction = e.key === 'ArrowUp' ? 'up'
          : e.key === 'ArrowDown' ? 'down'
            : e.key === 'ArrowLeft' ? 'left'
              : e.key === 'ArrowRight' ? 'right'
                : null;
        if (IS_DEV) console.log('[App] moveFocus direction:', direction);
        if (direction) {
          // Find the active workspace
          const currentId = activeTabStore.getActiveTabId();
          if (IS_DEV) console.log('[App] Active tab ID:', currentId);
          const activeWs = workspaces.find(w => w.id === currentId);
          if (IS_DEV) console.log('[App] Active workspace:', activeWs?.id, activeWs?.title);
          if (activeWs) {
            const result = moveFocusInWorkspace(activeWs.id, direction as 'up' | 'down' | 'left' | 'right');
            if (IS_DEV) console.log('[App] moveFocusInWorkspace result:', result);
          } else {
            if (IS_DEV) console.log('[App] No active workspace found');
          }
        }
        break;
      }
    }
  }
}

export function handleCreateLocalTerminalImpl(
  getCtx: AppContextGetter,
  shell?: { command: string; args?: string[]; name?: string; icon?: string },
  options?: { localStartDir?: string },
) {
  const { addConnectionLog, classifyLocalShellType, createLocalTerminal, discoveredShells, resolveShellSetting, systemInfoRef, terminalSettings } = getCtx();
{
    const { username, hostname } = systemInfoRef.current;
    const resolved = shell ?? resolveShellSetting(terminalSettings.localShell, discoveredShells, terminalSettings.localShellArgs);
    // Match by ID (not command) to avoid WSL distros all sharing wsl.exe
    const matchedShell = !shell ? discoveredShells.find(s => s.id === terminalSettings.localShell) : undefined;
    const shellName = shell?.name ?? matchedShell?.name;
    const shellIcon = shell?.icon ?? matchedShell?.icon;
    const sessionId = createLocalTerminal({
      shellType: classifyLocalShellType(resolved?.command || terminalSettings.localShell, navigator.userAgent),
      shell: resolved?.command,
      shellArgs: resolved?.args,
      shellName,
      shellIcon,
      localStartDir: options?.localStartDir,
    });
    addConnectionLog({
      sessionId,
      hostId: '',
      hostLabel: shellName || 'Local Terminal',
      hostname: 'localhost',
      username: username,
      protocol: 'local',
      startTime: Date.now(),
      localUsername: username,
      localHostname: hostname,
      saved: false,
    });
  }
}

export function handleConnectToHostImpl(getCtx: AppContextGetter, host: Host, hidden = false) {
  const { addConnectionLog, connectToHost, identities, keys, resolveEffectiveHost, resolveHostAuth, systemInfoRef } = getCtx();
{
    const { username, hostname: localHost } = systemInfoRef.current;

    const effectiveHost = resolveEffectiveHost(host);

    // Handle serial hosts separately
    if (effectiveHost.protocol === 'serial') {
      const portName = host.hostname.split('/').pop() || host.hostname;
      const sessionId = connectToHost(effectiveHost, { hidden });
      addConnectionLog({
        sessionId,
        hostId: host.id,
        hostLabel: host.label || `Serial: ${portName}`,
        hostname: host.hostname,
        username: username,
        protocol: 'serial',
        ...getLogHostVisualSnapshot(effectiveHost),
        startTime: Date.now(),
        localUsername: username,
        localHostname: localHost,
        saved: false,
      });
      return sessionId;
    }

    const protocol = resolveEffectiveTerminalProtocol(effectiveHost);
    const resolvedAuth = resolveHostAuth({ host: effectiveHost, keys, identities });
    const sessionId = connectToHost(effectiveHost, { hidden });
    addConnectionLog({
      sessionId,
      hostId: host.id,
      hostLabel: host.label,
      hostname: host.hostname,
      username: resolvedAuth.username || 'root',
      protocol,
      ...getLogHostVisualSnapshot(effectiveHost),
      startTime: Date.now(),
      localUsername: username,
      localHostname: localHost,
      saved: false,
    });
    return sessionId;
  }
}

export function handleTerminalDataCaptureImpl(getCtx: AppContextGetter, sessionId: string, data: string) {
  const { IS_DEV, connectionLogs, selectConnectionLogForTerminalDataCapture, sessions, updateConnectionLog } = getCtx();
{
    if (IS_DEV) console.log('[handleTerminalDataCapture] Called', { sessionId, dataLength: data.length });
    const session = sessions.find(s => s.id === sessionId);
    if (IS_DEV) console.log('[handleTerminalDataCapture] Session', session);
    if (IS_DEV) console.log('[handleTerminalDataCapture] All logs:', connectionLogs.map(l => ({ id: l.id, sessionId: l.sessionId, hostname: l.hostname, endTime: l.endTime, hasTerminalData: !!l.terminalData })));

    const matchingLog = selectConnectionLogForTerminalDataCapture(
      connectionLogs,
      { sessionId, hostname: session?.hostname },
    );

    if (IS_DEV) console.log('[handleTerminalDataCapture] Matching log', matchingLog);

    if (matchingLog) {
      updateConnectionLog(matchingLog.id, {
        endTime: Date.now(),
        terminalData: data,
      });
      if (IS_DEV) console.log('[handleTerminalDataCapture] Updated log with terminalData');

      // Auto-save is now handled by real-time streaming in the main process
      // via sessionLogStreamManager. No renderer-side fallback needed.
    } else {
      if (IS_DEV) console.log('[handleTerminalDataCapture] No matching log found!');
    }
  }
}

export function hasMultipleProtocolsImpl(getCtx: AppContextGetter, host: Host) {
  const { resolveEffectiveHost } = getCtx();
{
    // Gates the protocol picker (legacy name kept for its existing wiring).
    // Only prompt when Telnet is available but isn't the host's default protocol;
    // SSH-only, SSH+Mosh and Telnet-default all connect directly.
    const effective = resolveEffectiveHost(host);
    return Boolean(effective.telnetEnabled) && effective.protocol !== 'telnet';
  }
}

export function handleHostConnectWithProtocolCheckImpl(getCtx: AppContextGetter, host: Host) {
  const { handleConnectToHost, hasMultipleProtocols, resolveEffectiveHost, setIsQuickSwitcherOpen, setProtocolSelectHost, setQuickSearch } = getCtx();
{
    if (hasMultipleProtocols(host)) {
      setProtocolSelectHost(resolveEffectiveHost(host));
      setIsQuickSwitcherOpen(false);
      setQuickSearch('');
    } else {
      handleConnectToHost(host);
      setIsQuickSwitcherOpen(false);
      setQuickSearch('');
    }
  }
}

export function handleProtocolSelectImpl(getCtx: AppContextGetter, protocol: HostProtocol, port: number) {
  const { handleConnectToHost, protocolSelectHost, setProtocolSelectHost } = getCtx();
{
    if (protocolSelectHost) {
      const hostWithProtocol: Host = {
        ...protocolSelectHost,
        protocol: (protocol === 'mosh' || protocol === 'et') ? 'ssh' : protocol,
        port,
        moshEnabled: protocol === 'mosh',
        etEnabled: protocol === 'et',
      };
      handleConnectToHost(hostWithProtocol);
      setProtocolSelectHost(null);
    }
  }
}

export function handleToggleThemeImpl(getCtx: AppContextGetter) {
  const { openSettingsWindow, resolvedTheme, setTheme, t, theme, toast } = getCtx();
{
    if (theme === 'system') {
      toast.info(
        t('topTabs.toggleTheme.systemExitMessage'),
        {
          title: t('topTabs.toggleTheme.systemExitTitle'),
          actionLabel: t('topTabs.toggleTheme.openSettings'),
          onClick: () => {
            void (async () => {
              const opened = await openSettingsWindow();
              if (!opened) toast.error(t('toast.settingsUnavailable'), t('common.settings'));
            })();
          },
        }
      );
      return;
    }
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  }
}

export function handleRootContextMenuImpl(getCtx: AppContextGetter, e: React.MouseEvent<HTMLDivElement>) {
  void getCtx;
{
    const editableSelector =
      "input, textarea, [contenteditable], .monaco-editor, .monaco-diff-editor, .monaco-inputbox, .monaco-menu-container";

    const nativeEvent = e.nativeEvent;
    const path = typeof nativeEvent.composedPath === "function" ? nativeEvent.composedPath() : [];
    const allowFromPath = path.some(
      (node) => node instanceof Element && !!node.closest(editableSelector),
    );

    const target = e.target;
    const targetElement =
      target instanceof Element
        ? target
        : target instanceof Node
          ? target.parentElement
          : null;
    const allowFromTarget = !!targetElement?.closest(editableSelector);

    const allowNativeContextMenu = allowFromPath || allowFromTarget;

    if (allowNativeContextMenu) {
      return;
    }

    e.preventDefault();
  }
}
