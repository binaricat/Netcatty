import { resolveInteractiveTerminalCdIntent } from "./sessionRestore";

export type LocateSftpPathInTerminalContext = {
  path?: string | null;
  sessionId?: string | null;
  sessionStatus?: string | null;
  sessionHostId?: string | null;
  sftpHostId?: string | null;
  sftpIsLocal?: boolean;
  protocol?: string | null;
  shellType?: string | null;
  isNetworkDevice?: boolean;
  moshEnabled?: boolean;
  etEnabled?: boolean;
  sessionHostname?: string | null;
  sessionUsername?: string | null;
  sessionPort?: number | null;
  sftpHostname?: string | null;
  sftpUsername?: string | null;
  sftpPort?: number | null;
};

/**
 * Prefer the SFTP-reusable SSH session id when present; otherwise use the
 * focused terminal (mosh/et/local) so locate is not stuck behind connection reuse.
 */
export function resolveLocateSftpPathSessionId(options: {
  activeSessionId?: string | null;
  focusedSessionId?: string | null;
}): string | null {
  return options.activeSessionId ?? options.focusedSessionId ?? null;
}

function remoteEndpointsMatch(options: LocateSftpPathInTerminalContext): boolean {
  if (!options.sessionHostname || !options.sftpHostname) return true;
  return options.sessionHostname === options.sftpHostname
    && (options.sessionPort ?? 22) === (options.sftpPort ?? 22)
    && (options.sessionUsername || "root") === (options.sftpUsername || "root");
}

/** Whether the SFTP current path can be sent as `cd` to the linked terminal. */
export function canLocateSftpPathInTerminal(
  options: LocateSftpPathInTerminalContext,
): boolean {
  if (!options.sessionId || options.sessionStatus !== "connected") return false;
  if (options.isNetworkDevice) return false;
  if (!resolveInteractiveTerminalCdIntent(options.path)) return false;

  const protocol = options.protocol ?? "ssh";
  if (protocol === "telnet" || protocol === "serial") return false;
  if (protocol === "local" && (options.shellType === "powershell" || options.shellType === "cmd")) {
    return false;
  }

  if (options.sftpIsLocal) {
    return protocol === "local";
  }

  if (!options.sftpHostId || !options.sessionHostId) return false;
  if (options.sftpHostId !== options.sessionHostId) return false;
  if (!remoteEndpointsMatch(options)) return false;

  // Interactive locate allows mosh/et (unlike silent restore). Accept both the
  // transport protocol strings and ssh+flag forms used by session factories.
  return protocol === "ssh"
    || protocol === "mosh"
    || protocol === "et"
    || protocol === "local";
}

/** Session write payload for locating the SFTP path in the linked terminal. */
export function resolveLocateSftpPathInTerminalAction(
  options: LocateSftpPathInTerminalContext,
): { sessionId: string; data: string } | null {
  if (!canLocateSftpPathInTerminal(options) || !options.sessionId) return null;
  const intent = resolveInteractiveTerminalCdIntent(options.path);
  if (!intent) return null;
  return { sessionId: options.sessionId, data: `${intent.command}\r` };
}
