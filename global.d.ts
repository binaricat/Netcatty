import type { TerminalSession, RemoteFile } from "./types";

interface NebulaSSHOptions {
  sessionId?: string;
  hostname: string;
  username: string;
  port?: number;
  password?: string;
  privateKey?: string;
  keyId?: string;
  agentForwarding?: boolean;
  cols?: number;
  rows?: number;
  charset?: string;
  extraArgs?: string[];
}

interface NebulaBridge {
  startSSHSession(options: NebulaSSHOptions): Promise<string>;
  startLocalSession?(options: { sessionId?: string; cols?: number; rows?: number; shell?: string; env?: Record<string, string> }): Promise<string>;
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
  openSftp(options: NebulaSSHOptions): Promise<string>;
  listSftp(sftpId: string, path: string): Promise<RemoteFile[]>;
  readSftp(sftpId: string, path: string): Promise<string>;
  writeSftp(sftpId: string, path: string, content: string): Promise<void>;
  closeSftp(sftpId: string): Promise<void>;
  mkdirSftp(sftpId: string, path: string): Promise<void>;
}

declare global {
  interface Window {
    nebula?: NebulaBridge;
  }
}

export {};
