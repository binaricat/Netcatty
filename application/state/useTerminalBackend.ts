import { useCallback, useMemo } from "react";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";

export const useTerminalBackend = () => {
  const telnetAvailable = useCallback(() => {
    const bridge = netcattyBridge.get();
    return !!bridge?.startTelnetSession;
  }, []);

  const moshAvailable = useCallback(() => {
    const bridge = netcattyBridge.get();
    return !!bridge?.startMoshSession;
  }, []);

  const etAvailable = useCallback(() => {
    const bridge = netcattyBridge.get();
    return !!bridge?.startEtSession;
  }, []);

  const localAvailable = useCallback(() => {
    const bridge = netcattyBridge.get();
    return !!bridge?.startLocalSession;
  }, []);

  const serialAvailable = useCallback(() => {
    const bridge = netcattyBridge.get();
    return !!bridge?.startSerialSession;
  }, []);

  const execAvailable = useCallback(() => {
    const bridge = netcattyBridge.get();
    return !!bridge?.execCommand;
  }, []);

  const startSSHSession = useCallback(async (options: NetcattySSHOptions) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.startSSHSession) throw new Error("startSSHSession unavailable");
    return bridge.startSSHSession(options);
  }, []);

  const startTelnetSession = useCallback(async (options: Parameters<NonNullable<NetcattyBridge["startTelnetSession"]>>[0]) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.startTelnetSession) throw new Error("startTelnetSession unavailable");
    return bridge.startTelnetSession(options);
  }, []);

  const startMoshSession = useCallback(async (options: Parameters<NonNullable<NetcattyBridge["startMoshSession"]>>[0]) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.startMoshSession) throw new Error("startMoshSession unavailable");
    return bridge.startMoshSession(options);
  }, []);

  const startEtSession = useCallback(async (options: Parameters<NonNullable<NetcattyBridge["startEtSession"]>>[0]) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.startEtSession) throw new Error("startEtSession unavailable");
    return bridge.startEtSession(options);
  }, []);

  const startLocalSession = useCallback(async (options: Parameters<NonNullable<NetcattyBridge["startLocalSession"]>>[0]) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.startLocalSession) throw new Error("startLocalSession unavailable");
    return bridge.startLocalSession(options);
  }, []);

  const startSerialSession = useCallback(async (options: Parameters<NonNullable<NetcattyBridge["startSerialSession"]>>[0]) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.startSerialSession) throw new Error("startSerialSession unavailable");
    return bridge.startSerialSession(options);
  }, []);

  const execCommand = useCallback(async (options: Parameters<NetcattyBridge["execCommand"]>[0]) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.execCommand) throw new Error("execCommand unavailable");
    return bridge.execCommand(options);
  }, []);

  const setupOsc7Tracking = useCallback(async (sessionId: string, command: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.setupOsc7Tracking) {
      return { success: false, error: "setupOsc7Tracking unavailable" };
    }
    return bridge.setupOsc7Tracking(sessionId, command);
  }, []);

  const writeToSession = useCallback((sessionId: string, data: string, options?: Parameters<NonNullable<NetcattyBridge["writeToSession"]>>[2]) => {
    const bridge = netcattyBridge.get();
    bridge?.writeToSession?.(sessionId, data, options);
  }, []);

  const interruptSession = useCallback((sessionId: string, trace?: NetcattyTerminalInterruptTrace) => {
    const bridge = netcattyBridge.get();
    if (bridge?.interruptSession) {
      bridge.interruptSession(sessionId, trace);
      return;
    }
    bridge?.writeToSession?.(sessionId, "\x03");
  }, []);

  const resizeSession = useCallback((sessionId: string, cols: number, rows: number) => {
    const bridge = netcattyBridge.get();
    bridge?.resizeSession?.(sessionId, cols, rows);
  }, []);

  const clearSessionPtyBuffer = useCallback((sessionId: string) => {
    const bridge = netcattyBridge.get();
    bridge?.clearSessionPtyBuffer?.(sessionId);
  }, []);

  const setSessionFlowPaused = useCallback((sessionId: string, paused: boolean) => {
    const bridge = netcattyBridge.get();
    bridge?.setSessionFlowPaused?.(sessionId, paused);
  }, []);

  const setSessionFlowPausedAndWait = useCallback(async (sessionId: string, paused: boolean) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.setSessionFlowPausedAndWait) {
      bridge?.setSessionFlowPaused?.(sessionId, paused);
      return paused
        ? { success: false, error: "Output drain unavailable" }
        : { success: true };
    }
    return bridge.setSessionFlowPausedAndWait(sessionId, paused);
  }, []);

  const ackSessionFlow = useCallback((sessionId: string, bytes: number) => {
    const bridge = netcattyBridge.get();
    bridge?.ackSessionFlow?.(sessionId, bytes);
  }, []);

  const notifyTerminalSessionDisplayReady = useCallback((sessionId: string) => {
    netcattyBridge.get()?.notifyTerminalSessionDisplayReady?.(sessionId);
  }, []);

  const closeSession = useCallback(async (sessionId: string) => {
    const bridge = netcattyBridge.get();
    await bridge?.closeSession?.(sessionId);
  }, []);

  const rebindSessionOutput = useCallback(async (sessionId: string, authorization: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.rebindTerminalSessionOutput) {
      return { success: false as const, error: "rebindTerminalSessionOutput unavailable" };
    }
    return bridge.rebindTerminalSessionOutput(sessionId, authorization);
  }, []);

  const restoreSessionOutput = useCallback(async (
    sessionId: string,
    webContentsId?: number | null,
    authorization?: string,
  ) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.restoreTerminalSessionOutput) {
      return { success: false as const, error: "restoreTerminalSessionOutput unavailable" };
    }
    return bridge.restoreTerminalSessionOutput(sessionId, webContentsId, authorization);
  }, []);

  const requestSessionSnapshot = useCallback(async (sessionId: string, authorization: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.requestTerminalSessionSnapshot) {
      return { success: false as const, snapshot: "", error: "requestTerminalSessionSnapshot unavailable" };
    }
    return bridge.requestTerminalSessionSnapshot(sessionId, authorization);
  }, []);

  const applySessionSnapshot = useCallback(async (
    sessionId: string,
    snapshot: string,
    context: {
      contextSnapshot: string;
      contextViewportSnapshot: string;
      contextScrollbackSnapshot: string;
      alternateScreen: boolean;
      kittyKeyboardModeState?: NetcattyKittyKeyboardModeState;
      kittyKeyboardProtocolEnabled?: boolean;
    },
    authorization: string,
  ) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.applyTerminalSessionSnapshot) {
      return { success: false as const, error: "applyTerminalSessionSnapshot unavailable" };
    }
    return bridge.applyTerminalSessionSnapshot(sessionId, snapshot, context, authorization);
  }, []);

  const setSessionEncoding = useCallback(async (sessionId: string, encoding: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.setSessionEncoding) return { ok: false, encoding };
    return bridge.setSessionEncoding(sessionId, encoding);
  }, []);

  const onSessionData = useCallback((
    sessionId: string,
    cb: Parameters<NetcattyBridge["onSessionData"]>[1],
    options?: Parameters<NetcattyBridge["onSessionData"]>[2],
  ) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onSessionData) throw new Error("onSessionData unavailable");
    return bridge.onSessionData(sessionId, cb, options);
  }, []);

  const onSessionExit = useCallback((sessionId: string, cb: (evt: { exitCode?: number; signal?: number; error?: string; reason?: "exited" | "error" | "timeout" | "closed" }) => void) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onSessionExit) throw new Error("onSessionExit unavailable");
    return bridge.onSessionExit(sessionId, cb);
  }, []);

  const onTelnetAutoLoginComplete = useCallback((sessionId: string, cb: (evt: { sessionId: string }) => void) => {
    const bridge = netcattyBridge.get();
    return bridge?.onTelnetAutoLoginComplete?.(sessionId, cb);
  }, []);

  const onTelnetAutoLoginCancelled = useCallback((sessionId: string, cb: (evt: { sessionId: string }) => void) => {
    const bridge = netcattyBridge.get();
    return bridge?.onTelnetAutoLoginCancelled?.(sessionId, cb);
  }, []);

  const onMoshSessionReady = useCallback((sessionId: string, cb: (evt: { sessionId: string }) => void) => {
    const bridge = netcattyBridge.get();
    return bridge?.onMoshSessionReady?.(sessionId, cb);
  }, []);

  const onTelnetEchoMode = useCallback((sessionId: string, cb: (evt: { sessionId: string; remoteEcho: boolean; localEcho: boolean }) => void) => {
    const bridge = netcattyBridge.get();
    return bridge?.onTelnetEchoMode?.(sessionId, cb);
  }, []);

  const getTelnetEchoMode = useCallback(async (sessionId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.getTelnetEchoMode) return { success: false as const, error: "getTelnetEchoMode unavailable" };
    return bridge.getTelnetEchoMode(sessionId);
  }, []);

  const onChainProgress = useCallback((cb: (sessionId: string, hop: number, total: number, label: string, status: string, error?: string) => void) => {
    const bridge = netcattyBridge.get();
    return bridge?.onChainProgress?.(cb);
  }, []);

  const onConnectionReuseFallback = useCallback((cb: (sessionId: string, sourceSessionId?: string) => void) => {
    const bridge = netcattyBridge.get();
    return bridge?.onConnectionReuseFallback?.(cb);
  }, []);

  const onWindowFullScreenChanged = useCallback((cb: (isFullscreen: boolean) => void) => {
    const bridge = netcattyBridge.get();
    return bridge?.onWindowFullScreenChanged?.(cb);
  }, []);

  const onWindowShown = useCallback((cb: () => void) => {
    const bridge = netcattyBridge.get();
    return bridge?.onWindowShown?.(cb);
  }, []);

  const onHostKeyVerification = useCallback((cb: Parameters<NonNullable<NetcattyBridge["onHostKeyVerification"]>>[0]) => {
    const bridge = netcattyBridge.get();
    return bridge?.onHostKeyVerification?.(cb);
  }, []);

  const respondHostKeyVerification = useCallback(async (
    requestId: string,
    accept: boolean,
    addToKnownHosts?: boolean,
  ) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.respondHostKeyVerification) {
      return { success: false, error: "respondHostKeyVerification unavailable" };
    }
    return bridge.respondHostKeyVerification(requestId, accept, addToKnownHosts);
  }, []);

  const openExternal = useCallback(async (url: string) => {
    const bridge = netcattyBridge.get();
    await bridge?.openExternal?.(url);
  }, []);

  const openExternalAvailable = useCallback(() => {
    const bridge = netcattyBridge.get();
    return !!bridge?.openExternal;
  }, []);

  const backendAvailable = useCallback(() => {
    const bridge = netcattyBridge.get();
    return !!bridge?.startSSHSession;
  }, []);

  const listSerialPorts = useCallback(async () => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listSerialPorts) return [];
    return bridge.listSerialPorts();
  }, []);

  const serialYmodemAvailable = useCallback(() => {
    const bridge = netcattyBridge.get();
    return !!bridge?.sendSerialYmodem;
  }, []);

  const serialYmodemReceiveAvailable = useCallback(() => {
    const bridge = netcattyBridge.get();
    return !!bridge?.receiveSerialYmodem;
  }, []);

  const selectFileAvailable = useCallback(() => {
    const bridge = netcattyBridge.get();
    return !!bridge?.selectFile;
  }, []);

  const selectDirectoryAvailable = useCallback(() => {
    const bridge = netcattyBridge.get();
    return !!bridge?.selectDirectory;
  }, []);

  const sendSerialYmodem = useCallback(async (sessionId: string, filePath: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.sendSerialYmodem) return { success: false, error: 'sendSerialYmodem unavailable' };
    return bridge.sendSerialYmodem(sessionId, filePath);
  }, []);

  const receiveSerialYmodem = useCallback(async (sessionId: string, destinationDir: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.receiveSerialYmodem) return { success: false, error: 'receiveSerialYmodem unavailable' };
    return bridge.receiveSerialYmodem(sessionId, destinationDir);
  }, []);

  const selectFile = useCallback(async (
    title?: string,
    defaultPath?: string,
    filters?: Array<{ name: string; extensions: string[] }>,
  ) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.selectFile) return null;
    return bridge.selectFile(title, defaultPath, filters);
  }, []);

  const selectDirectory = useCallback(async (title?: string, defaultPath?: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.selectDirectory) return null;
    return bridge.selectDirectory(title, defaultPath);
  }, []);

  const startZmodemDragDropUpload = useCallback(async (
    sessionId: string,
    files: Array<{
      path?: string;
      name: string;
      remoteName: string;
      data?: ArrayBuffer;
    }>,
    uploadCommand?: string,
  ) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.startZmodemDragDropUpload) {
      return { success: false, error: "startZmodemDragDropUpload unavailable" };
    }
    return bridge.startZmodemDragDropUpload(sessionId, files, uploadCommand);
  }, []);

  const cancelZmodem = useCallback((sessionId: string, options?: { interrupt?: boolean }) => {
    const bridge = netcattyBridge.get();
    bridge?.cancelZmodem?.(sessionId, options);
  }, []);

  const onZmodemEvent = useCallback((
    sessionId: string,
    cb: Parameters<NonNullable<NetcattyBridge["onZmodemEvent"]>>[1],
  ) => {
    const bridge = netcattyBridge.get();
    return bridge?.onZmodemEvent?.(sessionId, cb) ?? (() => {});
  }, []);

  const getSessionPwd = useCallback(async (sessionId: string, options?: { allowHomeFallback?: boolean }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.getSessionPwd) return { success: false, error: 'getSessionPwd unavailable' };
    return bridge.getSessionPwd(sessionId, options);
  }, []);

  const getSessionRemoteInfo = useCallback(async (sessionId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.getSessionRemoteInfo) {
      return { success: false, error: 'getSessionRemoteInfo unavailable' };
    }
    return bridge.getSessionRemoteInfo(sessionId);
  }, []);

  const getSessionDistroInfo = useCallback(async (sessionId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.getSessionDistroInfo) {
      return { success: false, error: 'getSessionDistroInfo unavailable' };
    }
    return bridge.getSessionDistroInfo(sessionId);
  }, []);

  const getServerStats = useCallback(async (sessionId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.getServerStats) return { success: false, error: 'getServerStats unavailable' };
    return bridge.getServerStats(sessionId);
  }, []);

  // Memoize the returned object so its identity is stable across the
  // hook's lifetime. Each method above is already useCallback([])-stable,
  // so listing them as deps means useMemo recomputes once and then
  // caches forever. Without this, every render produced a fresh object
  // literal — making `terminalBackend` an unstable reference that
  // forced consumers' useEffects (`}, [..., terminalBackend])`) to
  // rerun on every parent render and forced lint to flag any deeper
  // property dep (`}, [terminalBackend.onHostKeyVerification])`) it
  // couldn't statically prove safe.
  return useMemo(
    () => {
      const api = {
        backendAvailable,
        telnetAvailable,
        moshAvailable,
        etAvailable,
        localAvailable,
        serialAvailable,
        execAvailable,
        openExternalAvailable,
        startSSHSession,
        startTelnetSession,
        startMoshSession,
        startEtSession,
        startLocalSession,
        startSerialSession,
        listSerialPorts,
        serialYmodemAvailable,
        serialYmodemReceiveAvailable,
        selectFileAvailable,
        selectDirectoryAvailable,
        sendSerialYmodem,
        receiveSerialYmodem,
        selectFile,
        selectDirectory,
        startZmodemDragDropUpload,
        cancelZmodem,
        onZmodemEvent,
        execCommand,
        setupOsc7Tracking,
        getSessionPwd,
        getSessionRemoteInfo,
        getSessionDistroInfo,
        getServerStats,
        writeToSession,
        interruptSession,
        resizeSession,
        clearSessionPtyBuffer,
        setSessionFlowPaused,
        setSessionFlowPausedAndWait,
        ackSessionFlow,
        notifyTerminalSessionDisplayReady,
        closeSession,
        rebindSessionOutput,
        restoreSessionOutput,
        requestSessionSnapshot,
        applySessionSnapshot,
        setSessionEncoding,
        onSessionData,
        onSessionExit,
        onTelnetAutoLoginComplete,
        onTelnetAutoLoginCancelled,
        onTelnetEchoMode,
        getTelnetEchoMode,
        onChainProgress,
        onConnectionReuseFallback,
        onWindowFullScreenChanged,
        onWindowShown,
        onHostKeyVerification,
        respondHostKeyVerification,
        openExternal,
      };
      // Only surface onMoshSessionReady when the bridge actually implements it.
      // A always-truthy wrapper would skip the documented no-event fallback and
      // leave mosh startup/scripts waiting forever on older builds.
      Object.defineProperty(api, "onMoshSessionReady", {
        enumerable: true,
        configurable: true,
        get() {
          const bridge = netcattyBridge.get();
          if (typeof bridge?.onMoshSessionReady !== "function") {
            return undefined;
          }
          return onMoshSessionReady;
        },
      });
      return api;
    },
    [
      backendAvailable,
      telnetAvailable,
      moshAvailable,
      etAvailable,
      localAvailable,
      serialAvailable,
      execAvailable,
      openExternalAvailable,
      startSSHSession,
      startTelnetSession,
      startMoshSession,
      startEtSession,
      startLocalSession,
      startSerialSession,
      listSerialPorts,
      serialYmodemAvailable,
      serialYmodemReceiveAvailable,
      selectFileAvailable,
      selectDirectoryAvailable,
      sendSerialYmodem,
      receiveSerialYmodem,
      selectFile,
      selectDirectory,
      startZmodemDragDropUpload,
      cancelZmodem,
      onZmodemEvent,
      execCommand,
      setupOsc7Tracking,
      getSessionPwd,
      getSessionRemoteInfo,
      getSessionDistroInfo,
      getServerStats,
      writeToSession,
      interruptSession,
      resizeSession,
      clearSessionPtyBuffer,
      setSessionFlowPaused,
      setSessionFlowPausedAndWait,
      ackSessionFlow,
      notifyTerminalSessionDisplayReady,
      closeSession,
      rebindSessionOutput,
      restoreSessionOutput,
      requestSessionSnapshot,
      applySessionSnapshot,
      setSessionEncoding,
      onSessionData,
      onSessionExit,
      onTelnetAutoLoginComplete,
      onTelnetAutoLoginCancelled,
      onMoshSessionReady,
      onTelnetEchoMode,
      getTelnetEchoMode,
      onChainProgress,
      onConnectionReuseFallback,
      onWindowFullScreenChanged,
      onWindowShown,
      onHostKeyVerification,
      respondHostKeyVerification,
      openExternal,
    ],
  );
};
