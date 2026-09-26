import type { Host } from "./models";

/** Compare the selected SFTP target, including the temporary login identity. */
export function isSameSftpHostSelection(left: Host | null | undefined, right: Host | null | undefined): boolean {
  if (!left || !right) return false;
  return left.id === right.id
    && left.hostname === right.hostname
    && left.port === right.port
    && left.protocol === right.protocol
    && left.username === right.username
    && left.identityId === right.identityId
    && left.sftpSudo === right.sftpSudo
    && (left.sftpFileProtocol || "auto") === (right.sftpFileProtocol || "auto");
}

/** Keep a terminal's authenticated identity when its SFTP panel follows that terminal. */
export function resolveTerminalSftpHost({
  sessionHost,
  storedHost,
  authenticatedHost,
  followsTerminal,
}: {
  sessionHost?: Host | null;
  storedHost?: Host | null;
  authenticatedHost?: Host | null;
  followsTerminal: boolean;
}): Host | null {
  if (followsTerminal && sessionHost && authenticatedHost
    && authenticatedHost.id === sessionHost.id
    && authenticatedHost.hostname === sessionHost.hostname
    && (authenticatedHost.port || 22) === (sessionHost.port || 22)) {
    return authenticatedHost;
  }
  return sessionHost ?? storedHost ?? null;
}
