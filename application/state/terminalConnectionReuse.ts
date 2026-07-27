import type { Host, TerminalSession } from "../../domain/models";

type SftpReuseEndpoint = Pick<Host, "hostname" | "port" | "username">;

type ResolveReusableTerminalSessionIdForSftpOptions = {
  activeSessionId?: string | null;
  preferredSourceSessionId?: string | null;
  sftpActiveHost: SftpReuseEndpoint | null;
  sessions: TerminalSession[];
  sessionHostsMap: Map<string, SftpReuseEndpoint>;
};

export function canReuseTerminalConnection(session: TerminalSession): boolean {
  return (
    (session.protocol === "ssh" || session.protocol === undefined) &&
    !session.moshEnabled &&
    !session.etEnabled &&
    session.status === "connected"
  );
}

// Matches the SSH endpoint identity used by SFTP reuse without requiring host ids
// to match; session-time overrides can point at the same live SSH connection.
function sameSftpReuseEndpoint(a: SftpReuseEndpoint, b: SftpReuseEndpoint): boolean {
  return a.hostname === b.hostname
    && (a.port || 22) === (b.port || 22)
    && (a.username || "root") === (b.username || "root");
}

// Resolves the terminal session SFTP should try to reuse. The focused session
// wins once React has published it; remembered sources only cover the first
// render before the live side-panel snapshot catches up.
export function resolveReusableTerminalSessionIdForSftp({
  activeSessionId,
  preferredSourceSessionId,
  sftpActiveHost,
  sessions,
  sessionHostsMap,
}: ResolveReusableTerminalSessionIdForSftpOptions): string | null {
  if (!sftpActiveHost) return null;

  const candidateIds = Array.from(new Set([
    activeSessionId ?? null,
    preferredSourceSessionId ?? null,
  ].filter((id): id is string => !!id)));

  for (const candidateId of candidateIds) {
    const session = sessions.find((candidate) => candidate.id === candidateId);
    if (!session) continue;
    if (!canReuseTerminalConnection(session)) continue;
    const sessionEndpoint = sessionHostsMap.get(session.id) ?? {
      hostname: session.hostname,
      port: session.port,
      username: session.username,
    };
    if (sameSftpReuseEndpoint(sessionEndpoint, sftpActiveHost)) return session.id;
  }

  return null;
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
