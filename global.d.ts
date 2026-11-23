/// <reference path="./types/global/netcatty-bridge-session.d.ts" />
/// <reference path="./types/global/netcatty-bridge-sftp.d.ts" />
/// <reference path="./types/global/netcatty-bridge-sync.d.ts" />
/// <reference path="./types/global/netcatty-bridge-files.d.ts" />
/// <reference path="./types/global/netcatty-bridge-ai.d.ts" />
/// <reference path="./types/global/netcatty-bridge-app.d.ts" />
/// <reference path="./types/global/netcatty-bridge-system.d.ts" />
/// <reference path="./types/global/netcatty-bridge-script.d.ts" />
/// <reference path="./types/global/netcatty-bridge-portforward.d.ts" />
/// <reference path="./types/global/netcatty-bridge-plugin.d.ts" />
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
    type: 'http' | 'socks5' | 'command';
    host: string;
    port: number;
    command?: string;
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

  interface NetcattyTotpConfig {
    uri: string;
    autoSubmit?: boolean;
    promptPattern?: string;
  }

  // Jump host configuration for SSH tunneling
  interface NetcattyJumpHost {
    hostname: string;
    hostId?: string;
    port: number;
    username: string;
    authMethod?: import("./domain/models").HostAuthMethod;
    requiresMfa?: boolean;
    password?: string;
    totp?: NetcattyTotpConfig;
    privateKey?: string;
    certificate?: string;
    passphrase?: string;
    publicKey?: string;
    keyId?: string;
    keySource?: 'generated' | 'imported' | 'reference';
    label?: string; // Display label for UI
    proxy?: NetcattyProxyConfig;
    identityFilePaths?: string[];
    useSshAgent?: boolean;
    agentPublicKeys?: string[];
    identityAgent?: string;
    identitiesOnly?: boolean;
    addKeysToAgent?: string;
    useKeychain?: boolean;
    // ET server port on this hop, used only when ET tunnels through it as a
    // jump host (--jport). Defaults to 2022 in the bridge when omitted.
    etPort?: number;
    // Resolved keepalive for THIS hop (caller has already applied host
    // override / global fallback). interval in seconds, 0 = disabled.
    keepaliveInterval?: number;
    keepaliveCountMax?: number;
    // Per-hop SSH connection timeouts, resolved from the saved host.
    sshTcpConnectTimeoutMs?: number;
    sshAuthReadyTimeoutMs?: number;
    verifyHostKeys?: boolean;
    // Per-hop algorithm settings, mirroring the target-host fields. When
    // omitted the bridge falls back to the target host's settings so a
    // single setting on the leaf still covers the chain (matches the
    // pre-existing behavior of `legacyAlgorithms`).
    legacyAlgorithms?: boolean;
    skipEcdsaHostKey?: boolean;
    algorithmOverrides?: import("./domain/models").HostAlgorithmOverrides;
  }

  interface NetcattySSHOptions {
    keyLabel?: string;
    sessionId?: string;
    hostId?: string;
    hostLabel?: string;
    hostname: string;
    username: string;
    authMethod?: import("./domain/models").HostAuthMethod;
    requiresMfa?: boolean;
    port?: number;
    password?: string;
    totp?: NetcattyTotpConfig;
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
    verifyHostKeys?: boolean;
    /**
     * When true, an untrusted host key fails the dial instead of waiting for
     * a renderer prompt. Transfer opens set this: their session id is not the
     * SFTP page's host-key dialog, so an unanswered prompt leaves the upload
     * on "Waiting...".
     */
    hostKeyUnattended?: boolean;
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
    // Maximum time to establish the TCP connection
    sshTcpConnectTimeoutMs?: number;
    // Maximum time for SSH handshake and authentication
    sshAuthReadyTimeoutMs?: number;
    // Enable legacy SSH algorithms for older network equipment
    legacyAlgorithms?: boolean;
    // Drop ecdsa-sha2-* from offered host-key algorithms (#1027)
    skipEcdsaHostKey?: boolean;
    // Per-category algorithm override lists (advanced, see HostAlgorithmOverrides)
    algorithmOverrides?: import("./domain/models").HostAlgorithmOverrides;
    // Use sudo for SFTP server
    sudo?: boolean;
    // Remote file protocol: auto (SFTP then SCP fallback) | sftp | scp
    fileProtocol?: 'auto' | 'sftp' | 'scp';
    // Saved host password used by background system tools when they need sudo.
    sudoAutofillPassword?: string;
    // Session log configuration for real-time streaming
    sessionLog?: { enabled: boolean; directory: string; format: string; timestampsEnabled?: boolean };
    // SSH connection diagnostics. Does not capture terminal output.
    sshDebugLogEnabled?: boolean;
    // Boot generation for correlating host-key prompts with a terminal start.
    bootEpoch?: number;
    // Local SSH key file paths (from SSH config IdentityFile)
    identityFilePaths?: string[];
    useSshAgent?: boolean;
    agentPublicKeys?: string[];
    identityAgent?: string;
    identitiesOnly?: boolean;
    addKeysToAgent?: string;
    useKeychain?: boolean;
    // When set, reuse the already-authenticated SSH connection of this existing
    // session by opening a new shell channel on it, instead of dialing a fresh
    // connection. Lets a duplicated tab skip a second MFA prompt (issue #1204).
    // The bridge falls back to a fresh connection if the source is gone.
    sourceSessionId?: string;
    /** Require openSftpForSession to use exactly the requested live session. */
    requireExactSourceSession?: boolean;
    /** Use the named live terminal only; never open a dedicated/fresh login. */
    reuseExactSessionOnly?: boolean;
    // Skip POSIX process discovery when copying a network-device session.
    skipShellPidDiscovery?: boolean;
    /**
     * When false, terminal/SFTP opens must dial a fresh SSH connection and
     * must not borrow a live, parked, or in-flight registry transport. Used by
     * connect-time terminal automation and dedicated bulk transfers.
     * Default true (normal terminal, browse, and MFA-skip reuse).
     */
    reuseTransport?: boolean;
    /** Runtime stamp for one session channel on this TCP. Set after a recognized bastion banner, not from saved host settings. */
    singleChannelSsh?: boolean;
    /** Original unsaved-password profile; main retains only its digest for live SFTP borrowing. */
    sftpReuseOptions?: NetcattySSHOptions;
  }

  interface SftpStatResult {
    name: string;
    type: 'file' | 'directory' | 'symlink';
    size: number;
    /** False when the endpoint cannot report a size (stat-less SCP); size is a placeholder 0. */
    sizeKnown?: boolean;
    lastModified: number; // timestamp
    permissions?: string; // e.g., "rwxr-xr-x"
    owner?: string;
    group?: string;
    /** Local-only filesystem identity; undefined for remote SFTP stats. */
    dev?: number;
    ino?: number;
  }

  interface NetcattyWindowsPtyInfo {
    backend: 'conpty' | 'winpty';
    buildNumber?: number;
  }

  interface Window {
    netcatty?: NetcattyBridge;
  }

}

export { };
