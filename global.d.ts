/// <reference path="./types/global/netcatty-bridge-session.d.ts" />
/// <reference path="./types/global/netcatty-bridge-sftp.d.ts" />
/// <reference path="./types/global/netcatty-bridge-sync.d.ts" />
/// <reference path="./types/global/netcatty-bridge-files.d.ts" />
/// <reference path="./types/global/netcatty-bridge-ai.d.ts" />
/// <reference path="./types/global/netcatty-bridge-app.d.ts" />
declare module "*.cjs" {
  const value: Record<string, unknown>;
  export = value;
}

declare module 'react' {
  interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
    webkitdirectory?: string | boolean;
  }
}

declare global {
  // Proxy configuration for SSH connections
  interface NetcattyProxyConfig {
    type: 'http' | 'socks5';
    host: string;
    port: number;
    username?: string;
    password?: string;
  }

  // Discovered local shell (e.g. CMD, PowerShell, WSL, Git Bash)
  interface DiscoveredShell {
    id: string;
    name: string;
    command: string;
    args?: string[];
    icon: string;
    isDefault?: boolean;
  }

  // Jump host configuration for SSH tunneling
  interface NetcattyJumpHost {
    hostname: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    certificate?: string;
    passphrase?: string;
    publicKey?: string;
    keyId?: string;
    keySource?: 'generated' | 'imported' | 'reference';
    label?: string; // Display label for UI
    proxy?: NetcattyProxyConfig;
    identityFilePaths?: string[];
    // Resolved keepalive for THIS hop (caller has already applied host
    // override / global fallback). interval in seconds, 0 = disabled.
    keepaliveInterval?: number;
    keepaliveCountMax?: number;
    // Per-hop algorithm settings, mirroring the target-host fields. When
    // omitted the bridge falls back to the target host's settings so a
    // single setting on the leaf still covers the chain (matches the
    // pre-existing behavior of `legacyAlgorithms`).
    legacyAlgorithms?: boolean;
    skipEcdsaHostKey?: boolean;
    algorithmOverrides?: import("./domain/models").HostAlgorithmOverrides;
  }

  // Host key information for verification
  // Reserved for future host key verification UI feature
  interface _NetcattyHostKeyInfo {
    hostname: string;
    port: number;
    keyType: string;
    fingerprint: string;
    publicKey?: string;
  }

  interface NetcattySSHOptions {
    sessionId?: string;
    hostLabel?: string;
    hostname: string;
    username: string;
    port?: number;
    password?: string;
    privateKey?: string;
    // Optional OpenSSH user certificate
    certificate?: string;
    publicKey?: string; // OpenSSH public key line
    keyId?: string;
    keySource?: 'generated' | 'imported' | 'reference';
    agentForwarding?: boolean;
    x11Forwarding?: boolean;
    x11Display?: string;
    cols?: number;
    rows?: number;
    charset?: string;
    extraArgs?: string[];
    startupCommand?: string;
    passphrase?: string;
    knownHosts?: import("./domain/models").KnownHost[];
    // Environment variables to set in the remote shell
    env?: Record<string, string>;
    // Proxy configuration
    proxy?: NetcattyProxyConfig;
    // Jump hosts (bastion chain)
    jumpHosts?: NetcattyJumpHost[];
    // SSH-level keepalive interval in seconds (0 = disabled)
    keepaliveInterval?: number;
    // Unanswered keepalives before ssh2 declares the connection dead
    keepaliveCountMax?: number;
    // Enable legacy SSH algorithms for older network equipment
    legacyAlgorithms?: boolean;
    // Drop ecdsa-sha2-* from offered host-key algorithms (#1027)
    skipEcdsaHostKey?: boolean;
    // Per-category algorithm override lists (advanced, see HostAlgorithmOverrides)
    algorithmOverrides?: import("./domain/models").HostAlgorithmOverrides;
    // Use sudo for SFTP server
    sudo?: boolean;
    // Session log configuration for real-time streaming
    sessionLog?: { enabled: boolean; directory: string; format: string };
    // Local SSH key file paths (from SSH config IdentityFile)
    identityFilePaths?: string[];
  }

  interface SftpStatResult {
    name: string;
    type: 'file' | 'directory' | 'symlink';
    size: number;
    lastModified: number; // timestamp
    permissions?: string; // e.g., "rwxr-xr-x"
    owner?: string;
    group?: string;
  }

  interface SftpTransferProgress {
    transferId: string;
    bytesTransferred: number;
    totalBytes: number;
    speed: number; // bytes per second
  }

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
    port?: number;
    username: string;
    password?: string;
    privateKey?: string;
    certificate?: string;
    keyId?: string;
    passphrase?: string;
    proxy?: NetcattyProxyConfig;
    jumpHosts?: NetcattyJumpHost[];
    identityFilePaths?: string[];
    legacyAlgorithms?: boolean;
    skipEcdsaHostKey?: boolean;
    algorithmOverrides?: import("./domain/models").HostAlgorithmOverrides;
    // Resolved keepalive for the target connection (caller has already
    // applied host override / global fallback). interval in seconds.
    keepaliveInterval?: number;
    keepaliveCountMax?: number;
  }

  interface PortForwardResult {
    tunnelId: string;
    success: boolean;
    cancelled?: boolean;
    error?: string;
  }

  interface PortForwardStatusResult {
    tunnelId: string;
    status: 'inactive' | 'connecting' | 'active' | 'error';
    type?: 'local' | 'remote' | 'dynamic';
    error?: string;
  }

  interface NetcattyWindowsPtyInfo {
    backend: 'conpty' | 'winpty';
    buildNumber?: number;
  }

  type PortForwardStatusCallback = (status: 'inactive' | 'connecting' | 'active' | 'error', error?: string) => void;

  interface NetcattyBridge {}

  interface Window {
    netcatty?: NetcattyBridge;
  }

}

export { };
