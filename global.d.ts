import type { RemoteFile } from "./types";

declare global {
// Proxy configuration for SSH connections
interface NetcattyProxyConfig {
  type: 'http' | 'socks5';
  host: string;
  port: number;
  username?: string;
  password?: string;
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
  // WebAuthn-backed keys (optional)
  publicKey?: string;
  credentialId?: string;
  rpId?: string;
  userVerification?: 'required' | 'preferred' | 'discouraged';
  keyId?: string;
  keySource?: 'generated' | 'imported' | 'biometric' | 'fido2';
  label?: string; // Display label for UI
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
  hostname: string;
  username: string;
  port?: number;
  password?: string;
  privateKey?: string;
  // Optional OpenSSH user certificate (ssh-*-cert-v01@openssh.com ...)
  certificate?: string;
  // WebAuthn-backed keys (Windows Hello / Touch ID / FIDO2)
  publicKey?: string; // OpenSSH public key line (e.g., sk-ecdsa-sha2-nistp256@openssh.com ...)
  credentialId?: string; // base64url
  rpId?: string;
  userVerification?: 'required' | 'preferred' | 'discouraged';
  keyId?: string;
  keySource?: 'generated' | 'imported' | 'biometric' | 'fido2';
  agentForwarding?: boolean;
  cols?: number;
  rows?: number;
  charset?: string;
  extraArgs?: string[];
  startupCommand?: string;
  passphrase?: string;
  // Environment variables to set in the remote shell
  env?: Record<string, string>;
  // Proxy configuration
  proxy?: NetcattyProxyConfig;
  // Jump hosts (bastion chain)
  jumpHosts?: NetcattyJumpHost[];
}

interface WebAuthnBrowserCreateOptions {
  rpId: string;
  name: string;
  displayName: string;
  authenticatorAttachment?: 'platform' | 'cross-platform';
  userVerification?: 'required' | 'preferred' | 'discouraged';
  timeoutMs?: number;
}

interface WebAuthnBrowserCreateResult {
  rpId: string;
  origin: string;
  credentialId: string; // base64url
  attestationObject: string; // base64url
  clientDataJSON: string; // base64url
  publicKeySpki: string; // base64url (may be empty)
}

interface WebAuthnBrowserGetOptions {
  rpId: string;
  credentialId: string; // base64url
  challenge: string; // base64url
  userVerification?: 'required' | 'preferred' | 'discouraged';
  timeoutMs?: number;
}

interface WebAuthnBrowserGetResult {
  rpId: string;
  origin: string;
  credentialId: string; // base64url
  authenticatorData: string; // base64url
  clientDataJSON: string; // base64url
  signature: string; // base64url
  userHandle: string | null; // base64url
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
}

interface PortForwardResult {
  tunnelId: string;
  success: boolean;
  error?: string;
}

interface PortForwardStatusResult {
  tunnelId: string;
  status: 'inactive' | 'connecting' | 'active' | 'error';
  type?: 'local' | 'remote' | 'dynamic';
  error?: string;
}

type PortForwardStatusCallback = (status: 'inactive' | 'connecting' | 'active' | 'error', error?: string) => void;

interface NetcattyBridge {
  startSSHSession(options: NetcattySSHOptions): Promise<string>;
  startTelnetSession?(options: {
    sessionId?: string;
    hostname: string;
    port?: number;
    cols?: number;
    rows?: number;
    charset?: string;
    env?: Record<string, string>;
  }): Promise<string>;
  startMoshSession?(options: {
    sessionId?: string;
    hostname: string;
    username?: string;
    port?: number;
    moshServerPath?: string;
    agentForwarding?: boolean;
    cols?: number;
    rows?: number;
    charset?: string;
    env?: Record<string, string>;
  }): Promise<string>;
  startLocalSession?(options: { sessionId?: string; cols?: number; rows?: number; shell?: string; env?: Record<string, string> }): Promise<string>;
  generateKeyPair?(options: {
    type: 'RSA' | 'ECDSA' | 'ED25519';
    bits?: number;
    comment?: string;
  }): Promise<{ success: boolean; privateKey?: string; publicKey?: string; error?: string }>;
  execCommand(options: {
    hostname: string;
    username: string;
    port?: number;
    password?: string;
    privateKey?: string;
    command: string;
    timeout?: number;
  }): Promise<{ stdout: string; stderr: string; code: number | null }>;
  writeToSession(sessionId: string, data: string): void;
  resizeSession(sessionId: string, cols: number, rows: number): void;
  closeSession(sessionId: string): void;
  onSessionData(sessionId: string, cb: (data: string) => void): () => void;
  onSessionExit(
    sessionId: string,
    cb: (evt: { exitCode?: number; signal?: number }) => void
  ): () => void;
  onAuthFailed?(
    sessionId: string,
    cb: (evt: { sessionId: string; error: string; hostname: string }) => void
  ): () => void;
  
  // SFTP operations
  openSftp(options: NetcattySSHOptions): Promise<string>;
  listSftp(sftpId: string, path: string): Promise<RemoteFile[]>;
  readSftp(sftpId: string, path: string): Promise<string>;
  readSftpBinary?(sftpId: string, path: string): Promise<ArrayBuffer>;
  writeSftp(sftpId: string, path: string, content: string): Promise<void>;
  writeSftpBinary?(sftpId: string, path: string, content: ArrayBuffer): Promise<void>;
  closeSftp(sftpId: string): Promise<void>;
  mkdirSftp(sftpId: string, path: string): Promise<void>;
  deleteSftp?(sftpId: string, path: string): Promise<void>;
  renameSftp?(sftpId: string, oldPath: string, newPath: string): Promise<void>;
  statSftp?(sftpId: string, path: string): Promise<SftpStatResult>;
  chmodSftp?(sftpId: string, path: string, mode: string): Promise<void>;
  
  // Write binary with real-time progress callback
  writeSftpBinaryWithProgress?(
    sftpId: string, 
    path: string, 
    content: ArrayBuffer, 
    transferId: string,
    onProgress?: (transferred: number, total: number, speed: number) => void,
    onComplete?: () => void,
    onError?: (error: string) => void
  ): Promise<{ success: boolean; transferId: string }>;
  
  // Transfer with progress
  uploadFile?(sftpId: string, localPath: string, remotePath: string, transferId: string): Promise<void>;
  downloadFile?(sftpId: string, remotePath: string, localPath: string, transferId: string): Promise<void>;
  cancelTransfer?(transferId: string): Promise<void>;
  onTransferProgress?(transferId: string, cb: (progress: SftpTransferProgress) => void): () => void;
  
  // Streaming transfer with real progress and cancellation
  startStreamTransfer?(
    options: {
      transferId: string;
      sourcePath: string;
      targetPath: string;
      sourceType: 'local' | 'sftp';
      targetType: 'local' | 'sftp';
      sourceSftpId?: string;
      targetSftpId?: string;
      totalBytes?: number;
    },
    onProgress?: (transferred: number, total: number, speed: number) => void,
    onComplete?: () => void,
    onError?: (error: string) => void
  ): Promise<{ transferId: string; totalBytes?: number; error?: string }>;
  
  // Local filesystem operations
  listLocalDir?(path: string): Promise<RemoteFile[]>;
  readLocalFile?(path: string): Promise<ArrayBuffer>;
  writeLocalFile?(path: string, content: ArrayBuffer): Promise<void>;
  deleteLocalFile?(path: string): Promise<void>;
  renameLocalFile?(oldPath: string, newPath: string): Promise<void>;
  mkdirLocal?(path: string): Promise<void>;
  statLocal?(path: string): Promise<SftpStatResult>;
  getHomeDir?(): Promise<string>;
  getSystemInfo?(): Promise<{ username: string; hostname: string }>;
  
  setTheme?(theme: 'light' | 'dark'): Promise<boolean>;
  // Window controls for custom title bar (Windows/Linux)
  windowMinimize?(): Promise<void>;
  windowMaximize?(): Promise<boolean>;
  windowClose?(): Promise<void>;
  windowIsMaximized?(): Promise<boolean>;
  
  // Settings window
  openSettingsWindow?(): Promise<boolean>;
  closeSettingsWindow?(): Promise<void>;
  
  // Port Forwarding
  startPortForward?(options: PortForwardOptions): Promise<PortForwardResult>;
  stopPortForward?(tunnelId: string): Promise<PortForwardResult>;
  getPortForwardStatus?(tunnelId: string): Promise<PortForwardStatusResult>;
  listPortForwards?(): Promise<{ tunnelId: string; type: string; status: string }[]>;
  onPortForwardStatus?(tunnelId: string, cb: PortForwardStatusCallback): () => void;
  
  // Known Hosts
  readKnownHosts?(): Promise<string | null>;
  
  // Open URL in default browser
  openExternal?(url: string): Promise<void>;

  // WebAuthn browser fallback helpers
  webauthnCreateCredentialInBrowser?(options: WebAuthnBrowserCreateOptions): Promise<WebAuthnBrowserCreateResult>;
  webauthnGetAssertionInBrowser?(options: WebAuthnBrowserGetOptions): Promise<WebAuthnBrowserGetResult>;
  
  // Chain progress listener for jump host connections
  // Callback receives: (currentHop: number, totalHops: number, hostLabel: string, status: string)
  onChainProgress?(cb: (hop: number, total: number, label: string, status: string) => void): () => void;
  
  // OAuth callback server for cloud sync
  startOAuthCallback?(expectedState?: string): Promise<{ code: string; state?: string }>;
  cancelOAuthCallback?(): Promise<void>;
}

interface Window {
  netcatty?: NetcattyBridge;
}

}

export { };
