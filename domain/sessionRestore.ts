import type { PluginConnectionConfig, SerialConfig, TerminalSession, Workspace, WorkspaceNode } from "./models";
import { isPluginHostProtocol, sanitizePluginConnection } from "./pluginConnection";

export const SESSION_RESTORE_VERSION = 1 as const;

export type RestoredTerminalSession = {
  id: string;
  hostId: string;
  hostLabel: string;
  hostname: string;
  username: string;
  status: "disconnected";
  workspaceId?: string;
  protocol?: TerminalSession["protocol"];
  pluginConnection?: PluginConnectionConfig;
  port?: number;
  moshEnabled?: boolean;
  etEnabled?: boolean;
  shellType?: TerminalSession["shellType"];
  charset?: string;
  serialConfig?: SerialConfig;
  localShell?: string;
  localShellArgs?: string[];
  localShellName?: string;
  localShellIcon?: string;
  localStartDir?: string;
  fontSize?: number;
  fontSizeOverride?: boolean;
  customName?: string;
  lastCwd?: string;
  restoreState: "restored-disconnected";
};

export type SessionRestorePayload = {
  version: typeof SESSION_RESTORE_VERSION;
  savedAt: number;
  activeTabId: string;
  tabOrder: string[];
  sessions: RestoredTerminalSession[];
  workspaces: Workspace[];
};

export type BuildSessionRestorePayloadInput = {
  sessions: TerminalSession[];
  workspaces: Workspace[];
  tabOrder: string[];
  activeTabId: string;
  now?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === "object"
);

const uniqueStrings = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    next.push(value);
  }
  return next;
};

const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const readStringAllowEmpty = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const readBoolean = (record: Record<string, unknown>, key: string): boolean | undefined => {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
};

const readNumber = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const isOneOf = <T extends string | number>(
  value: unknown,
  allowed: readonly T[],
): value is T => allowed.includes(value as T);

const sanitizeProtocol = (value: unknown): TerminalSession["protocol"] | undefined => {
  if (isOneOf(value, ["ssh", "telnet", "mosh", "et", "local", "serial"] as const)) return value;
  return typeof value === "string" && isPluginHostProtocol(value) ? value : undefined;
};

const sanitizeShellType = (value: unknown): TerminalSession["shellType"] | undefined => (
  isOneOf(value, ["posix", "fish", "powershell", "cmd", "unknown"] as const) ? value : undefined
);

const sanitizeSerialConfig = (value: unknown): SerialConfig | undefined => {
  if (!isRecord(value)) return undefined;
  const path = readString(value, "path");
  const baudRate = readNumber(value, "baudRate");
  if (!path || baudRate === undefined) return undefined;

  return {
    path,
    baudRate,
    ...(isOneOf(value.dataBits, [5, 6, 7, 8] as const) ? { dataBits: value.dataBits } : {}),
    ...(isOneOf(value.stopBits, [1, 1.5, 2] as const) ? { stopBits: value.stopBits } : {}),
    ...(isOneOf(value.parity, ["none", "even", "odd", "mark", "space"] as const) ? { parity: value.parity } : {}),
    ...(isOneOf(value.flowControl, ["none", "xon/xoff", "rts/cts"] as const) ? { flowControl: value.flowControl } : {}),
    ...(readBoolean(value, "localEcho") !== undefined ? { localEcho: readBoolean(value, "localEcho") } : {}),
    ...(readBoolean(value, "lineMode") !== undefined ? { lineMode: readBoolean(value, "lineMode") } : {}),
    // A missing value identifies a session saved before serial-specific
    // Backspace snapshots existed. Keep it missing so a saved-host session can
    // still pick up its legacy host or group Ctrl+H setting. New sessions
    // always persist an explicit "default" or "ctrl-h" value.
    ...(isOneOf(value.backspaceBehavior, ["default", "ctrl-h"] as const)
      ? { backspaceBehavior: value.backspaceBehavior }
      : {}),
  };
};

const restoreSession = (session: TerminalSession): RestoredTerminalSession => {
  const serialConfig = sanitizeSerialConfig(session.serialConfig);
  const protocol = sanitizeProtocol(session.protocol);
  const pluginConnection = sanitizePluginConnection(session.pluginConnection, protocol);
  const shellType = sanitizeShellType(session.shellType);
  return {
    id: session.id,
    hostId: session.hostId,
    hostLabel: session.hostLabel,
    hostname: session.hostname,
    username: session.username,
    ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
    ...(protocol ? { protocol } : {}),
    ...(pluginConnection ? { pluginConnection } : {}),
    ...(session.port !== undefined ? { port: session.port } : {}),
    ...(session.moshEnabled !== undefined ? { moshEnabled: session.moshEnabled } : {}),
    ...(session.etEnabled !== undefined ? { etEnabled: session.etEnabled } : {}),
    ...(shellType ? { shellType } : {}),
    ...(session.charset ? { charset: session.charset } : {}),
    ...(serialConfig ? { serialConfig } : {}),
    ...(session.localShell ? { localShell: session.localShell } : {}),
    ...(session.localShellArgs ? { localShellArgs: [...session.localShellArgs] } : {}),
    ...(session.localShellName ? { localShellName: session.localShellName } : {}),
    ...(session.localShellIcon ? { localShellIcon: session.localShellIcon } : {}),
    ...(session.localStartDir ? { localStartDir: session.localStartDir } : {}),
    ...(session.fontSize !== undefined ? { fontSize: session.fontSize } : {}),
    ...(session.fontSizeOverride !== undefined ? { fontSizeOverride: session.fontSizeOverride } : {}),
    ...(session.customName ? { customName: session.customName } : {}),
    ...(session.lastCwd ? { lastCwd: session.lastCwd } : {}),
    status: "disconnected",
    restoreState: "restored-disconnected",
  };
};

const restoreSessionFromUnknown = (value: unknown): RestoredTerminalSession | null => {
  if (!isRecord(value)) return null;
  const id = readString(value, "id");
  const hostId = readString(value, "hostId");
  const hostLabel = readString(value, "hostLabel");
  const hostname = readString(value, "hostname");
  const username = readStringAllowEmpty(value, "username");
  if (!id || !hostId || !hostLabel || !hostname || username === undefined) return null;

  const serialConfig = sanitizeSerialConfig(value.serialConfig);
  const protocol = sanitizeProtocol(value.protocol);
  const pluginConnection = sanitizePluginConnection(value.pluginConnection, protocol);
  const shellType = sanitizeShellType(value.shellType);
  return {
    id,
    hostId,
    hostLabel,
    hostname,
    username,
    ...(readString(value, "workspaceId") ? { workspaceId: readString(value, "workspaceId") } : {}),
    ...(protocol ? { protocol } : {}),
    ...(pluginConnection ? { pluginConnection } : {}),
    ...(readNumber(value, "port") !== undefined ? { port: readNumber(value, "port") } : {}),
    ...(readBoolean(value, "moshEnabled") !== undefined ? { moshEnabled: readBoolean(value, "moshEnabled") } : {}),
    ...(readBoolean(value, "etEnabled") !== undefined ? { etEnabled: readBoolean(value, "etEnabled") } : {}),
    ...(shellType ? { shellType } : {}),
    ...(readString(value, "charset") ? { charset: readString(value, "charset") } : {}),
    ...(serialConfig ? { serialConfig } : {}),
    ...(readString(value, "localShell") ? { localShell: readString(value, "localShell") } : {}),
    ...(Array.isArray(value.localShellArgs) ? { localShellArgs: value.localShellArgs.filter((arg): arg is string => typeof arg === "string") } : {}),
    ...(readString(value, "localShellName") ? { localShellName: readString(value, "localShellName") } : {}),
    ...(readString(value, "localShellIcon") ? { localShellIcon: readString(value, "localShellIcon") } : {}),
    ...(readString(value, "localStartDir") ? { localStartDir: readString(value, "localStartDir") } : {}),
    ...(readNumber(value, "fontSize") !== undefined ? { fontSize: readNumber(value, "fontSize") } : {}),
    ...(readBoolean(value, "fontSizeOverride") !== undefined ? { fontSizeOverride: readBoolean(value, "fontSizeOverride") } : {}),
    ...(readString(value, "customName") ? { customName: readString(value, "customName") } : {}),
    ...(readString(value, "lastCwd") ? { lastCwd: readString(value, "lastCwd") } : {}),
    status: "disconnected",
    restoreState: "restored-disconnected",
  };
};

export const isRestoredDisconnectedSession = (
  session: Pick<TerminalSession, "status"> & { restoreState?: string },
): boolean => session.status === "disconnected" && session.restoreState === "restored-disconnected";

type RestoreCwdSession = Pick<TerminalSession, "status"> & {
  restoreState?: string;
  protocol?: TerminalSession["protocol"];
  shellType?: TerminalSession["shellType"];
  lastCwd?: string;
  moshEnabled?: boolean;
  etEnabled?: boolean;
};

const isRestoreCwdPathEligible = (cwd: string | undefined): cwd is string => {
  if (!cwd) return false;
  const trimmed = cwd.trim();
  if (!trimmed) return false;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return false;
  return trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/");
};

export function shouldAttemptRestoreCwd({
  enabled,
  session,
  isNetworkDevice,
}: {
  enabled: boolean;
  session: RestoreCwdSession;
  isNetworkDevice: boolean;
}): boolean {
  if (!enabled) return false;
  if (!isRestoredDisconnectedSession(session)) return false;
  return isCwdInjectionEligible({ session: { ...session, cwd: session.lastCwd }, isNetworkDevice });
}

export function quoteRestoreCwdForShell(cwd: string): string {
  return `'${cwd.replace(/'/g, "'\\''")}'`;
}

function quoteRestoreCwdArgument(cwd: string): string {
  if (cwd === "~") return "~";
  if (cwd.startsWith("~/")) {
    const suffix = cwd.slice(2);
    return suffix ? `~/${quoteRestoreCwdForShell(suffix)}` : "~";
  }
  return quoteRestoreCwdForShell(cwd);
}

/** True when a path contains C0/DEL bytes that interactive readline would act on. */
function pathHasInteractivePtyControlBytes(path: string): boolean {
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Build a user-initiated `cd` for an absolute/home path (SFTP -> terminal). */
export function resolveInteractiveTerminalCdIntent(
  cwd: string | null | undefined,
): { cwd: string; command: string } | null {
  // Eligibility uses a normalized view; keep the exact path for quoting so
  // trailing whitespace in POSIX names is preserved.
  if (!isRestoreCwdPathEligible(cwd)) return null;
  // Shell quoting does not protect tab/ESC/Ctrl-U while readline processes keystrokes.
  if (pathHasInteractivePtyControlBytes(cwd)) return null;
  return { cwd, command: `cd -- ${quoteRestoreCwdArgument(cwd)}` };
}

export function resolveRestoreCwdIntent(options: {
  enabled: boolean;
  session: RestoreCwdSession;
  isNetworkDevice: boolean;
}): { cwd: string; command: string } | null {
  if (!shouldAttemptRestoreCwd(options)) return null;
  const cwd = options.session.lastCwd!.trim();
  return {
    cwd,
    command: `cd -- ${quoteRestoreCwdArgument(cwd)}`,
  };
}

export function isCwdInjectionEligible({
  session,
  isNetworkDevice,
}: {
  session: RestoreCwdSession & { cwd?: string };
  isNetworkDevice: boolean;
}): boolean {
  if (isNetworkDevice) return false;
  if (!isRestoreCwdPathEligible(session.cwd)) return false;
  if (session.moshEnabled || session.etEnabled) return false;
  const protocol = session.protocol ?? "ssh";
  if (protocol === "local" && (session.shellType === "powershell" || session.shellType === "cmd")) {
    return false;
  }
  return protocol === "ssh" || protocol === "local" || protocol === undefined;
}

export function resolveInheritedCwdIntent(options: {
  session: Pick<TerminalSession, "protocol" | "shellType" | "moshEnabled" | "etEnabled"> & { cwd?: string };
  isNetworkDevice: boolean;
}): { cwd: string; command: string } | null {
  if (!isCwdInjectionEligible({
    session: {
      status: "connecting",
      protocol: options.session.protocol,
      shellType: options.session.shellType,
      moshEnabled: options.session.moshEnabled,
      etEnabled: options.session.etEnabled,
      cwd: options.session.cwd,
    },
    isNetworkDevice: options.isNetworkDevice,
  })) {
    return null;
  }
  const cwd = options.session.cwd!.trim();
  return { cwd, command: `cd -- ${quoteRestoreCwdArgument(cwd)}` };
}

const pruneNode = (node: unknown, validSessionIds: ReadonlySet<string>): WorkspaceNode | null => {
  if (!isRecord(node)) return null;
  if (node.type === "pane") {
    if (typeof node.id !== "string" || typeof node.sessionId !== "string") return null;
    return validSessionIds.has(node.sessionId)
      ? { id: node.id, type: "pane", sessionId: node.sessionId }
      : null;
  }

  if (node.type !== "split" || typeof node.id !== "string" || (node.direction !== "horizontal" && node.direction !== "vertical") || !Array.isArray(node.children)) {
    return null;
  }

  const restoredChildren = node.children
    .map((child, originalIndex) => ({
      child: pruneNode(child, validSessionIds),
      originalIndex,
    }))
    .filter((entry): entry is { child: WorkspaceNode; originalIndex: number } => entry.child !== null);
  const children = restoredChildren.map((entry) => entry.child);

  if (children.length === 0) return null;
  if (children.length === 1) return children[0];

  const rawSizes = Array.isArray(node.sizes) ? node.sizes : undefined;
  const canReuseSizes = rawSizes?.length === node.children.length
    && rawSizes.every((size) => typeof size === "number" && Number.isFinite(size) && size > 0);
  const nextSizes = canReuseSizes
    ? restoredChildren.map(({ originalIndex }) => rawSizes[originalIndex])
    : children.map(() => 1 / children.length);
  const total = nextSizes.reduce((sum, size) => sum + size, 0);

  return {
    id: node.id,
    type: "split",
    direction: node.direction,
    children,
    sizes: total > 0 ? nextSizes.map((size) => size / total) : children.map(() => 1 / children.length),
  };
};

const collectNodeSessionIds = (node: WorkspaceNode): string[] => {
  if (node.type === "pane") return [node.sessionId];
  return node.children.flatMap(collectNodeSessionIds);
};

const restoreWorkspace = (workspace: Workspace, root: WorkspaceNode, sessionIds: readonly string[]): Workspace => {
  const sessionIdSet = new Set(sessionIds);
  return {
    id: workspace.id,
    title: workspace.title,
    root,
    ...(workspace.viewMode === "focus" || workspace.viewMode === "split" ? { viewMode: workspace.viewMode } : {}),
    focusedSessionId: workspace.focusedSessionId && sessionIdSet.has(workspace.focusedSessionId)
      ? workspace.focusedSessionId
      : sessionIds[0],
    focusSessionOrder: uniqueStrings(workspace.focusSessionOrder ?? []).filter((id) => sessionIdSet.has(id)),
    ...(workspace.snippetId ? { snippetId: workspace.snippetId } : {}),
    // Preserve explicit-title state across restore; the boolean guard keeps a
    // deliberate `autoTitle: false` (a user-named workspace) from being dropped.
    ...(typeof workspace.autoTitle === "boolean" ? { autoTitle: workspace.autoTitle } : {}),
  };
};

export function resolveRestoredActiveTabId(
  activeTabId: string,
  tabOrder: readonly string[],
  sessions: readonly Pick<TerminalSession, "id" | "workspaceId">[],
  workspaces: readonly Pick<Workspace, "id">[],
): string {
  const valid = new Set([
    "vault",
    ...sessions.filter((session) => !session.workspaceId).map((session) => session.id),
    ...workspaces.map((workspace) => workspace.id),
  ]);
  if (valid.has(activeTabId)) return activeTabId;
  const fallback = tabOrder.find((id) => valid.has(id));
  return fallback ?? "vault";
}

const isWorkspaceRecord = (value: unknown): value is Workspace & Record<string, unknown> => (
  isRecord(value) && typeof value.id === "string" && Boolean(value.id) && "root" in value
);

export function sanitizeSessionRestorePayload(payload: unknown): SessionRestorePayload {
  const record = isRecord(payload) ? payload : {};
  const rawSessions = Array.isArray(record.sessions) ? record.sessions : [];
  const rawWorkspaces = Array.isArray(record.workspaces) ? record.workspaces : [];
  const sessions = uniqueStrings(
    rawSessions
      .map((session) => isRecord(session) ? readString(session, "id") ?? "" : "")
  )
    .map((id) => rawSessions.find((session) => isRecord(session) && session.id === id))
    .map(restoreSessionFromUnknown)
    .filter((session): session is RestoredTerminalSession => session !== null);
  const workspaces: Workspace[] = [];
  const workspaceRootSessionIds = new Map<string, Set<string>>();
  for (const workspace of rawWorkspaces) {
    if (!isWorkspaceRecord(workspace)) continue;
    const workspaceSessionIds = new Set(
      sessions
        .filter((session) => session.workspaceId === workspace.id)
        .map((session) => session.id),
    );
    const root = pruneNode(workspace.root, workspaceSessionIds);
    if (!root) continue;
    const sessionIds = collectNodeSessionIds(root);
    workspaceRootSessionIds.set(workspace.id, new Set(sessionIds));
    workspaces.push(restoreWorkspace(workspace, root, sessionIds));
  }

  const validWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const sanitizedSessions = sessions.filter((session) => (
    !session.workspaceId
    || (
      validWorkspaceIds.has(session.workspaceId)
      && (workspaceRootSessionIds.get(session.workspaceId)?.has(session.id) ?? false)
    )
  ));
  const validTabIds = new Set([
    ...sanitizedSessions.filter((session) => !session.workspaceId).map((session) => session.id),
    ...workspaces.map((workspace) => workspace.id),
  ]);
  const tabOrder = uniqueStrings(Array.isArray(record.tabOrder) ? record.tabOrder.filter((id): id is string => typeof id === "string") : [])
    .filter((id) => validTabIds.has(id));
  const activeTabId = resolveRestoredActiveTabId(
    typeof record.activeTabId === "string" ? record.activeTabId : "vault",
    tabOrder,
    sanitizedSessions,
    workspaces,
  );

  return {
    version: SESSION_RESTORE_VERSION,
    savedAt: Number.isFinite(record.savedAt) ? record.savedAt as number : Date.now(),
    activeTabId,
    tabOrder,
    sessions: sanitizedSessions,
    workspaces,
  };
}

export function buildSessionRestorePayload(input: BuildSessionRestorePayloadInput): SessionRestorePayload {
  return sanitizeSessionRestorePayload({
    version: SESSION_RESTORE_VERSION,
    savedAt: input.now ?? Date.now(),
    activeTabId: input.activeTabId,
    tabOrder: input.tabOrder,
    // Ephemeral-host sessions (password deep links) cannot be restored: their
    // in-memory credentials do not survive a relaunch, and persisting them
    // would leak the supposedly ephemeral host metadata into restore storage.
    // Silent MCP sessions are likewise excluded — they exist for the duration
    // of an AI task, not as a user-intended workspace to bring back on launch.
    sessions: input.sessions.filter((session) => !session.ephemeralHost && !session.hiddenFromTabs).map(restoreSession),
    workspaces: input.workspaces,
  });
}
