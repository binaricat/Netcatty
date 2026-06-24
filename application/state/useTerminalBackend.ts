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

  const writeToSession = useCallback((sessionId: string, data: string, options?: Parameters<NonNullable<NetcattyBridge["writeToSession"]>>[2]) => {
    const bridge = netcattyBridge.get();
    bridge?.writeToSession?.(sessionId, data, options);
  }, []);

  const resizeSession = useCallback((sessionId: string, cols: number, rows: number) => {
    const bridge = netcattyBridge.get();
    bridge?.resizeSession?.(sessionId, cols, rows);
  }, []);

  const setSessionFlowPaused = useCallback((sessionId: string, paused: boolean) => {
    const bridge = netcattyBridge.get();
    bridge?.setSessionFlowPaused?.(sessionId, paused);
  }, []);

  const closeSession = useCallback((sessionId: string) => {
    const bridge = netcattyBridge.get();
    bridge?.closeSession?.(sessionId);
  }, []);

  const setSessionEncoding = useCallback(async (sessionId: string, encoding: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.setSessionEncoding) return { ok: false, encoding };
    return bridge.setSessionEncoding(sessionId, encoding);
  }, []);

  const onSessionData = useCallback((sessionId: string, cb: (data: string) => void) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onSessionData) throw new Error("onSessionData unavailable");
    return bridge.onSessionData(sessionId, cb);
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
    () => ({
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
      getSessionPwd,
      getSessionRemoteInfo,
      getSessionDistroInfo,
      getServerStats,
      writeToSession,
      resizeSession,
      setSessionFlowPaused,
      closeSession,
      setSessionEncoding,
      onSessionData,
      onSessionExit,
      onTelnetAutoLoginComplete,
      onTelnetAutoLoginCancelled,
      onChainProgress,
      onConnectionReuseFallback,
      onWindowFullScreenChanged,
      onHostKeyVerification,
      respondHostKeyVerification,
      openExternal,
    }),
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
      getSessionPwd,
      getSessionRemoteInfo,
      getSessionDistroInfo,
      getServerStats,
      writeToSession,
      resizeSession,
      setSessionFlowPaused,
      closeSession,
      setSessionEncoding,
      onSessionData,
      onSessionExit,
      onTelnetAutoLoginComplete,
      onTelnetAutoLoginCancelled,
      onChainProgress,
      onConnectionReuseFallback,
      onWindowFullScreenChanged,
      onHostKeyVerification,
      respondHostKeyVerification,
      openExternal,
    ],
  );
};
