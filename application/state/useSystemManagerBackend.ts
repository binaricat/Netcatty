import { useCallback, useMemo } from 'react';
import type { DockerContainerAction, DockerImageManageAction, TmuxManageAction } from '../../domain/systemManager/types';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

export function useSystemManagerBackend() {
  const probeSystemCapabilities = useCallback(async (sessionId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.probeSystemCapabilities) {
      return { success: false as const, error: 'probeSystemCapabilities unavailable' };
    }
    return bridge.probeSystemCapabilities(sessionId);
  }, []);

  const listSystemProcesses = useCallback(async (sessionId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listSystemProcesses) {
      return { success: false as const, error: 'listSystemProcesses unavailable' };
    }
    return bridge.listSystemProcesses(sessionId);
  }, []);

  const signalSystemProcess = useCallback(async (options: {
    sessionId: string;
    pid: number;
    signal?: string;
    nice?: number;
  }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.signalSystemProcess) {
      return { success: false as const, error: 'signalSystemProcess unavailable' };
    }
    return bridge.signalSystemProcess(options);
  }, []);

  const listTmuxSessions = useCallback(async (sessionId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listTmuxSessions) {
      return { success: false as const, error: 'listTmuxSessions unavailable' };
    }
    return bridge.listTmuxSessions(sessionId);
  }, []);

  const createTmuxSession = useCallback(async (options: {
    sessionId: string;
    name: string;
    command?: string;
  }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.createTmuxSession) {
      return { success: false as const, error: 'createTmuxSession unavailable' };
    }
    return bridge.createTmuxSession(options);
  }, []);

  const listTmuxWindows = useCallback(async (options: { sessionId: string; sessionName: string }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listTmuxWindows) {
      return { success: false as const, error: 'listTmuxWindows unavailable' };
    }
    return bridge.listTmuxWindows(options);
  }, []);

  const listTmuxPanes = useCallback(async (options: {
    sessionId: string;
    sessionName: string;
    windowIndex: number;
  }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listTmuxPanes) {
      return { success: false as const, error: 'listTmuxPanes unavailable' };
    }
    return bridge.listTmuxPanes(options);
  }, []);

  const listTmuxClients = useCallback(async (options: { sessionId: string; sessionName?: string }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listTmuxClients) {
      return { success: false as const, error: 'listTmuxClients unavailable' };
    }
    return bridge.listTmuxClients(options);
  }, []);

  const tmuxAction = useCallback(async (options: { sessionId: string } & TmuxManageAction) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.tmuxAction) {
      return { success: false as const, error: 'tmuxAction unavailable' };
    }
    return bridge.tmuxAction(options);
  }, []);

  const listDockerContainers = useCallback(async (sessionId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listDockerContainers) {
      return { success: false as const, error: 'listDockerContainers unavailable' };
    }
    return bridge.listDockerContainers(sessionId);
  }, []);

  const listDockerImages = useCallback(async (sessionId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listDockerImages) {
      return { success: false as const, error: 'listDockerImages unavailable' };
    }
    return bridge.listDockerImages(sessionId);
  }, []);

  const getDockerStats = useCallback(async (options: { sessionId: string; ids?: string[] }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.getDockerStats) {
      return { success: false as const, error: 'getDockerStats unavailable' };
    }
    return bridge.getDockerStats(options);
  }, []);

  const dockerInspect = useCallback(async (options: { sessionId: string; containerId: string }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.dockerInspect) {
      return { success: false as const, error: 'dockerInspect unavailable' };
    }
    return bridge.dockerInspect(options);
  }, []);

  const dockerImageInspect = useCallback(async (options: { sessionId: string; imageId: string }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.dockerImageInspect) {
      return { success: false as const, error: 'dockerImageInspect unavailable' };
    }
    return bridge.dockerImageInspect(options);
  }, []);

  const dockerAction = useCallback(async (options: {
    sessionId: string;
    containerId: string;
    action: DockerContainerAction;
    newName?: string;
  }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.dockerAction) {
      return { success: false as const, error: 'dockerAction unavailable' };
    }
    return bridge.dockerAction(options);
  }, []);

  const dockerImageAction = useCallback(async (options: { sessionId: string } & DockerImageManageAction) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.dockerImageAction) {
      return { success: false as const, error: 'dockerImageAction unavailable' };
    }
    return bridge.dockerImageAction(options);
  }, []);

  const openTerminalPopup = useCallback(async (
    payload: Parameters<NonNullable<NetcattyBridge['openTerminalPopup']>>[0],
  ) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.openTerminalPopup) {
      return { success: false as const, error: 'openTerminalPopup unavailable' };
    }
    return bridge.openTerminalPopup(payload);
  }, []);

  return useMemo(() => ({
    probeSystemCapabilities,
    listSystemProcesses,
    signalSystemProcess,
    listTmuxSessions,
    createTmuxSession,
    listTmuxWindows,
    listTmuxPanes,
    listTmuxClients,
    tmuxAction,
    listDockerContainers,
    listDockerImages,
    getDockerStats,
    dockerInspect,
    dockerImageInspect,
    dockerAction,
    dockerImageAction,
    openTerminalPopup,
  }), [
    probeSystemCapabilities,
    listSystemProcesses,
    signalSystemProcess,
    listTmuxSessions,
    createTmuxSession,
    listTmuxWindows,
    listTmuxPanes,
    listTmuxClients,
    tmuxAction,
    listDockerContainers,
    listDockerImages,
    getDockerStats,
    dockerInspect,
    dockerImageInspect,
    dockerAction,
    dockerImageAction,
    openTerminalPopup,
  ]);
}
