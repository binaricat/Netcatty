
declare global {
  interface NetcattyBridge {
    probeSystemCapabilities?(sessionId: string): Promise<{
      success: boolean;
      pending?: boolean;
      error?: string;
      capabilities?: import("../../domain/systemManager/types").SessionCapabilities;
    }>;
    listSystemProcesses?(sessionId: string): Promise<{
      success: boolean;
      pending?: boolean;
      error?: string;
      processes?: import("../../domain/systemManager/types").SystemProcessInfo[];
    }>;
    signalSystemProcess?(options: {
      sessionId: string;
      pid: number;
      signal?: string;
      nice?: number;
    }): Promise<{ success: boolean; pending?: boolean; error?: string; code?: number }>;
    setupOsc7Tracking?(sessionId: string, command: string): Promise<{
      success: boolean;
      pending?: boolean;
      stdout?: string;
      stderr?: string;
      code?: number | null;
      error?: string;
    }>;
    listTmuxSessions?(
      sessionId: string,
      scope?: import("../../domain/systemManager/types").MultiplexerScope,
    ): Promise<{
      success: boolean;
      error?: string;
      errorCode?: string;
      tmuxVersion?: string;
      sessions?: import("../../domain/systemManager/types").TmuxSessionInfo[];
    }>;
    listTmuxSnapshot?(
      sessionId: string,
      scope?: import("../../domain/systemManager/types").MultiplexerScope,
    ): Promise<{
      success: boolean;
      error?: string;
      errorCode?: string;
      tmuxVersion?: string;
      sessions?: import("../../domain/systemManager/types").TmuxSessionInfo[];
      windowsBySession?: Record<string, import("../../domain/systemManager/types").TmuxWindowInfo[]>;
      clients?: import("../../domain/systemManager/types").TmuxClientInfo[];
    }>;
    listMultiplexerUsers?(sessionId: string): Promise<{
      success: boolean;
      pending?: boolean;
      error?: string;
      currentUser?: string;
      currentUid?: number;
      users?: import("../../domain/systemManager/types").MultiplexerUser[];
    }>;
    listZellijSessions?(
      sessionId: string,
      scope?: import("../../domain/systemManager/types").MultiplexerScope,
    ): Promise<{
      success: boolean;
      error?: string;
      errorCode?: string;
      sessions?: import("../../domain/systemManager/types").ZellijSessionInfo[];
    }>;
    zellijAction?(options: {
      sessionId: string;
      scope?: import("../../domain/systemManager/types").MultiplexerScope;
    } & import("../../domain/systemManager/types").ZellijManageAction): Promise<{
      success: boolean;
      error?: string;
      errorCode?: string;
    }>;
    createTmuxSession?(options: {
      sessionId: string;
      name: string;
      command?: string;
      scope?: import("../../domain/systemManager/types").MultiplexerScope;
    }): Promise<{
      success: boolean;
      error?: string;
      errorCode?: string;
      name?: string;
    }>;
    listTmuxWindows?(options: {
      sessionId: string;
      sessionName: string;
      scope?: import("../../domain/systemManager/types").MultiplexerScope;
    }): Promise<{
      success: boolean;
      error?: string;
      errorCode?: string;
      debug?: {
        lastOutput?: string;
        tried?: string[];
        sockets?: Array<string | null>;
      };
      windows?: import("../../domain/systemManager/types").TmuxWindowInfo[];
    }>;
    listTmuxPanes?(options: {
      sessionId: string;
      sessionName: string;
      windowIndex: number;
      scope?: import("../../domain/systemManager/types").MultiplexerScope;
    }): Promise<{
      success: boolean;
      error?: string;
      errorCode?: string;
      debug?: {
        lastOutput?: string;
        tried?: string[];
        sockets?: Array<string | null>;
      };
      panes?: import("../../domain/systemManager/types").TmuxPaneInfo[];
    }>;
    listTmuxClients?(options: {
      sessionId: string;
      sessionName?: string;
      scope?: import("../../domain/systemManager/types").MultiplexerScope;
    }): Promise<{
      success: boolean;
      error?: string;
      errorCode?: string;
      clients?: import("../../domain/systemManager/types").TmuxClientInfo[];
    }>;
    tmuxAction?(options: {
      sessionId: string;
      scope?: import("../../domain/systemManager/types").MultiplexerScope;
    } & import("../../domain/systemManager/types").TmuxManageAction): Promise<{
      success: boolean;
      error?: string;
      errorCode?: string;
    }>;
    listDockerContainers?(
      sessionId: string,
      runtime?: import("../../domain/systemManager/containerRuntime").ContainerRuntimeId,
    ): Promise<{
      success: boolean;
      error?: string;
      errorCode?: string;
      containers?: import("../../domain/systemManager/types").DockerContainerInfo[];
    }>;
    listDockerImages?(
      sessionId: string,
      runtime?: import("../../domain/systemManager/containerRuntime").ContainerRuntimeId,
    ): Promise<{
      success: boolean;
      error?: string;
      errorCode?: string;
      images?: import("../../domain/systemManager/types").DockerImageInfo[];
    }>;
    getDockerStats?(options: {
      sessionId: string;
      ids?: string[];
      runtime?: import("../../domain/systemManager/containerRuntime").ContainerRuntimeId;
    }): Promise<{
      success: boolean;
      error?: string;
      errorCode?: string;
      stats?: import("../../domain/systemManager/types").DockerStatInfo[];
    }>;
    listAccelerators?(sessionId: string): Promise<{
      success: boolean;
      pending?: boolean;
      error?: string;
      devices?: import("../../domain/systemManager/types").AcceleratorDeviceInfo[];
      processes?: import("../../domain/systemManager/types").AcceleratorProcessInfo[];
      nvidiaDriverVersion?: string | null;
      probedAt?: number;
    }>;
    listListeningPorts?(sessionId: string): Promise<{
      success: boolean;
      pending?: boolean;
      error?: string;
      ports?: import("../../domain/systemManager/types").ListeningPortInfo[];
    }>;
    listSystemServices?(sessionId: string): Promise<{
      success: boolean;
      pending?: boolean;
      error?: string;
      units?: import("../../domain/systemManager/types").SystemdUnitInfo[];
    }>;
    systemServiceAction?(options: {
      sessionId: string;
      unitName: string;
      action: import("../../domain/systemManager/types").SystemdUnitAction;
      scope?: import("../../domain/systemManager/types").SystemdUnitInfo['scope'];
    }): Promise<{ success: boolean; pending?: boolean; error?: string }>;
    dockerInspect?(options: {
      sessionId: string;
      containerId: string;
      runtime?: import("../../domain/systemManager/containerRuntime").ContainerRuntimeId;
    }): Promise<{
      success: boolean;
      error?: string;
      errorCode?: string;
      inspect?: Record<string, unknown>;
    }>;
    dockerImageInspect?(options: {
      sessionId: string;
      imageId: string;
      runtime?: import("../../domain/systemManager/containerRuntime").ContainerRuntimeId;
    }): Promise<{
      success: boolean;
      error?: string;
      errorCode?: string;
      inspect?: Record<string, unknown>;
    }>;
    dockerAction?(options: {
      sessionId: string;
      containerId: string;
      action: import("../../domain/systemManager/types").DockerContainerAction;
      newName?: string;
      runtime?: import("../../domain/systemManager/containerRuntime").ContainerRuntimeId;
    }): Promise<{ success: boolean; error?: string; errorCode?: string }>;
    dockerImageAction?(options: {
      sessionId: string;
      runtime?: import("../../domain/systemManager/containerRuntime").ContainerRuntimeId;
    } & import("../../domain/systemManager/types").DockerImageManageAction): Promise<{
      success: boolean;
      error?: string;
      errorCode?: string;
      output?: string;
    }>;
    kubectl?(options: {
      sessionId: string;
      op: "contexts" | "namespaces" | "pods" | "delete";
      context?: string;
      namespace?: string;
      pod?: string;
      shell?: string;
    }): Promise<{
      success: boolean;
      error?: string;
      errorCode?: string;
      contexts?: import("../../domain/systemManager/containerRuntime").KubeContextInfo[];
      current?: string;
      namespaces?: string[];
      pods?: import("../../domain/systemManager/containerRuntime").KubectlPodInfo[];
    }>;
    openTerminalPopup?(payload: import("../../domain/systemManager/types").TerminalPopupPayload): Promise<{
      success: boolean;
      error?: string;
      popupId?: string;
    }>;
    logDiagnostic?(payload: {
      source: string;
      message: string;
      extra?: Record<string, unknown>;
    }): Promise<{ success: boolean; error?: string }>;
    onTerminalPopupConfig?(cb: (payload: import("../../domain/systemManager/types").TerminalPopupPayload) => void): () => void;
  }
}

export {};
