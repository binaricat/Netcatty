import { useCallback, useEffect, useMemo, useRef } from 'react';

import { getWindowPluginTerminalProviderRegistry } from './pluginTerminalProviderRegistry';

interface PluginTerminalSessionLifecycleOptions {
  sessionId: string;
  hostId?: string;
  workspaceId?: string;
  protocol?: string;
  status: 'connecting' | 'connected' | 'disconnected';
  shellType?: string;
  initialCwd?: string;
  ownsBackendLifecycle?: boolean;
}

export interface PluginTerminalSnapshotState {
  cwd?: string;
  title?: string;
  cols?: number;
  rows?: number;
  alternateScreen?: boolean;
}

type PluginTerminalStatusTransition = Readonly<{
  snapshotState: PluginTerminalSnapshotState;
  everConnected: boolean;
  eventType?: 'connected' | 'reconnected' | 'disconnected';
  eventDetails?: Readonly<{ exitCode: number }>;
}>;

export function transitionPluginTerminalConnectionState(
  snapshotState: PluginTerminalSnapshotState,
  status: PluginTerminalSessionLifecycleOptions['status'],
  everConnected: boolean,
  exitCode?: number,
): PluginTerminalStatusTransition {
  const shouldClearConnectionFields = status === 'disconnected' || everConnected;
  const nextSnapshotState: PluginTerminalSnapshotState = shouldClearConnectionFields
    ? {
        ...(snapshotState.cols == null ? {} : { cols: snapshotState.cols }),
        ...(snapshotState.rows == null ? {} : { rows: snapshotState.rows }),
      }
    : { ...snapshotState };
  if (status === 'connected') {
    return Object.freeze({
      snapshotState: nextSnapshotState,
      everConnected: true,
      eventType: everConnected ? 'reconnected' : 'connected',
    });
  }
  if (status === 'disconnected') {
    return Object.freeze({
      snapshotState: nextSnapshotState,
      everConnected,
      eventType: 'disconnected',
      ...(exitCode === undefined ? {} : { eventDetails: Object.freeze({ exitCode }) }),
    });
  }
  return Object.freeze({
    snapshotState: nextSnapshotState,
    everConnected,
  });
}

export function normalizePluginTerminalProtocol(
  protocol: string | undefined,
): NetcattyTerminalSessionSnapshot['protocol'] {
  const normalized = protocol?.trim();
  return normalized || 'ssh';
}

export function shouldPublishPluginTerminalSessionMountLifecycle(
  attachExistingSession: boolean,
): boolean {
  return !attachExistingSession;
}

export function beginPluginTerminalSessionMountLifecycle(
  ownsBackendSessionMount: boolean,
  publishCreated: () => void,
  disposeBackendSession: () => void,
): (() => void) | undefined {
  if (!ownsBackendSessionMount) return undefined;
  publishCreated();
  return disposeBackendSession;
}

export function ownsPluginTerminalBackendLifecycle(value: boolean | undefined): boolean {
  return value !== false;
}

const BACKEND_LIFECYCLE_EVENTS = new Set<NetcattyTerminalSessionEvent['type']>([
  'created', 'connected', 'reconnected', 'disconnected', 'disposed',
]);

export function shouldPublishPluginTerminalEvent(
  type: NetcattyTerminalSessionEvent['type'],
  ownsBackendLifecycle: boolean | undefined,
): boolean {
  return ownsPluginTerminalBackendLifecycle(ownsBackendLifecycle)
    || !BACKEND_LIFECYCLE_EVENTS.has(type);
}

function normalizeShellType(shellType: string | undefined): NetcattyTerminalSessionSnapshot['shellType'] | undefined {
  if (shellType === 'posix' || shellType === 'fish' || shellType === 'powershell' || shellType === 'cmd') {
    return shellType;
  }
  return shellType ? 'unknown' : undefined;
}

export function usePluginTerminalSessionLifecycle(options: PluginTerminalSessionLifecycleOptions) {
  const registry = getWindowPluginTerminalProviderRegistry();
  const metadataRef = useRef(options);
  metadataRef.current = options;
  const snapshotStateRef = useRef<PluginTerminalSnapshotState>({ cwd: options.initialCwd });
  const everConnectedRef = useRef(false);
  const exitDisconnectPublishedRef = useRef(false);

  const snapshot = useCallback((): NetcattyTerminalSessionSnapshot => {
    const metadata = metadataRef.current;
    const state = snapshotStateRef.current;
    const shellType = normalizeShellType(metadata.shellType);
    return {
      sessionId: metadata.sessionId,
      ...(metadata.hostId ? { hostId: metadata.hostId } : {}),
      ...(metadata.workspaceId ? { workspaceId: metadata.workspaceId } : {}),
      protocol: normalizePluginTerminalProtocol(metadata.protocol),
      status: metadata.status,
      ...(state.cwd ? { cwd: state.cwd } : {}),
      ...(state.title ? { title: state.title } : {}),
      ...(shellType ? { shellType } : {}),
      ...(state.cols == null ? {} : { cols: state.cols }),
      ...(state.rows == null ? {} : { rows: state.rows }),
      ...(state.alternateScreen == null ? {} : { alternateScreen: state.alternateScreen }),
    };
  }, []);

  const publish = useCallback((
    type: NetcattyTerminalSessionEvent['type'],
    details: { exitCode?: number } = {},
    sessionOverrides: Partial<NetcattyTerminalSessionSnapshot> = {},
  ) => {
    if (!registry) return;
    if (!shouldPublishPluginTerminalEvent(type, metadataRef.current.ownsBackendLifecycle)) return;
    void registry.publishSessionEvent({
      type,
      session: { ...snapshot(), ...sessionOverrides },
      ...details,
    }).catch(() => {});
  }, [registry, snapshot]);

  useEffect(() => {
    return beginPluginTerminalSessionMountLifecycle(
      ownsPluginTerminalBackendLifecycle(options.ownsBackendLifecycle),
      () => publish('created'),
      () => {
        publish('disposed');
        registry?.cancelSession(metadataRef.current.sessionId);
      },
    );
  }, [options.ownsBackendLifecycle, publish, registry]);

  useEffect(() => {
    const transition = transitionPluginTerminalConnectionState(
      snapshotStateRef.current,
      options.status,
      everConnectedRef.current,
    );
    snapshotStateRef.current = transition.snapshotState;
    everConnectedRef.current = transition.everConnected;
    if (transition.eventType === 'disconnected' && exitDisconnectPublishedRef.current) {
      exitDisconnectPublishedRef.current = false;
      return;
    }
    if (options.status !== 'disconnected') exitDisconnectPublishedRef.current = false;
    if (transition.eventType) publish(transition.eventType);
  }, [options.status, publish]);

  const onSessionExited = useCallback((exitCode?: number) => {
    const transition = transitionPluginTerminalConnectionState(
      snapshotStateRef.current,
      'disconnected',
      everConnectedRef.current,
      exitCode,
    );
    snapshotStateRef.current = transition.snapshotState;
    everConnectedRef.current = transition.everConnected;
    exitDisconnectPublishedRef.current = true;
    publish('disconnected', transition.eventDetails, { status: 'disconnected' });
  }, [publish]);

  const onCwdChanged = useCallback((cwd: string | null) => {
    snapshotStateRef.current.cwd = cwd || undefined;
    publish('cwdChanged');
  }, [publish]);

  const onTitleChanged = useCallback((title: string | null) => {
    snapshotStateRef.current.title = title || undefined;
    publish('titleChanged');
  }, [publish]);

  const onResized = useCallback((cols: number, rows: number) => {
    snapshotStateRef.current.cols = cols;
    snapshotStateRef.current.rows = rows;
    publish('resized');
  }, [publish]);

  const onAlternateScreenChanged = useCallback((alternateScreen: boolean) => {
    if (snapshotStateRef.current.alternateScreen === alternateScreen) return;
    snapshotStateRef.current.alternateScreen = alternateScreen;
    publish('alternateScreenChanged');
  }, [publish]);

  const onCommandSubmitted = useCallback(() => {
    publish('commandSubmitted');
  }, [publish]);

  const onCommandCompleted = useCallback(() => {
    publish('commandCompleted');
  }, [publish]);

  return useMemo(() => ({
    onAlternateScreenChanged,
    onCommandCompleted,
    onCommandSubmitted,
    onCwdChanged,
    onResized,
    onSessionExited,
    onTitleChanged,
  }), [onAlternateScreenChanged, onCommandCompleted, onCommandSubmitted, onCwdChanged, onResized, onSessionExited, onTitleChanged]);
}
