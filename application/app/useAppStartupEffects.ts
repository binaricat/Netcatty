/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef } from 'react';
import { usePortForwardingAutoStart } from '../state/usePortForwardingAutoStart';
import { editorTabStore } from '../state/editorTabStore';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { toast } from '../../components/ui/toast';

type StartupEffectsContext = Record<string, any>;

export function useAppStartupEffects(ctx: StartupEffectsContext) {
  const {dismissUpdate, groupConfigs, hosts, identities,
    installUpdate, isVaultInitialized, keys, openSettingsWindow, portForwardingRules, proxyProfiles, sessions, setKeyboardInteractiveQueue,
    t, terminalSettings, updateState, workspaces,
  } = ctx;

  // Show toast notification when update is available (only when auto-download is idle)
  useEffect(() => {
    // Skip "update available" toast if auto-download has already started or completed
    if (updateState.autoDownloadStatus !== 'idle') return;
    // Don't show automatic notification when auto-update is disabled
    if (localStorageAdapter.readString('netcatty_auto_update_enabled_v1') === 'false') return;
    if (updateState.hasUpdate && updateState.latestRelease) {
      const version = updateState.latestRelease.version;
      toast.info(
        t('update.available.message', { version }),
        {
          title: t('update.available.title'),
          duration: 8000, // Show longer for update notifications
          onClick: () => {
            void openSettingsWindow();
            // Dismiss the update so the toast doesn't re-fire on every render.
            // On unsupported platforms (where autoDownloadStatus stays 'idle')
            // this is the only way to suppress the notification for this version.
            // On supported platforms this toast only shows before auto-download
            // starts, and the Settings window's own useUpdateCheck will pick up
            // the download state via IPC events independently of the dismiss.
            dismissUpdate();
          },
          actionLabel: t('update.viewInSettings'),
        }
      );
    }
  }, [updateState.hasUpdate, updateState.latestRelease, updateState.autoDownloadStatus, t, openSettingsWindow, dismissUpdate]);

  // Track previous autoDownloadStatus so toast effects fire only on actual transitions,
  // not when unrelated deps (installUpdate, openSettingsWindow) change their reference.
  const prevAutoDownloadStatusRef = useRef(updateState.autoDownloadStatus);
  useEffect(() => {
    const prev = prevAutoDownloadStatusRef.current;
    prevAutoDownloadStatusRef.current = updateState.autoDownloadStatus;
    if (prev === updateState.autoDownloadStatus) return;

    if (updateState.autoDownloadStatus === 'ready') {
      const version = updateState.latestRelease?.version ?? '';
      toast.info(
        t('update.readyToInstall.message', { version }),
        {
          title: t('update.readyToInstall.title'),
          duration: 0,
          actionLabel: t('update.restartNow'),
          onClick: () => installUpdate(),
        }
      );
    } else if (updateState.autoDownloadStatus === 'error') {
      toast.error(
        t('update.downloadFailed.message'),
        {
          title: t('update.downloadFailed.title'),
          actionLabel: t('update.viewInSettings'),
          onClick: () => void openSettingsWindow(),
        }
      );
    }
  }, [updateState.autoDownloadStatus, updateState.latestRelease?.version, t, installUpdate, openSettingsWindow]);

  // Auto-start port forwarding rules on app launch
  usePortForwardingAutoStart({
    isVaultInitialized,
    hosts,
    keys,
    identities,
    proxyProfiles,
    groupConfigs,
    terminalSettings,
  });

  // Sync tray menu data + handle tray actions
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.updateTrayMenuData) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;

      const sessionsForTray = sessions.map((s) => {
        const ws = s.workspaceId ? workspaces.find((w) => w.id === s.workspaceId) : undefined;
        return {
          id: s.id,
          label: s.hostname,
          hostLabel: s.hostLabel,
          status: s.status,
          workspaceId: s.workspaceId,
          workspaceTitle: ws?.title,
        };
      });

      void bridge.updateTrayMenuData({
        sessions: sessionsForTray,
        portForwardRules: portForwardingRules,
      });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessions, portForwardingRules, workspaces]);

  // Quit guard: block app exit while any editor tab has unsaved changes.
  // Main process sends "app:query-dirty-editors"; we respond with the result.
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onCheckDirtyEditors) return;
    const unsub = bridge.onCheckDirtyEditors(() => {
      // Always report SOMETHING so the main process doesn't time out for
      // 5 s on an unhandled exception. If we can't determine the state,
      // fail open — losing unsaved work is bad, but stranding the user
      // on a slow quit and then quitting anyway after the timeout is
      // exactly the same outcome.
      let hasDirty = false;
      try {
        hasDirty = editorTabStore.getTabs().some((tab) => tab.content !== tab.baselineContent);
        if (hasDirty) toast.warning(t('sftp.editor.quitBlockedByDirty'), 'SFTP');
      } catch (err) {
        console.error('[App] dirty-editors check failed:', err);
      }
      try {
        bridge.reportDirtyEditorsResult?.(hasDirty);
      } catch (err) {
        // Reporting itself shouldn't throw, but if the IPC bridge is in a
        // bad state we'd rather log than bubble out of the listener and
        // disable the quit guard for the rest of the session.
        console.error('[App] reportDirtyEditorsResult failed:', err);
      }
    });
    return unsub;
  }, [t]);

  // Keyboard-interactive authentication (2FA/MFA) event listener
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onKeyboardInteractive) return;

    const unsubscribe = bridge.onKeyboardInteractive((request) => {
      console.log('[App] Keyboard-interactive request received:', request);
      // Add to queue instead of replacing - supports multiple concurrent sessions
      setKeyboardInteractiveQueue(prev => [...prev, {
        requestId: request.requestId,
        sessionId: request.sessionId,
        name: request.name,
        instructions: request.instructions,
        prompts: request.prompts,
        hostname: request.hostname,
        savedPassword: request.savedPassword,
      }]);
    });

    return () => {
      unsubscribe?.();
    };
  }, [setKeyboardInteractiveQueue]);


}
