import type { Host } from "./models";

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
