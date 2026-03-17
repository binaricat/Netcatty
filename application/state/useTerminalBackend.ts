import { useCallback } from "react";
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

  const writeToSession = useCallback((sessionId: string, data: string) => {
    const bridge = netcattyBridge.get();
    bridge?.writeToSession?.(sessionId, data);
  }, []);

  const resizeSession = useCallback((sessionId: string, cols: number, rows: number) => {
    const bridge = netcattyBridge.get();
    bridge?.resizeSession?.(sessionId, cols, rows);
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

  const onChainProgress = useCallback((cb: (hop: number, total: number, label: string, status: string) => void) => {
    const bridge = netcattyBridge.get();
    return bridge?.onChainProgress?.(cb);
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

  const getSessionPwd = useCallback(async (sessionId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.getSessionPwd) return { success: false, error: 'getSessionPwd unavailable' };
    return bridge.getSessionPwd(sessionId);
  }, []);

  const getServerStats = useCallback(async (sessionId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.getServerStats) return { success: false, error: 'getServerStats unavailable' };
    return bridge.getServerStats(sessionId);
  }, []);

  return {
    backendAvailable,
    telnetAvailable,
    moshAvailable,
    localAvailable,
    serialAvailable,
    execAvailable,
    openExternalAvailable,
    startSSHSession,
    startTelnetSession,
    startMoshSession,
    startLocalSession,
    startSerialSession,
    listSerialPorts,
    execCommand,
    getSessionPwd,
    getServerStats,
    writeToSession,
    resizeSession,
    closeSession,
    setSessionEncoding,
    onSessionData,
    onSessionExit,
    onChainProgress,
    openExternal,
  };
};
