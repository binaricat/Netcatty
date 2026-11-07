import { useCallback, useMemo } from 'react';
import type { ContainerRuntimeId } from '../../domain/systemManager/containerRuntime';
import type {
  DockerContainerAction,
  DockerImageManageAction,
  MultiplexerScope,
  SystemdUnitAction,
  SystemdUnitInfo,
  TmuxManageAction,
  ZellijManageAction,
} from '../../domain/systemManager/types';
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

  const listTmuxSessions = useCallback(async (sessionId: string, scope?: MultiplexerScope) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listTmuxSessions) {
      return { success: false as const, error: 'listTmuxSessions unavailable' };
    }
    return bridge.listTmuxSessions(sessionId, scope);
  }, []);

  const listTmuxSnapshot = useCallback(async (sessionId: string, scope?: MultiplexerScope) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listTmuxSnapshot) {
      return { success: false as const, error: 'listTmuxSnapshot unavailable' };
    }
    return bridge.listTmuxSnapshot(sessionId, scope);
  }, []);

  const listMultiplexerUsers = useCallback(async (sessionId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listMultiplexerUsers) {
      return { success: false as const, error: 'listMultiplexerUsers unavailable' };
    }
    return bridge.listMultiplexerUsers(sessionId);
  }, []);

  const listZellijSessions = useCallback(async (sessionId: string, scope?: MultiplexerScope) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listZellijSessions) {
      return { success: false as const, error: 'listZellijSessions unavailable' };
    }
    return bridge.listZellijSessions(sessionId, scope);
  }, []);

  const zellijAction = useCallback(async (options: {
    sessionId: string;
    scope?: MultiplexerScope;
  } & ZellijManageAction) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.zellijAction) {
      return { success: false as const, error: 'zellijAction unavailable' };
    }
    return bridge.zellijAction(options);
  }, []);

  const createTmuxSession = useCallback(async (options: {
    sessionId: string;
    name: string;
    command?: string;
    scope?: MultiplexerScope;
  }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.createTmuxSession) {
      return { success: false as const, error: 'createTmuxSession unavailable' };
    }
    return bridge.createTmuxSession(options);
  }, []);

  const listTmuxWindows = useCallback(async (options: {
    sessionId: string;
    sessionName: string;
    scope?: MultiplexerScope;
  }) => {
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
    scope?: MultiplexerScope;
  }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listTmuxPanes) {
      return { success: false as const, error: 'listTmuxPanes unavailable' };
    }
    return bridge.listTmuxPanes(options);
  }, []);

  const listTmuxClients = useCallback(async (options: {
    sessionId: string;
    sessionName?: string;
    scope?: MultiplexerScope;
  }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listTmuxClients) {
      return { success: false as const, error: 'listTmuxClients unavailable' };
    }
    return bridge.listTmuxClients(options);
  }, []);

  const tmuxAction = useCallback(async (options: {
    sessionId: string;
    scope?: MultiplexerScope;
  } & TmuxManageAction) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.tmuxAction) {
      return { success: false as const, error: 'tmuxAction unavailable' };
    }
    return bridge.tmuxAction(options);
  }, []);

  const listDockerContainers = useCallback(async (sessionId: string, runtime?: ContainerRuntimeId) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listDockerContainers) {
      return { success: false as const, error: 'listDockerContainers unavailable' };
    }
    return bridge.listDockerContainers(sessionId, runtime);
  }, []);

  const listDockerImages = useCallback(async (sessionId: string, runtime?: ContainerRuntimeId) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listDockerImages) {
      return { success: false as const, error: 'listDockerImages unavailable' };
    }
    return bridge.listDockerImages(sessionId, runtime);
  }, []);

  const getDockerStats = useCallback(async (options: {
    sessionId: string;
    ids?: string[];
    runtime?: ContainerRuntimeId;
  }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.getDockerStats) {
      return { success: false as const, error: 'getDockerStats unavailable' };
    }
    return bridge.getDockerStats(options);
  }, []);

  const listAccelerators = useCallback(async (sessionId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listAccelerators) {
      return { success: false as const, error: 'listAccelerators unavailable' };
    }
    return bridge.listAccelerators(sessionId);
  }, []);

  const listListeningPorts = useCallback(async (sessionId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listListeningPorts) {
      return { success: false as const, error: 'listListeningPorts unavailable' };
    }
    return bridge.listListeningPorts(sessionId);
  }, []);

  const listSystemServices = useCallback(async (sessionId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listSystemServices) {
      return { success: false as const, error: 'listSystemServices unavailable' };
    }
    return bridge.listSystemServices(sessionId);
  }, []);

  const systemServiceAction = useCallback(async (options: {
    sessionId: string;
    unitName: string;
    action: SystemdUnitAction;
    scope?: SystemdUnitInfo['scope'];
  }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.systemServiceAction) {
      return { success: false as const, error: 'systemServiceAction unavailable' };
    }
    return bridge.systemServiceAction(options);
  }, []);

  const dockerInspect = useCallback(async (options: {
    sessionId: string;
    containerId: string;
    runtime?: ContainerRuntimeId;
  }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.dockerInspect) {
      return { success: false as const, error: 'dockerInspect unavailable' };
    }
    return bridge.dockerInspect(options);
  }, []);

  const dockerImageInspect = useCallback(async (options: {
    sessionId: string;
    imageId: string;
    runtime?: ContainerRuntimeId;
  }) => {
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
    runtime?: ContainerRuntimeId;
  }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.dockerAction) {
      return { success: false as const, error: 'dockerAction unavailable' };
    }
    return bridge.dockerAction(options);
  }, []);

  const dockerImageAction = useCallback(async (options: {
    sessionId: string;
    runtime?: ContainerRuntimeId;
  } & DockerImageManageAction) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.dockerImageAction) {
      return { success: false as const, error: 'dockerImageAction unavailable' };
    }
    return bridge.dockerImageAction(options);
  }, []);

  const kubectl = useCallback(async (options: {
    sessionId: string;
    op: 'contexts' | 'namespaces' | 'pods' | 'delete';
    context?: string;
    namespace?: string;
    pod?: string;
    shell?: string;
  }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.kubectl) {
      return { success: false as const, error: 'kubectl unavailable' };
    }
    return bridge.kubectl(options);
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
    listTmuxSnapshot,
    listMultiplexerUsers,
    listZellijSessions,
    zellijAction,
    createTmuxSession,
    listTmuxWindows,
    listTmuxPanes,
    listTmuxClients,
    tmuxAction,
    listDockerContainers,
    listDockerImages,
    getDockerStats,
    listAccelerators,
    listListeningPorts,
    listSystemServices,
    systemServiceAction,
    dockerInspect,
    dockerImageInspect,
    dockerAction,
    dockerImageAction,
    kubectl,
    openTerminalPopup,
  }), [
    probeSystemCapabilities,
    listSystemProcesses,
    signalSystemProcess,
    listTmuxSessions,
    listTmuxSnapshot,
    listMultiplexerUsers,
    listZellijSessions,
    zellijAction,
    createTmuxSession,
    listTmuxWindows,
    listTmuxPanes,
    listTmuxClients,
    tmuxAction,
    listDockerContainers,
    listDockerImages,
    getDockerStats,
    listAccelerators,
    listListeningPorts,
    listSystemServices,
    systemServiceAction,
    dockerInspect,
    dockerImageInspect,
    dockerAction,
    dockerImageAction,
    kubectl,
    openTerminalPopup,
  ]);
}
