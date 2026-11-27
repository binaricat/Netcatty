import type { RemoteDesktopAction } from '../../domain/remoteDesktopActionCodec';
import { isRemoteDesktopAiReadBlocked } from './remoteDesktopSnapshotRegistry';

export type RemoteDesktopControlErrorCode =
  | 'AI_READ_BLOCKED'
  | 'SESSION_VIEW_ONLY'
  | 'SESSION_DISCONNECTED'
  | 'UNAVAILABLE'
  | 'USER_PREEMPTED'
  | 'ABORTED'
  | 'INVALID_ACTIONS'
  | 'ACTION_FAILED';

export interface RemoteDesktopControllerState {
  connected: boolean;
  viewOnly: boolean;
  protocol: 'vnc' | 'rdp';
  hostLabel?: string;
  hostname?: string;
  desktopWidth: number;
  desktopHeight: number;
}

export interface RemoteDesktopPerformActionOptions {
  signal?: AbortSignal;
}

export interface RemoteDesktopController {
  performAction: (
    action: RemoteDesktopAction,
    options?: RemoteDesktopPerformActionOptions,
  ) => Promise<void> | void;
  releaseAllInputs: () => void;
  getState: () => RemoteDesktopControllerState;
}

export interface RemoteDesktopAiControlState {
  sessionId: string;
  aiControlling: boolean;
  chatSessionId?: string;
  startedAt?: number;
  currentActionIndex?: number;
  totalActions?: number;
  currentAction?: RemoteDesktopAction;
}

export interface RemoteDesktopActionEvent {
  id: string;
  sessionId: string;
  action: RemoteDesktopAction;
  index: number;
  total: number;
  phase: 'start' | 'end' | 'preempted';
  timestamp: number;
}

export interface ExecuteRemoteDesktopActionsOptions {
  abortSignal?: AbortSignal;
  chatSessionId?: string;
  /** Inter-action pacing delay in ms (default 20; pass 0 for fast tests). */
  interActionDelayMs?: number;
}

export type ExecuteRemoteDesktopActionsResult =
  | {
      ok: true;
      sessionId: string;
      protocol: 'vnc' | 'rdp';
      hostLabel?: string;
      hostname?: string;
      completedActions: number;
      totalActions: number;
      durationMs: number;
    }
  | {
      ok: false;
      code: RemoteDesktopControlErrorCode;
      error: string;
      sessionId: string;
      protocol?: 'vnc' | 'rdp';
      hostLabel?: string;
      hostname?: string;
      completedActions: number;
      totalActions: number;
      durationMs: number;
      preemptReason?: string;
    };

interface ActiveControlRun {
  preempted: boolean;
  preemptReason?: string;
  chatSessionId?: string;
  startedAt: number;
  totalActions: number;
  currentActionIndex?: number;
  currentAction?: RemoteDesktopAction;
  abortController: AbortController;
  wakePendingSleep?: () => void;
}

const DEFAULT_INTER_ACTION_DELAY_MS = 20;

const controllers = new Map<string, RemoteDesktopController>();
const activeRuns = new Map<string, ActiveControlRun>();
const controlStateListeners = new Map<string, Set<(state: RemoteDesktopAiControlState) => void>>();
const actionEventListeners = new Map<string, Set<(event: RemoteDesktopActionEvent) => void>>();

let actionEventSeq = 0;

function nextActionEventId(): string {
  actionEventSeq += 1;
  return `rdact-${Date.now().toString(36)}-${actionEventSeq}`;
}

function buildAiControlState(sessionId: string): RemoteDesktopAiControlState {
  const run = activeRuns.get(sessionId);
  if (!run) {
    return {
      sessionId,
      aiControlling: false,
    };
  }
  return {
    sessionId,
    aiControlling: true,
    chatSessionId: run.chatSessionId,
    startedAt: run.startedAt,
    currentActionIndex: run.currentActionIndex,
    totalActions: run.totalActions,
    currentAction: run.currentAction,
  };
}

function emitControlState(sessionId: string): void {
  const listeners = controlStateListeners.get(sessionId);
  if (!listeners || listeners.size === 0) return;
  const snapshot = buildAiControlState(sessionId);
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // UI listener errors must never break AI control cleanup.
    }
  }
}

function emitActionEvent(event: RemoteDesktopActionEvent): void {
  const listeners = actionEventListeners.get(event.sessionId);
  if (!listeners || listeners.size === 0) return;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Ignore UI subscriber errors.
    }
  }
}

function safeReleaseAllInputs(controller: RemoteDesktopController | undefined): void {
  if (!controller) return;
  try {
    controller.releaseAllInputs();
  } catch {
    // Best-effort input release; never throw during abort/preempt cleanup.
  }
}

function interruptibleSleep(
  ms: number,
  run: ActiveControlRun,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (ms <= 0 || run.preempted || abortSignal?.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', finish);
      if (run.wakePendingSleep === finish) {
        run.wakePendingSleep = undefined;
      }
      resolve();
    };
    const timer = setTimeout(finish, ms);
    run.wakePendingSleep = finish;
    abortSignal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Register a VNC/RDP canvas input controller for a live session.
 * Returns an unsubscribe function that cleans up only if this controller is still active.
 */
export function registerRemoteDesktopController(
  sessionId: string,
  controller: RemoteDesktopController,
): () => void {
  controllers.set(sessionId, controller);
  return () => {
    if (controllers.get(sessionId) === controller) {
      controllers.delete(sessionId);
    }
  };
}

export function hasRemoteDesktopController(sessionId: string): boolean {
  return controllers.has(sessionId);
}

export function getRemoteDesktopControllerState(sessionId: string): RemoteDesktopControllerState | null {
  const controller = controllers.get(sessionId);
  if (!controller) return null;
  try {
    return controller.getState();
  } catch {
    return null;
  }
}

export function getRemoteDesktopAiControlState(sessionId: string): RemoteDesktopAiControlState {
  return buildAiControlState(sessionId);
}

export function isRemoteDesktopAiControlling(sessionId: string): boolean {
  return activeRuns.has(sessionId);
}

export function subscribeRemoteDesktopAiControlState(
  sessionId: string,
  listener: (state: RemoteDesktopAiControlState) => void,
): () => void {
  let set = controlStateListeners.get(sessionId);
  if (!set) {
    set = new Set();
    controlStateListeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    const current = controlStateListeners.get(sessionId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) controlStateListeners.delete(sessionId);
  };
}

export function subscribeRemoteDesktopActionEvents(
  sessionId: string,
  listener: (event: RemoteDesktopActionEvent) => void,
): () => void {
  let set = actionEventListeners.get(sessionId);
  if (!set) {
    set = new Set();
    actionEventListeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    const current = actionEventListeners.get(sessionId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) actionEventListeners.delete(sessionId);
  };
}

/**
 * Called by `RemoteDesktopPane` / `RemoteDesktopAiOverlay` when the human user
 * clicks, moves, presses a key, or hits Stop while AI is controlling the session.
 * Immediately releases all held inputs and flags the active action sequence to stop.
 */
export function preemptRemoteDesktopControl(sessionId: string, reason?: string): boolean {
  const controller = controllers.get(sessionId);
  const run = activeRuns.get(sessionId);
  if (!run) {
    return false;
  }
  run.preempted = true;
  if (reason && !run.preemptReason) {
    run.preemptReason = reason;
  }
  try {
    run.abortController.abort(reason || 'preempted');
  } catch {
    // ignore
  }
  safeReleaseAllInputs(controller);
  run.wakePendingSleep?.();
  return true;
}

/**
 * Execute a validated sequence of AI Computer Use actions against a registered
 * VNC or RDP session controller, enforcing privacy lock, view-only lock,
 * connection state, abort signal, and physical user preemption between every action.
 */
export async function executeRemoteDesktopActions(
  sessionId: string,
  actions: readonly RemoteDesktopAction[],
  options?: ExecuteRemoteDesktopActionsOptions,
): Promise<ExecuteRemoteDesktopActionsResult> {
  const startedAt = Date.now();
  const totalActions = actions.length;

  if (isRemoteDesktopAiReadBlocked(sessionId)) {
    return {
      ok: false,
      code: 'AI_READ_BLOCKED',
      error: 'AI control is blocked for this remote desktop session by the privacy lock.',
      sessionId,
      completedActions: 0,
      totalActions,
      durationMs: Date.now() - startedAt,
    };
  }

  const controller = controllers.get(sessionId);
  if (!controller) {
    return {
      ok: false,
      code: 'UNAVAILABLE',
      error: 'Remote desktop input controller is unavailable for this session. Ensure the desktop tab is connected and active.',
      sessionId,
      completedActions: 0,
      totalActions,
      durationMs: Date.now() - startedAt,
    };
  }

  const state = controller.getState();
  if (!state.connected) {
    return {
      ok: false,
      code: 'SESSION_DISCONNECTED',
      error: 'Remote desktop session is disconnected. Ask the user to reconnect it first.',
      sessionId,
      protocol: state.protocol,
      hostLabel: state.hostLabel,
      hostname: state.hostname,
      completedActions: 0,
      totalActions,
      durationMs: Date.now() - startedAt,
    };
  }

  if (state.viewOnly) {
    return {
      ok: false,
      code: 'SESSION_VIEW_ONLY',
      error: 'Remote desktop session is in view-only mode. Ask the user to disable view-only mode before controlling the desktop.',
      sessionId,
      protocol: state.protocol,
      hostLabel: state.hostLabel,
      hostname: state.hostname,
      completedActions: 0,
      totalActions,
      durationMs: Date.now() - startedAt,
    };
  }

  if (totalActions === 0) {
    return {
      ok: false,
      code: 'INVALID_ACTIONS',
      error: 'At least one remote desktop action is required.',
      sessionId,
      protocol: state.protocol,
      hostLabel: state.hostLabel,
      hostname: state.hostname,
      completedActions: 0,
      totalActions: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const abortSignal = options?.abortSignal;
  const interActionDelayMs = typeof options?.interActionDelayMs === 'number'
    && Number.isFinite(options.interActionDelayMs)
    ? Math.max(0, options.interActionDelayMs)
    : DEFAULT_INTER_ACTION_DELAY_MS;

  // Preempt any overlapping active run for this session before starting a new one.
  if (activeRuns.has(sessionId)) {
    preemptRemoteDesktopControl(sessionId, 'superseded');
  }

  const runAbortController = new AbortController();
  const run: ActiveControlRun = {
    preempted: false,
    chatSessionId: options?.chatSessionId,
    startedAt,
    totalActions,
    abortController: runAbortController,
  };
  activeRuns.set(sessionId, run);
  emitControlState(sessionId);

  const onAbort = () => {
    try {
      runAbortController.abort('aborted');
    } catch {
      // ignore
    }
    safeReleaseAllInputs(controller);
    run.wakePendingSleep?.();
  };
  abortSignal?.addEventListener('abort', onAbort, { once: true });

  let completedActions = 0;

  try {
    for (let i = 0; i < actions.length; i += 1) {
      const action = actions[i];

      if (isRemoteDesktopAiReadBlocked(sessionId)) {
        safeReleaseAllInputs(controller);
        return {
          ok: false,
          code: 'AI_READ_BLOCKED',
          error: 'AI control was stopped because the session privacy lock was enabled.',
          sessionId,
          protocol: state.protocol,
          hostLabel: state.hostLabel,
          hostname: state.hostname,
          completedActions,
          totalActions,
          durationMs: Date.now() - startedAt,
        };
      }

      if (run.preempted) {
        safeReleaseAllInputs(controller);
        emitActionEvent({
          id: nextActionEventId(),
          sessionId,
          action,
          index: i,
          total: totalActions,
          phase: 'preempted',
          timestamp: Date.now(),
        });
        return {
          ok: false,
          code: 'USER_PREEMPTED',
          error: 'User took control of the remote desktop; AI action sequence paused.',
          sessionId,
          protocol: state.protocol,
          hostLabel: state.hostLabel,
          hostname: state.hostname,
          completedActions,
          totalActions,
          durationMs: Date.now() - startedAt,
          ...(run.preemptReason ? { preemptReason: run.preemptReason } : {}),
        };
      }

      if (abortSignal?.aborted) {
        safeReleaseAllInputs(controller);
        return {
          ok: false,
          code: 'ABORTED',
          error: 'AI remote desktop action sequence was aborted.',
          sessionId,
          protocol: state.protocol,
          hostLabel: state.hostLabel,
          hostname: state.hostname,
          completedActions,
          totalActions,
          durationMs: Date.now() - startedAt,
        };
      }

      const liveState = controller.getState();
      if (!liveState.connected) {
        safeReleaseAllInputs(controller);
        return {
          ok: false,
          code: 'SESSION_DISCONNECTED',
          error: 'Remote desktop session disconnected during AI control.',
          sessionId,
          protocol: liveState.protocol,
          hostLabel: liveState.hostLabel,
          hostname: liveState.hostname,
          completedActions,
          totalActions,
          durationMs: Date.now() - startedAt,
        };
      }
      if (liveState.viewOnly) {
        safeReleaseAllInputs(controller);
        return {
          ok: false,
          code: 'SESSION_VIEW_ONLY',
          error: 'Remote desktop session switched to view-only mode during AI control.',
          sessionId,
          protocol: liveState.protocol,
          hostLabel: liveState.hostLabel,
          hostname: liveState.hostname,
          completedActions,
          totalActions,
          durationMs: Date.now() - startedAt,
        };
      }

      run.currentActionIndex = i;
      run.currentAction = action;
      emitControlState(sessionId);

      emitActionEvent({
        id: nextActionEventId(),
        sessionId,
        action,
        index: i,
        total: totalActions,
        phase: 'start',
        timestamp: Date.now(),
      });

      if (action.type === 'wait') {
        await interruptibleSleep(action.ms, run, abortSignal);
        if (run.preempted) {
          safeReleaseAllInputs(controller);
          emitActionEvent({
            id: nextActionEventId(),
            sessionId,
            action,
            index: i,
            total: totalActions,
            phase: 'preempted',
            timestamp: Date.now(),
          });
          return {
            ok: false,
            code: 'USER_PREEMPTED',
            error: 'User took control of the remote desktop; AI action sequence paused.',
            sessionId,
            protocol: state.protocol,
            hostLabel: state.hostLabel,
            hostname: state.hostname,
            completedActions,
            totalActions,
            durationMs: Date.now() - startedAt,
            ...(run.preemptReason ? { preemptReason: run.preemptReason } : {}),
          };
        }
        if (abortSignal?.aborted) {
          safeReleaseAllInputs(controller);
          return {
            ok: false,
            code: 'ABORTED',
            error: 'AI remote desktop action sequence was aborted.',
            sessionId,
            protocol: state.protocol,
            hostLabel: state.hostLabel,
            hostname: state.hostname,
            completedActions,
            totalActions,
            durationMs: Date.now() - startedAt,
          };
        }
      } else {
        try {
          await controller.performAction(action, { signal: runAbortController.signal });
        } catch (err) {
          safeReleaseAllInputs(controller);
          if (run.preempted) {
            emitActionEvent({
              id: nextActionEventId(),
              sessionId,
              action,
              index: i,
              total: totalActions,
              phase: 'preempted',
              timestamp: Date.now(),
            });
            return {
              ok: false,
              code: 'USER_PREEMPTED',
              error: 'User took control of the remote desktop; AI action sequence paused.',
              sessionId,
              protocol: state.protocol,
              hostLabel: state.hostLabel,
              hostname: state.hostname,
              completedActions,
              totalActions,
              durationMs: Date.now() - startedAt,
              ...(run.preemptReason ? { preemptReason: run.preemptReason } : {}),
            };
          }
          if (abortSignal?.aborted) {
            return {
              ok: false,
              code: 'ABORTED',
              error: 'AI remote desktop action sequence was aborted.',
              sessionId,
              protocol: state.protocol,
              hostLabel: state.hostLabel,
              hostname: state.hostname,
              completedActions,
              totalActions,
              durationMs: Date.now() - startedAt,
            };
          }
          return {
            ok: false,
            code: 'ACTION_FAILED',
            error: err instanceof Error ? err.message : 'Failed to execute remote desktop action.',
            sessionId,
            protocol: state.protocol,
            hostLabel: state.hostLabel,
            hostname: state.hostname,
            completedActions,
            totalActions,
            durationMs: Date.now() - startedAt,
          };
        }

        if (run.preempted) {
          safeReleaseAllInputs(controller);
          emitActionEvent({
            id: nextActionEventId(),
            sessionId,
            action,
            index: i,
            total: totalActions,
            phase: 'preempted',
            timestamp: Date.now(),
          });
          return {
            ok: false,
            code: 'USER_PREEMPTED',
            error: 'User took control of the remote desktop; AI action sequence paused.',
            sessionId,
            protocol: state.protocol,
            hostLabel: state.hostLabel,
            hostname: state.hostname,
            completedActions,
            totalActions,
            durationMs: Date.now() - startedAt,
            ...(run.preemptReason ? { preemptReason: run.preemptReason } : {}),
          };
        }
        if (abortSignal?.aborted) {
          safeReleaseAllInputs(controller);
          return {
            ok: false,
            code: 'ABORTED',
            error: 'AI remote desktop action sequence was aborted.',
            sessionId,
            protocol: state.protocol,
            hostLabel: state.hostLabel,
            hostname: state.hostname,
            completedActions,
            totalActions,
            durationMs: Date.now() - startedAt,
          };
        }
      }

      completedActions += 1;

      emitActionEvent({
        id: nextActionEventId(),
        sessionId,
        action,
        index: i,
        total: totalActions,
        phase: 'end',
        timestamp: Date.now(),
      });

      if (i < actions.length - 1 && interActionDelayMs > 0) {
        await interruptibleSleep(interActionDelayMs, run, abortSignal);
      }
    }

    return {
      ok: true,
      sessionId,
      protocol: state.protocol,
      hostLabel: state.hostLabel,
      hostname: state.hostname,
      completedActions,
      totalActions,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    if (activeRuns.get(sessionId) === run) {
      activeRuns.delete(sessionId);
    }
    emitControlState(sessionId);
  }
}

export function resetRemoteDesktopControlRegistryForTests(): void {
  controllers.clear();
  activeRuns.clear();
  controlStateListeners.clear();
  actionEventListeners.clear();
}
