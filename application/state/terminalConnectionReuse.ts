import type { TerminalSession } from "../../domain/models";

type SftpReuseCandidate = Pick<
  TerminalSession,
  "protocol" | "moshEnabled" | "etEnabled"
>;

/** SSH (non-mosh/et) sessions that can back SFTP once the transport is up. */
export function isTerminalSessionEligibleForSftpReuse(session: SftpReuseCandidate): boolean {
  return (
    (session.protocol === "ssh" || session.protocol === undefined)
    && !session.moshEnabled
    && !session.etEnabled
  );
}

export function resolveSftpReuseSourceSessionId(
  session: SftpReuseCandidate,
  sessionId: string,
): string | undefined {
  return isTerminalSessionEligibleForSftpReuse(session)
    ? sessionId
    : undefined;
}

export function canReuseTerminalConnection(session: TerminalSession): boolean {
  return isTerminalSessionEligibleForSftpReuse(session) && session.status === "connected";
}

type CloneSessionOptions = {
  id: string;
  localShellType?: TerminalSession["shellType"];
  workspaceId?: string;
  inheritedCwd?: string;
  /**
   * When false, the clone never reuses the source's established SSH channel and
   * instead opens a brand-new connection (fresh auth; e.g. a new bastion login).
   * Defaults to true (reuse when possible).
   */
  reuseConnection?: boolean;
};

function getClonedShellType(
  session: TerminalSession,
  localShellType?: TerminalSession["shellType"],
): TerminalSession["shellType"] {
  return session.protocol === "local" ? localShellType : session.shellType;
}

function createTerminalSessionClone(
  session: TerminalSession,
  options: CloneSessionOptions,
): TerminalSession {
  const isLocal = session.protocol === "local";
  // Only ssh/undefined (non-mosh/et) sessions inject an inherited `cd`; setting
  // pendingInitialCwd for telnet/serial/mosh/et would be dead, never-cleared
  // state (those protocols don't track cwd, so it's never consumed or cleared).
  const injectsInheritedCwd =
    options.reuseConnection !== false
    && (session.protocol === "ssh" || session.protocol === undefined)
    && !session.moshEnabled
    && !session.etEnabled;
  const clonedSession: TerminalSession = {
    id: options.id,
    hostId: session.hostId,
    hostLabel: session.hostLabel,
    hostname: session.hostname,
    username: session.username,
    status: "connecting",
    protocol: session.protocol,
    pluginConnection: session.pluginConnection == null
      ? undefined
      : structuredClone(session.pluginConnection),
    port: session.port,
    moshEnabled: session.moshEnabled,
    etEnabled: session.etEnabled,
    shellType: getClonedShellType(session, options.localShellType),
    charset: session.charset,
    localShell: session.localShell,
    localShellArgs: session.localShellArgs,
    localShellName: session.localShellName,
    localShellIcon: session.localShellIcon,
    localStartDir: isLocal && options.inheritedCwd ? options.inheritedCwd : session.localStartDir,
    fontSize: session.fontSize,
    fontSizeOverride: session.fontSizeOverride,
    ...(session.ephemeralHost ? { ephemeralHost: true } : {}),
    ...(injectsInheritedCwd && options.inheritedCwd ? { pendingInitialCwd: options.inheritedCwd } : {}),
    // Clearing `reuseConnectionFromSessionId` only disables source-specific
    // reuse; without an explicit fresh-connection flag the bridge would still
    // be eligible for general endpoint/idle transport reuse (e.g. borrowing
    // the source's live transport). Flag the clone so the starter sends
    // `reuseTransport: false` and the session truly dials fresh.
    ...(options.reuseConnection === false ? { requireFreshConnection: true } : {}),
    reuseConnectionFromSessionId: options.reuseConnection === false
      ? undefined
      : (canReuseTerminalConnection(session) ? session.id : undefined),
  };

  if (options.workspaceId) {
    clonedSession.workspaceId = options.workspaceId;
  }

  return clonedSession;
}

export function createSplitTerminalSessionClone(
  session: TerminalSession,
  options: CloneSessionOptions,
): TerminalSession {
  return createTerminalSessionClone(session, options);
}

export function createCopiedTerminalSessionClone(
  session: TerminalSession,
  options: CloneSessionOptions,
): TerminalSession {
  return {
    ...createTerminalSessionClone(session, options),
    serialConfig: session.serialConfig,
  };
}
