import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";

import {
  isFollowOriginStillCurrent,
  shouldApplyFollowTerminalCwdSyncResult,
  shouldClearBlockedFollowOnReach,
  shouldFollowTerminalCwdNavigate,
  shouldInvalidateFollowBookkeepingOnCwdChange,
  shouldLatchInitialFollowInterruption,
  shouldReleaseInitialFollowSyncAttempt,
  shouldResetInitialFollowTerminalCwdSync,
  type SftpFollowTerminalCwdBlock,
} from "../../../domain/sftpFollowTerminalCwd";
import type { Host } from "../../../types";
import type { SftpNavigateOptions, SftpNavigateResult } from "./useSftpPaneActions";

type FollowConnection = {
  id: string;
  currentPath?: string | null;
  status: string;
  isLocal?: boolean;
};

type SftpFollowApi = {
  leftPane: {
    connection?: FollowConnection | null;
    loading: boolean;
  };
  navigateTo: (
    side: "left" | "right",
    path: string,
    options?: SftpNavigateOptions,
  ) => Promise<SftpNavigateResult>;
};

type GetTerminalCwd = (options?: {
  preferFreshBackend?: boolean;
  allowRendererFallback?: boolean;
  requireActiveShellCwd?: boolean;
}) => Promise<string | null>;

type InitialFollowConnection = {
  id: string;
  currentPath?: string | null;
  status: string;
  isLocal?: boolean;
};

type InitialFollowSyncOptions = {
  expectedConnectionId: string;
  staleTerminalCwd?: string | null;
  getFreshTerminalCwd: () => Promise<string | null | undefined>;
  isEligible: () => boolean;
  getConnection: () => InitialFollowConnection | null | undefined;
  navigate: (
    cwd: string,
    shouldApply: () => boolean,
  ) => Promise<"reached" | "failed" | "aborted" | "superseded">;
  setHandled: (value: SftpFollowTerminalCwdBlock) => void;
  setBlocked: (value: SftpFollowTerminalCwdBlock | null) => void;
};

/** Run one guarded first-open sync. False means the caller may retry. */
const runInitialFollowTerminalCwdSync = async ({
  expectedConnectionId,
  staleTerminalCwd,
  getFreshTerminalCwd,
  isEligible,
  getConnection,
  navigate,
  setHandled,
  setBlocked,
}: InitialFollowSyncOptions): Promise<boolean> => {
  const cwd = await getFreshTerminalCwd();
  if (!cwd || !isEligible()) return false;

  const live = getConnection();
  if (!live || live.id !== expectedConnectionId || live.status !== "connected" || live.isLocal) {
    return false;
  }

  setHandled({
    connectionId: expectedConnectionId,
    terminalCwd: staleTerminalCwd && staleTerminalCwd !== cwd ? staleTerminalCwd : cwd,
  });
  if (live.currentPath === cwd) return true;

  const navigateResult = await navigate(cwd, isEligible);
  if (!isEligible()) return false;
  const current = getConnection();
  if (!current || current.id !== expectedConnectionId || current.status !== "connected") {
    return false;
  }
  if (navigateResult === "failed") {
    setBlocked({ connectionId: expectedConnectionId, terminalCwd: cwd });
    return true;
  }
  if (navigateResult === "reached") {
    setBlocked(null);
    return true;
  }
  return navigateResult === "superseded";
};

type UseSftpFollowTerminalCwdOptions = {
  activeSessionId?: string | null;
  /** Focused terminal including Mosh/ET, used when SSH reuse id is absent. */
  focusedSessionId?: string | null;
  activeTerminalCwd: string | null;
  activeTerminalCwdTrusted?: boolean;
  canFollowTerminalCwd: boolean;
  connectionId: string | null;
  connectionIsLocal?: boolean;
  connectionLoading: boolean;
  connectionPath: string | null;
  connectionStatus?: string;
  effectiveFollowTerminalCwd: boolean;
  followTerminalCwdHost: Host | null;
  hasActiveWork: boolean;
  isVisible: boolean;
  ownerPanelOpen: boolean;
  onGetTerminalCwd?: GetTerminalCwd;
  onPendingFollowOverride: (override: { hostId: string; value: boolean }) => void;
  onSftpFollowTerminalCwdChange?: (enabled: boolean, host?: Host | null) => void;
  sftpRef: MutableRefObject<SftpFollowApi>;
};

export type SftpFollowTerminalCwdActions = {
  handleGoToTerminalCwd: () => Promise<void>;
  handleToggleFollowTerminalCwd: () => void;
};

const MAX_INITIAL_FOLLOW_ATTEMPTS = 3;
const INITIAL_FOLLOW_RETRY_DELAY_MS = 250;

/** Owns terminal-cwd follow state so the SFTP view remains presentation-only. */
export function useSftpFollowTerminalCwd({
  activeSessionId,
  focusedSessionId = null,
  activeTerminalCwd,
  activeTerminalCwdTrusted = false,
  canFollowTerminalCwd,
  connectionId,
  connectionIsLocal,
  connectionLoading,
  connectionPath,
  connectionStatus,
  effectiveFollowTerminalCwd,
  followTerminalCwdHost,
  hasActiveWork,
  isVisible,
  ownerPanelOpen,
  onGetTerminalCwd,
  onPendingFollowOverride,
  onSftpFollowTerminalCwdChange,
  sftpRef,
}: UseSftpFollowTerminalCwdOptions): SftpFollowTerminalCwdActions {
  const blockedFollowRef = useRef<SftpFollowTerminalCwdBlock | null>(null);
  const handledFollowRef = useRef<SftpFollowTerminalCwdBlock | null>(null);
  const followSyncGenerationRef = useRef(0);
  const effectiveFollowTerminalCwdRef = useRef(effectiveFollowTerminalCwd);
  const canFollowTerminalCwdRef = useRef(canFollowTerminalCwd);
  const activeTerminalCwdRef = useRef(activeTerminalCwd);
  const activeSessionIdRef = useRef(activeSessionId);
  const focusedSessionIdRef = useRef(focusedSessionId);
  const connectionIdRef = useRef(connectionId);
  const isVisibleRef = useRef(isVisible);
  const ownerPanelOpenRef = useRef(ownerPanelOpen);
  const hasActiveWorkRef = useRef(hasActiveWork);
  const initialFollowReadyConnectionRef = useRef<string | null>(null);

  effectiveFollowTerminalCwdRef.current = effectiveFollowTerminalCwd;
  canFollowTerminalCwdRef.current = canFollowTerminalCwd;
  activeTerminalCwdRef.current = activeTerminalCwd;
  activeSessionIdRef.current = activeSessionId;
  focusedSessionIdRef.current = focusedSessionId;
  connectionIdRef.current = connectionId;
  isVisibleRef.current = isVisible;
  ownerPanelOpenRef.current = ownerPanelOpen;
  hasActiveWorkRef.current = hasActiveWork;

  const invalidateInFlightFollowSync = useCallback(() => {
    followSyncGenerationRef.current += 1;
    blockedFollowRef.current = null;
    handledFollowRef.current = null;
  }, []);

  useEffect(() => {
    invalidateInFlightFollowSync();
  }, [connectionId, followTerminalCwdHost?.id, invalidateInFlightFollowSync]);

  const lastLiveTerminalCwdRef = useRef<string | null>(activeTerminalCwd);
  const lastLiveTerminalCwdTrustedRef = useRef(activeTerminalCwdTrusted);
  useEffect(() => {
    const cwdInvalidates = shouldInvalidateFollowBookkeepingOnCwdChange({
      nextCwd: activeTerminalCwd,
      lastCwd: lastLiveTerminalCwdRef.current,
      isVisible,
    });
    const trustInvalidates = activeTerminalCwd !== null
      && activeTerminalCwdTrusted !== lastLiveTerminalCwdTrustedRef.current;
    if (!cwdInvalidates && !trustInvalidates) return;
    lastLiveTerminalCwdRef.current = activeTerminalCwd;
    lastLiveTerminalCwdTrustedRef.current = activeTerminalCwdTrusted;
    if (activeTerminalCwd && activeTerminalCwdTrusted && connectionIdRef.current) {
      // A concrete live cwd is stronger evidence than the exhausted initial
      // backend probes. Let the ordinary follow path resume immediately.
      initialFollowReadyConnectionRef.current = connectionIdRef.current;
    }
    invalidateInFlightFollowSync();
  }, [activeTerminalCwd, activeTerminalCwdTrusted, invalidateInFlightFollowSync, isVisible]);

  useEffect(() => {
    if (effectiveFollowTerminalCwd) return;
    invalidateInFlightFollowSync();
  }, [effectiveFollowTerminalCwd, invalidateInFlightFollowSync]);

  useEffect(() => {
    const blockedFollow = blockedFollowRef.current;
    if (shouldClearBlockedFollowOnReach(
      blockedFollow,
      connectionId,
      connectionPath,
      connectionLoading,
    )) {
      blockedFollowRef.current = null;
      handledFollowRef.current = blockedFollow;
    }
  }, [connectionId, connectionLoading, connectionPath]);

  const handleGoToTerminalCwd = useCallback(async () => {
    if (!onGetTerminalCwd) return;
    const expectedConnectionId = sftpRef.current.leftPane.connection?.id ?? null;
    const expectedSessionId = focusedSessionIdRef.current ?? activeSessionIdRef.current ?? null;
    const syncGeneration = followSyncGenerationRef.current;
    if (!expectedConnectionId) return;
    const shouldApply = () => (
      syncGeneration === followSyncGenerationRef.current
      && isFollowOriginStillCurrent({
        expectedOriginId: expectedSessionId,
        liveOriginId: focusedSessionIdRef.current ?? activeSessionIdRef.current ?? null,
      })
      && connectionIdRef.current === expectedConnectionId
      && sftpRef.current.leftPane.connection?.id === expectedConnectionId
      && sftpRef.current.leftPane.connection?.status === "connected"
    );
    const cwd = await onGetTerminalCwd({
      preferFreshBackend: true,
      allowRendererFallback: false,
      requireActiveShellCwd: true,
    });
    if (!cwd) return;
    if (!shouldApply()) return;
    const navigateResult = await sftpRef.current.navigateTo("left", cwd, { shouldApply });
    if (navigateResult !== "reached" || !shouldApply()) return;
    blockedFollowRef.current = null;
    const connection = sftpRef.current.leftPane.connection;
    if (connection?.id) {
      handledFollowRef.current = { connectionId: connection.id, terminalCwd: cwd };
    }
  }, [onGetTerminalCwd, sftpRef]);

  const syncFollowToTerminalCwd = useCallback(async () => {
    if (!onGetTerminalCwd || !effectiveFollowTerminalCwd || !canFollowTerminalCwd) return;

    const liveConnectionId = sftpRef.current.leftPane.connection?.id ?? null;
    if (!liveConnectionId || initialFollowReadyConnectionRef.current !== liveConnectionId) return;

    const syncGeneration = followSyncGenerationRef.current;
    const expectedSessionId = focusedSessionIdRef.current ?? activeSessionIdRef.current ?? null;
    const expectedConnectionIdAtStart = connectionIdRef.current ?? liveConnectionId;
    const usesLiveTerminalCwd = Boolean(activeTerminalCwd && activeTerminalCwdTrusted);
    let terminalCwd = usesLiveTerminalCwd ? activeTerminalCwd : null;
    if (!terminalCwd) {
      terminalCwd = await onGetTerminalCwd({
        preferFreshBackend: true,
        allowRendererFallback: false,
        requireActiveShellCwd: true,
      });
    }
    if (!terminalCwd) return;
    if (!shouldApplyFollowTerminalCwdSyncResult({
      syncGeneration,
      currentGeneration: followSyncGenerationRef.current,
      followEnabled: effectiveFollowTerminalCwdRef.current,
      canFollow: canFollowTerminalCwdRef.current,
      expectedSessionId,
      liveSessionId: focusedSessionIdRef.current ?? activeSessionIdRef.current ?? null,
      expectedConnectionId: expectedConnectionIdAtStart,
      liveConnectionId: connectionIdRef.current,
      paneConnectionId: sftpRef.current.leftPane.connection?.id ?? null,
    })) return;

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
    const shouldApplyCurrentFollowSync = () => shouldApplyFollowTerminalCwdSyncResult({
      syncGeneration,
      currentGeneration: followSyncGenerationRef.current,
      followEnabled: effectiveFollowTerminalCwdRef.current,
      canFollow: canFollowTerminalCwdRef.current,
      expectedSessionId,
      liveSessionId: focusedSessionIdRef.current ?? activeSessionIdRef.current ?? null,
      expectedConnectionId,
      liveConnectionId: connectionIdRef.current,
      paneConnectionId: sftpRef.current.leftPane.connection?.id ?? null,
      expectedTerminalCwd: terminalCwd,
      liveTerminalCwd: activeTerminalCwdRef.current,
      requireLiveTerminalCwd: usesLiveTerminalCwd,
    });
    const navigateResult = await sftpRef.current.navigateTo("left", terminalCwd, {
      shouldApply: shouldApplyCurrentFollowSync,
    });
    if (!shouldApplyCurrentFollowSync()) return;

    const currentConnection = sftpRef.current.leftPane.connection;
    if (!currentConnection || currentConnection.id !== connection?.id) return;
    if (navigateResult === "failed") {
      blockedFollowRef.current = { connectionId: currentConnection.id, terminalCwd };
    } else if (navigateResult === "superseded") {
      handledFollowRef.current = { connectionId: currentConnection.id, terminalCwd };
    } else if (navigateResult === "reached") {
      blockedFollowRef.current = null;
      handledFollowRef.current = { connectionId: currentConnection.id, terminalCwd };
    }
  }, [
    activeTerminalCwd,
    activeTerminalCwdTrusted,
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
      onPendingFollowOverride({ hostId: followTerminalCwdHost.id, value: nextEnabled });
    }
    onSftpFollowTerminalCwdChange?.(nextEnabled, followTerminalCwdHost);
  }, [
    effectiveFollowTerminalCwd,
    followTerminalCwdHost,
    invalidateInFlightFollowSync,
    onPendingFollowOverride,
    onSftpFollowTerminalCwdChange,
  ]);

  useEffect(() => {
    if (!effectiveFollowTerminalCwd || !canFollowTerminalCwd || !isVisible || hasActiveWork) return;
    void syncFollowToTerminalCwd();
  }, [
    activeTerminalCwd,
    activeTerminalCwdTrusted,
    canFollowTerminalCwd,
    connectionId,
    connectionIsLocal,
    connectionStatus,
    effectiveFollowTerminalCwd,
    hasActiveWork,
    isVisible,
    syncFollowToTerminalCwd,
  ]);

  const initialFollowSyncedConnRef = useRef<string | null>(null);
  const initialFollowRetryRef = useRef<{ connectionId: string | null; attempts: number }>({
    connectionId: null,
    attempts: 0,
  });
  const initialFollowRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialFollowInterruptedRef = useRef(false);
  const initialFollowProbeSeqRef = useRef(0);
  const initialFollowProbeAttemptRef = useRef<number | null>(null);
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
    if (initialFollowProbeAttemptRef.current === null) return;
    if (!shouldLatchInitialFollowInterruption({ isVisible, ownerPanelOpen })) return;
    initialFollowInterruptedRef.current = true;
  }, [isVisible, ownerPanelOpen]);

  useEffect(() => {
    if (isVisible || !ownerPanelOpen || !initialFollowRetryTimerRef.current) return;
    clearTimeout(initialFollowRetryTimerRef.current);
    initialFollowRetryTimerRef.current = null;
  }, [isVisible, ownerPanelOpen]);

  useEffect(() => {
    if (!shouldResetInitialFollowTerminalCwdSync({
      isVisible,
      ownerPanelOpen,
      connectionId,
      trackedConnectionId: initialFollowRetryRef.current.connectionId,
    })) return;

    initialFollowSyncedConnRef.current = null;
    initialFollowReadyConnectionRef.current = null;
    initialFollowInterruptedRef.current = false;
    initialFollowRetryRef.current = { connectionId, attempts: 0 };
    followSyncGenerationRef.current += 1;
    initialFollowProbeAttemptRef.current = null;
    if (initialFollowRetryTimerRef.current) {
      clearTimeout(initialFollowRetryTimerRef.current);
      initialFollowRetryTimerRef.current = null;
    }
  }, [connectionId, isVisible, ownerPanelOpen]);

  useEffect(() => {
    if (!effectiveFollowTerminalCwd || !canFollowTerminalCwd || !isVisible || hasActiveWork) return;
    const connection = sftpRef.current.leftPane.connection;
    if (!connection || connection.isLocal || connection.status !== "connected" || !connection.id) return;
    if (initialFollowSyncedConnRef.current === connection.id) return;
    if (initialFollowRetryRef.current.connectionId !== connection.id) {
      initialFollowRetryRef.current = { connectionId: connection.id, attempts: 0 };
    }
    if (initialFollowRetryRef.current.attempts >= MAX_INITIAL_FOLLOW_ATTEMPTS) return;
    initialFollowRetryRef.current.attempts += 1;
    initialFollowSyncedConnRef.current = connection.id;

    const expectedConnectionId = connection.id;
    const expectedPanePath = connection.currentPath ?? null;
    const expectedSessionId = focusedSessionId ?? activeSessionId ?? null;
    const staleTerminalCwd = activeTerminalCwdRef.current;
    const syncGeneration = followSyncGenerationRef.current;
    let navigationStarted = false;
    const followCurrentlyEligible = () => (
      initialFollowMountedRef.current
      && effectiveFollowTerminalCwdRef.current
      && canFollowTerminalCwdRef.current
      && isVisibleRef.current
      && !hasActiveWorkRef.current
      && isFollowOriginStillCurrent({
        expectedOriginId: expectedSessionId,
        liveOriginId: focusedSessionIdRef.current ?? activeSessionIdRef.current ?? null,
      })
      && sftpRef.current.leftPane.connection?.id === expectedConnectionId
      && (
        navigationStarted
        || (sftpRef.current.leftPane.connection?.currentPath ?? null) === expectedPanePath
      )
      && !sftpRef.current.leftPane.connection?.isLocal
      && sftpRef.current.leftPane.connection?.status === "connected"
    );
    const followStillEligible = () => (
      syncGeneration === followSyncGenerationRef.current
      && !initialFollowInterruptedRef.current
      && followCurrentlyEligible()
    );
    const clearAttemptAndRetry = () => {
      if (initialFollowInterruptedRef.current) return;
      if (
        initialFollowSyncedConnRef.current === expectedConnectionId
        && !shouldReleaseInitialFollowSyncAttempt({
          isVisible: isVisibleRef.current,
          ownerPanelOpen: ownerPanelOpenRef.current,
        })
      ) return;
      if (
        !initialFollowMountedRef.current
        || !followCurrentlyEligible()
        || initialFollowRetryRef.current.attempts >= MAX_INITIAL_FOLLOW_ATTEMPTS
      ) {
        if (initialFollowSyncedConnRef.current === expectedConnectionId) {
          initialFollowSyncedConnRef.current = null;
        }
        return;
      }
      if (initialFollowRetryTimerRef.current) clearTimeout(initialFollowRetryTimerRef.current);
      initialFollowRetryTimerRef.current = setTimeout(() => {
        initialFollowRetryTimerRef.current = null;
        if (!shouldReleaseInitialFollowSyncAttempt({
          isVisible: isVisibleRef.current,
          ownerPanelOpen: ownerPanelOpenRef.current,
        })) return;
        if (initialFollowSyncedConnRef.current === expectedConnectionId) {
          initialFollowSyncedConnRef.current = null;
        }
        setInitialFollowRetryNonce((value) => value + 1);
      }, INITIAL_FOLLOW_RETRY_DELAY_MS);
    };

    initialFollowProbeSeqRef.current += 1;
    const probeAttempt = initialFollowProbeSeqRef.current;
    initialFollowProbeAttemptRef.current = probeAttempt;
    void runInitialFollowTerminalCwdSync({
      expectedConnectionId,
      staleTerminalCwd,
      getFreshTerminalCwd: () => onGetTerminalCwd?.({
        preferFreshBackend: true,
        allowRendererFallback: false,
        requireActiveShellCwd: true,
      }),
      isEligible: followStillEligible,
      getConnection: () => sftpRef.current.leftPane.connection,
      navigate: (cwd, shouldApply) => {
        navigationStarted = true;
        return sftpRef.current.navigateTo("left", cwd, { shouldApply });
      },
      setHandled: (value) => { handledFollowRef.current = value; },
      setBlocked: (value) => { blockedFollowRef.current = value; },
    }).then((completed) => {
      const isCurrentAttempt = initialFollowProbeAttemptRef.current === probeAttempt;
      if (isCurrentAttempt) initialFollowProbeAttemptRef.current = null;
      if (completed && isCurrentAttempt) {
        initialFollowReadyConnectionRef.current = expectedConnectionId;
      }
      if (!completed && isCurrentAttempt) clearAttemptAndRetry();
    });
  }, [
    activeSessionId,
    focusedSessionId,
    activeTerminalCwd,
    canFollowTerminalCwd,
    connectionId,
    connectionIsLocal,
    connectionStatus,
    effectiveFollowTerminalCwd,
    hasActiveWork,
    initialFollowRetryNonce,
    isVisible,
    onGetTerminalCwd,
    sftpRef,
  ]);

  return { handleGoToTerminalCwd, handleToggleFollowTerminalCwd };
}
