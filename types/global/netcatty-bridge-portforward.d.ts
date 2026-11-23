declare global {
  // Port Forwarding Types
  interface PortForwardOptions {
    ruleId?: string;
    tunnelId: string;
    type: 'local' | 'remote' | 'dynamic';
    localPort: number;
    bindAddress?: string;
    remoteHost?: string;
    remotePort?: number;
    // SSH connection details
    hostname: string;
    hostId?: string;
    port?: number;
    username: string;
    authMethod?: import("./domain/models").HostAuthMethod;
    requiresMfa?: boolean;
    password?: string;
    totp?: NetcattyTotpConfig;
    privateKey?: string;
    certificate?: string;
    keyId?: string;
    passphrase?: string;
    knownHosts?: import("./domain/models").KnownHost[];
    verifyHostKeys?: boolean;
    proxy?: NetcattyProxyConfig;
    jumpHosts?: NetcattyJumpHost[];
    identityFilePaths?: string[];
    useSshAgent?: boolean;
    agentPublicKeys?: string[];
    identityAgent?: string;
    identitiesOnly?: boolean;
    addKeysToAgent?: string;
    useKeychain?: boolean;
    legacyAlgorithms?: boolean;
    skipEcdsaHostKey?: boolean;
    algorithmOverrides?: import("./domain/models").HostAlgorithmOverrides;
    // Resolved keepalive for the target connection (caller has already
    // applied host override / global fallback). interval in seconds.
    keepaliveInterval?: number;
    keepaliveCountMax?: number;
    sshTcpConnectTimeoutMs?: number;
    sshAuthReadyTimeoutMs?: number;
    reuseTransport?: boolean;
  }

  interface PortForwardResult {
    tunnelId: string;
    success: boolean;
    localPort?: number;
    cancelled?: boolean;
    blockedByCleanup?: boolean;
    reused?: boolean;
    status?: 'inactive' | 'connecting' | 'active' | 'error';
    error?: string;
  }

  interface PortForwardStatusResult {
    tunnelId: string;
    status: 'inactive' | 'connecting' | 'active' | 'error';
    type?: 'local' | 'remote' | 'dynamic';
    error?: string;
  }

  type PortForwardRuntimePhase =
    | 'connecting'
    | 'active'
    | 'stopping'
    | 'error'
    | 'inactive';

  interface PortForwardRuntimeRecord {
    ruleId?: string;
    tunnelId: string;
    phase: PortForwardRuntimePhase | string;
    error?: string;
    cleanupRequired?: boolean;
    revision: number;
    updatedAt: number;
  }

  interface PortForwardRuntimeSnapshot {
    epoch: string;
    revision: number;
    records: PortForwardRuntimeRecord[];
  }

  type PortForwardRuntimeEvent =
    | {
        epoch: string;
        revision: number;
        kind: 'upsert';
        record: PortForwardRuntimeRecord;
      }
    | {
        epoch: string;
        revision: number;
        kind: 'remove';
        tunnelId: string;
        ruleId?: string;
      };


  type PortForwardStatusCallback = (status: 'inactive' | 'connecting' | 'active' | 'error', error?: string) => void;
  type PortForwardRuntimeEventCallback = (event: PortForwardRuntimeEvent) => void;

}

export {};
