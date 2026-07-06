import type { TerminalSession } from "../../domain/models";

export function canReuseTerminalConnection(session: TerminalSession): boolean {
  return (
    (session.protocol === "ssh" || session.protocol === undefined) &&
    !session.moshEnabled &&
    !session.etEnabled &&
    session.status === "connected"
  );
}

type CloneSessionOptions = {
  id: string;
  localShellType?: TerminalSession["shellType"];
  workspaceId?: string;
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
  const clonedSession: TerminalSession = {
    id: options.id,
    hostId: session.hostId,
    hostLabel: session.hostLabel,
    hostname: session.hostname,
    username: session.username,
    status: "connecting",
    protocol: session.protocol,
    port: session.port,
    moshEnabled: session.moshEnabled,
    etEnabled: session.etEnabled,
    shellType: getClonedShellType(session, options.localShellType),
    charset: session.charset,
    localShell: session.localShell,
    localShellArgs: session.localShellArgs,
    localShellName: session.localShellName,
    localShellIcon: session.localShellIcon,
    localStartDir: session.localStartDir,
    fontSize: session.fontSize,
    fontSizeOverride: session.fontSizeOverride,
    ...(session.ephemeralHost ? { ephemeralHost: true } : {}),
    reuseConnectionFromSessionId: canReuseTerminalConnection(session) ? session.id : undefined,
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
