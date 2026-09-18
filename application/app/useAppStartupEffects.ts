/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef } from 'react';
import { usePortForwardingAutoStart } from '../state/usePortForwardingAutoStart';
import { editorTabStore } from '../state/editorTabStore';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { toast } from '../../components/ui/toast';
import { sftpTransferCenterStore } from '../state/sftpTransferCenterStore';
import { resumeTransferWithDedicatedSession } from '../state/sftp/dedicatedTransferResume';
import { getSftpTransferResourceKeys, globalSftpTransferScheduler } from '../state/sftp/globalTransferScheduler';
import { hasNewSourceFingerprint } from '../state/sftp/transferProgressMetadata';
import { STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY } from '../../infrastructure/config/storageKeys';
import type { TransferTask } from '../../domain/models';
import { isTerminalBootEpochCurrent } from '../../domain/terminalBootEpoch';
import {
  canApplyDedicatedResumeProgress,
  createDedicatedResumeChildUpdateBatcher,
  createDedicatedResumeProgressBatcher,
} from './dedicatedResumeProgress';

type StartupEffectsContext = Record<string, any>;

type KeyboardInteractiveScope = "terminal" | "external";
type KeyboardInteractiveRequestLike = {
  scope?: KeyboardInteractiveScope;
  sessionId?: string;
  hostId?: string;
  requestId?: string;
  bootEpoch?: number;
};
type SessionIdLike = { id: string; hostId?: string; hostname?: string; status?: string };
type KeyboardInteractiveQueueItem = { requestId: string };

export function shouldQueueKeyboardInteractiveRequest(
  request: KeyboardInteractiveRequestLike,
  sessions: SessionIdLike[],
): boolean {
  if (request.scope !== "terminal") return true;
  if (!request.sessionId) return false;
  const session = sessions.find((entry) => entry.id === request.sessionId);
  if (!session) return false;
  // Status-bar disconnect keeps the tab; do not queue MFA for aborted panes.
  if (session.status === "disconnected") return false;
  // After disconnect → reconnect the tab is connecting again; reject MFA from
  // a superseded SSH start that still shares this sessionId.
  if (!isTerminalBootEpochCurrent(request.sessionId, request.bootEpoch)) return false;
  return true;
}

export function removeKeyboardInteractiveRequest<T extends KeyboardInteractiveQueueItem>(
  queue: T[],
  requestId: string,
): T[] {
  return queue.filter(request => request.requestId !== requestId);
}

export function useAppStartupEffects(ctx: StartupEffectsContext) {
  const {dismissUpdate, enabled = true, groupConfigs, hosts, resumeHosts, identities,
    hasRuntimeTunnel, installUpdate, isVaultInitialized, keys, knownHosts, openSettingsWindow, portForwardingRules, proxyProfiles, sessions, setKeyboardInteractiveQueue,
    t, terminalSettings, updateState, workspaces,
  } = ctx;
  // Vault hosts for tray/menu; resumeHosts may include ephemeral quick-connect rows.
  const dedicatedResumeHosts = resumeHosts ?? hosts;
  const sessionsRef = useRef(sessions);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  // After app restart (or soft-resume miss), unfinished transfers reconnect via
  // a dedicated SFTP session. Prefer resumeHosts (vault + ephemeral) so
  // quick-connect transfers can re-auth without "Cannot find host in your vault".
  useEffect(() => {
    if (!enabled || !isVaultInitialized) {
      sftpTransferCenterStore.setDedicatedResumeHandler(null);
      return;
    }
    sftpTransferCenterStore.setDedicatedResumeHandler(async (task) => {
      // Keep reconnectRequired true until the first progress/completion so the
      // play control stays a spinner during auth + session setup.
      sftpTransferCenterStore.patchTask(task.id, {
        status: "pending",
        error: undefined,
        reconnectRequired: true,
        speed: 0,
        phase: undefined,
      });
      const children = sftpTransferCenterStore.getSnapshot().tasks.filter(
        (row) => row.parentTaskId === task.id,
      );
      // rAF-coalesce progress so dedicated resume does not flood the global center.
      type ProgressSample = {
        transferred: number;
        total: number;
        speed: number;
        checkpointBytes?: number;
        resumeStage?: TransferTask["resumeStage"];
        downloadCheckpointBytes?: number;
        uploadCheckpointBytes?: number;
        sourceFingerprint?: string;
      };
      // One rAF coalesce only — main process already time-throttles IPC.
      // A second 500ms timer here made dedicated-resume bars jump.
      const applyProgress = (progress: ProgressSample) => {
        const current = sftpTransferCenterStore.getSnapshot().tasks.find((row) => row.id === task.id);
        if (!current || current.status === "cancelled") return;
        if (current.status === "pausing" || current.status === "paused") {
          if (hasNewSourceFingerprint(current.sourceFingerprint, progress.sourceFingerprint)) {
            sftpTransferCenterStore.patchTask(task.id, { sourceFingerprint: progress.sourceFingerprint });
          }
          return;
        }
        // The final sample can still be queued in requestAnimationFrame after
        // the resume promise settles. Never let it turn a completed/failed row
        // back into a permanently "transferring" task.
        if (!canApplyDedicatedResumeProgress(current.status)) return;
        // Directory parents use file-count progress; single files use bytes.
        // Prefer durable contiguous checkpoint when the bridge supplies it.
        const durableCheckpoint = task.isDirectory
          ? progress.transferred
          : (progress.checkpointBytes ?? progress.transferred);
        // Keep progress monotonic so a late force-checkpoint paint cannot hide
        // later bytes, and the bar never freezes at the pre-quit offset.
        const nextTransferred = Math.max(current.transferredBytes ?? 0, progress.transferred);
        const nextCheckpoint = task.isDirectory
          ? Math.max(current.checkpointBytes ?? 0, progress.transferred)
          : Math.max(current.checkpointBytes ?? 0, durableCheckpoint);
        sftpTransferCenterStore.patchTask(task.id, {
          status: "transferring",
          transferredBytes: nextTransferred,
          ...(progress.total > 0 ? { totalBytes: progress.total } : {}),
          speed: progress.speed,
          ...(task.isDirectory
            ? { checkpointBytes: nextCheckpoint, progressMode: "files" as const }
            : {
                checkpointBytes: nextCheckpoint,
                resumeStage: progress.resumeStage,
                downloadCheckpointBytes: progress.downloadCheckpointBytes,
                uploadCheckpointBytes: progress.uploadCheckpointBytes,
                sourceFingerprint: progress.sourceFingerprint,
              }),
          reconnectRequired: false,
          error: undefined,
          phase: "transferring",
          ownerId: "dedicated-resume",
        });
      };
      const progressBatcher = createDedicatedResumeProgressBatcher<ProgressSample>({
        requestFrame: (callback) => window.requestAnimationFrame(callback),
        cancelFrame: (handle) => window.cancelAnimationFrame(handle),
        canApply: () => {
          const current = sftpTransferCenterStore.getSnapshot().tasks.find((row) => row.id === task.id);
          return !!current && canApplyDedicatedResumeProgress(current.status);
        },
        apply: applyProgress,
      });
      const childUpdateBatcher = createDedicatedResumeChildUpdateBatcher({
        // Use the restart snapshot, not repeated linear store lookups. Completed
        // rows disappear as batches compact, but later updates for those ids can
        // still stay in the same bounded batching path safely.
        getTaskCount: () => children.length + 1,
        hasTask: (() => {
          const retainedChildIds = new Set(children.map((child) => child.id));
          return (taskId: string) => retainedChildIds.has(taskId);
        })(),
        upsertTasks: (updates) => sftpTransferCenterStore.upsertTasks(updates),
      });
      let acceptsResumeCallbacks = true;
      try {
        return await resumeTransferWithDedicatedSession(
          task,
          {
            hosts: dedicatedResumeHosts,
            keys,
            identities,
            knownHosts,
            terminalSettings,
          },
          (progress) => {
            if (acceptsResumeCallbacks) progressBatcher.push(progress);
          },
          {
            children,
            onChildUpdate: (child, observation) => {
              if (acceptsResumeCallbacks) {
                childUpdateBatcher.push({ ...child, ownerId: "dedicated-resume" }, observation);
                return true;
              }
            },
            onChildSuperseded: (taskId) => childUpdateBatcher.discard(taskId),
            flushChildUpdates: () => childUpdateBatcher.flush(),
            onDirectoryCheckpointUpdate: (checkpoint) => {
              if (acceptsResumeCallbacks) {
                sftpTransferCenterStore.patchTask(task.id, {
                  directoryResumeCheckpoint: checkpoint,
                });
              }
            },
            shouldAbort: () => {
              const current = sftpTransferCenterStore.getSnapshot().tasks.find((row) => row.id === task.id);
              // interrupted is the pre-reconnect persisted state — do not abort a
              // live dedicated walk just because children/parent still show it.
              return !current
                || current.status === "cancelled"
                || current.status === "paused";
            },
          },
        );
      } finally {
        acceptsResumeCallbacks = false;
        progressBatcher.finish();
        childUpdateBatcher.flush();
      }
    });
    return () => sftpTransferCenterStore.setDedicatedResumeHandler(null);
  }, [dedicatedResumeHosts, enabled, identities, isVaultInitialized, keys, knownHosts, terminalSettings]);

  // Show toast notification when update is available (only when auto-download is idle)
  const toastedUpdateVersionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    // Skip "update available" toast if auto-download has already started or completed
    if (updateState.autoDownloadStatus !== 'idle') return;
    // Don't show automatic notification when auto-update is disabled
    if (localStorageAdapter.readString('netcatty_auto_update_enabled_v1') === 'false') return;
    if (updateState.hasUpdate && updateState.latestRelease) {
      const version = updateState.latestRelease.version;
      if (toastedUpdateVersionRef.current === version) return;
      toastedUpdateVersionRef.current = version;
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
  }, [enabled, updateState.hasUpdate, updateState.latestRelease, updateState.autoDownloadStatus, t, openSettingsWindow, dismissUpdate]);

  // Track previous autoDownloadStatus so toast effects fire only on actual transitions,
  // not when unrelated deps (installUpdate, openSettingsWindow) change their reference.
  const prevAutoDownloadStatusRef = useRef(updateState.autoDownloadStatus);
  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled, updateState.autoDownloadStatus, updateState.latestRelease?.version, t, installUpdate, openSettingsWindow]);

  // Auto-start port forwarding rules on app launch
  usePortForwardingAutoStart({
    enabled,
    isVaultInitialized,
    hosts,
    keys,
    identities,
    knownHosts,
    proxyProfiles,
    groupConfigs,
    terminalSettings,
  });

  // Sync tray menu data + handle tray actions
  useEffect(() => {
    if (!enabled) return;
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
          aiHidden: s.hiddenFromTabs === true,
        };
      });

      const hostsForSystemMenu = hosts
        .filter((host: any) => typeof host?.id === "string" && host.id.length > 0)
        .map((host: any) => ({
          id: host.id,
          label: host.label,
          hostname: host.hostname,
          group: host.group,
          pinned: host.pinned,
          lastConnectedAt: host.lastConnectedAt,
          protocol: host.protocol,
        }));

      void bridge.updateTrayMenuData({
        sessions: sessionsForTray,
        portForwardRules: portForwardingRules.map((rule: any) => ({
          ...rule,
          canStop: hasRuntimeTunnel(rule.id),
        })),
        hosts: hostsForSystemMenu,
      });
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, hasRuntimeTunnel, hosts, sessions, portForwardingRules, workspaces]);

  // Quit guard: block app exit while any editor tab has unsaved changes.
  // Main process sends "app:query-dirty-editors"; we respond with the result.
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onCheckDirtyEditors) return;
    const unsub = bridge.onCheckDirtyEditors(async () => {
      // Always report SOMETHING so the main process doesn't time out for
      // 5 s on an unhandled exception. If we can't determine the state,
      // fail open — losing unsaved work is bad, but stranding the user
      // on a slow quit and then quitting anyway after the timeout is
      // exactly the same outcome.
      let hasDirty = false;
      try {
        hasDirty = editorTabStore.getTabs().some((tab) => tab.content !== tab.baselineContent);
        if (hasDirty) toast.warning(t('sftp.editor.quitBlockedByDirty'), 'SFTP');
        if (!hasDirty) {
          const unfinishedTasks = sftpTransferCenterStore.getSnapshot().tasks.filter((task) => (
            !task.parentTaskId && !["completed", "failed", "cancelled"].includes(task.status)
          ));
          if (unfinishedTasks.length > 0) {
            await Promise.allSettled(unfinishedTasks.map((task) => sftpTransferCenterStore.pause(task.id)));
            hasDirty = !window.confirm(t('sftp.transferCenter.quitConfirm', { count: unfinishedTasks.length }));
          }
        }
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
  }, [enabled, t]);

  useEffect(() => {
    const bridge = netcattyBridge.get();
    const unsubscribeEvents = bridge?.onGlobalSftpTransferEvent?.((event) => {
      sftpTransferCenterStore.ingestBackgroundEvent(event);
    });
    const restartBackgroundTransfer = async (taskId: string, fromBeginning: boolean) => {
      const task = sftpTransferCenterStore.getSnapshot().tasks.find((candidate) => candidate.id === taskId);
      if (!task || !bridge?.openSftpForSession || !bridge.startStreamTransfer) return;
      const sessionId = task.direction === "upload" ? task.targetConnectionId : task.sourceConnectionId;
      if (!sessionId || sessionId === "agent" || sessionId === "local") {
        sftpTransferCenterStore.ingestBackgroundEvent({
          type: "failed",
          transferId: taskId,
          error: "The original server session is unavailable",
          endedAt: Date.now(),
        });
        return;
      }
      let sftpId: string | undefined;
      try {
        const checkpointBytes = fromBeginning ? 0 : (task.checkpointBytes ?? task.transferredBytes ?? 0);
        sftpTransferCenterStore.ingestBackgroundEvent({ type: "queued", transferId: taskId });
        // Admit first so agent resume does not pin session-backed SFTP handles
        // while waiting for main-process concurrency.
        const result = await globalSftpTransferScheduler.run(
          "background-agent",
          task.id,
          getSftpTransferResourceKeys({
            sourceHostId: task.sourceHostId,
            targetHostId: task.targetHostId,
          }),
          () => localStorageAdapter.readNumber(STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY),
          async () => {
            sftpId = await bridge.openSftpForSession!(sessionId);
            return bridge.startStreamTransfer!({
              transferId: task.id,
              sourcePath: task.sourcePath,
              targetPath: task.targetPath,
              sourceType: task.direction === "upload" ? "local" : "sftp",
              targetType: task.direction === "download" ? "local" : "sftp",
              sourceSftpId: task.direction === "download" ? sftpId : undefined,
              targetSftpId: task.direction === "upload" ? sftpId : undefined,
              // Keep host-scoped path gates across session reopen (Codex P1).
              sourceHostId: task.sourceHostId,
              targetHostId: task.targetHostId,
              totalBytes: task.totalBytes,
              resumable: task.resumable !== false,
              checkpointBytes,
              resumeStage: fromBeginning ? undefined : task.resumeStage,
              downloadCheckpointBytes: fromBeginning ? 0 : task.downloadCheckpointBytes,
              uploadCheckpointBytes: fromBeginning ? 0 : task.uploadCheckpointBytes,
              sourceFingerprint: fromBeginning ? undefined : task.sourceFingerprint,
              skipAdmission: true,
            });
          },
        );
        // Same-id retry stole ownership; wait for the live owner's terminal
        // status instead of treating this invoke as completed (Codex P2).
        if (result?.superseded === true) {
          // Wait for live owner terminal status only (no fixed deadline).
          for (;;) {
            const latest = sftpTransferCenterStore.getSnapshot().tasks.find((candidate) => candidate.id === task.id);
            const status = latest?.status;
            if (status === "completed" || status === "cancelled" || status === "failed") {
              if (status === "failed") {
                throw new Error(latest?.error || "Transfer failed");
              }
              if (status === "cancelled") {
                sftpTransferCenterStore.ingestBackgroundEvent({
                  type: "cancelled",
                  transferId: task.id,
                  endedAt: Date.now(),
                });
              }
              // completed: events already applied; cancelled handled above.
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        } else if (result?.cancelled || result?.error === "Transfer cancelled") {
          sftpTransferCenterStore.ingestBackgroundEvent({ type: "cancelled", transferId: task.id, endedAt: Date.now() });
        } else if (result?.error) {
          throw new Error(result.error);
        } else {
          sftpTransferCenterStore.ingestBackgroundEvent({ type: "completed", transferId: task.id, endedAt: Date.now() });
        }
      } catch (error) {
        sftpTransferCenterStore.ingestBackgroundEvent({
          type: "failed",
          transferId: task.id,
          error: error instanceof Error ? error.message : String(error),
          endedAt: Date.now(),
        });
      } finally {
        if (sftpId) await bridge.closeSftp?.(sftpId).catch(() => {});
      }
    };
    const unregisterOwner = sftpTransferCenterStore.registerOwner("background-agent", {
      pause: async (taskId) => {
        const result = await bridge?.pauseTransfer?.(taskId);
        if (result?.success) sftpTransferCenterStore.ingestBackgroundEvent({
          type: "paused",
          transferId: taskId,
          checkpointBytes: result.checkpointBytes,
          resumeStage: result.resumeStage,
          downloadCheckpointBytes: result.downloadCheckpointBytes,
          uploadCheckpointBytes: result.uploadCheckpointBytes,
          sourceFingerprint: result.sourceFingerprint,
        });
      },
      resume: async (taskId) => {
        const result = await bridge?.resumeTransfer?.(taskId);
        if (result?.success) {
          sftpTransferCenterStore.ingestBackgroundEvent({ type: "resumed", transferId: taskId });
        } else {
          sftpTransferCenterStore.markReconnectRequired(
            taskId,
            result?.reason ?? "The original server connection is unavailable",
          );
          setTimeout(() => { void sftpTransferCenterStore.resume(taskId); }, 0);
        }
      },
      cancel: async (taskId) => {
        await bridge?.cancelTransfer?.(taskId);
        sftpTransferCenterStore.ingestBackgroundEvent({ type: "cancelled", transferId: taskId, endedAt: Date.now() });
      },
      retry: async (taskId) => { await restartBackgroundTransfer(taskId, true); },
      prioritize: async (taskId) => { await bridge?.prioritizeTransfer?.(taskId); },
      dismiss: (taskId, prunedTask) => {
        const task = prunedTask
          ?? sftpTransferCenterStore.getSnapshot().tasks.find((candidate) => candidate.id === taskId);
        if (!task) return;
        void bridge?.cleanupTransferArtifacts?.({
          transferId: task.id,
          sourcePath: task.sourcePath,
          targetPath: task.targetPath,
          stagedTargetPath: task.stagedTargetPath,
        });
      },
    });
    return () => {
      unsubscribeEvents?.();
      unregisterOwner();
    };
  }, [enabled]);

  // Keyboard-interactive authentication (2FA/MFA) event listener
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onKeyboardInteractive) return;

    const unsubscribe = bridge.onKeyboardInteractive((request) => {
      if (!shouldQueueKeyboardInteractiveRequest(request, sessionsRef.current)) {
        if (request.scope === "terminal" && request.requestId) {
          void bridge.respondKeyboardInteractive?.(request.requestId, [], true);
        }
        return;
      }
      console.log('[App] Keyboard-interactive request received:', request);
      // Add to queue instead of replacing - supports multiple concurrent sessions
      setKeyboardInteractiveQueue(prev => [...prev, {
        requestId: request.requestId,
        sessionId: request.sessionId,
        hostId: request.hostId,
        name: request.name,
        instructions: request.instructions,
        prompts: request.prompts,
        hostname: request.hostname,
        savedPassword: request.savedPassword,
        allowSavePassword: request.allowSavePassword !== false,
      }]);
    });
    const unsubscribeCancelled = bridge.onKeyboardInteractiveCancelled?.((event) => {
      setKeyboardInteractiveQueue(prev => removeKeyboardInteractiveRequest(prev, event.requestId));
    });
    const onTerminalDisconnected = (event: Event) => {
      const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (!sessionId) return;
      setKeyboardInteractiveQueue((prev) => {
        const doomed = prev.filter((request) => request.sessionId === sessionId);
        for (const request of doomed) {
          void bridge.respondKeyboardInteractive?.(request.requestId, [], true);
        }
        return prev.filter((request) => request.sessionId !== sessionId);
      });
    };
    window.addEventListener("netcatty:terminal-session-disconnected", onTerminalDisconnected);

    return () => {
      unsubscribe?.();
      unsubscribeCancelled?.();
      window.removeEventListener("netcatty:terminal-session-disconnected", onTerminalDisconnected);
    };
  }, [enabled, setKeyboardInteractiveQueue]);


}
