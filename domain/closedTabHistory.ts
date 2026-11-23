import type {
  Host,
  PluginConnectionConfig,
  SerialConfig,
  TerminalSession,
  Workspace,
  WorkspaceNode,
  WorkspaceViewMode,
} from "./models";
import { isPluginHostProtocol, sanitizePluginConnection } from "./pluginConnection";
import { cloneWorkspaceTree, collectSessionIds } from "./workspace";

export const DEFAULT_CLOSED_TAB_HISTORY_LIMIT = 20;

const LOCAL_TERMINAL_HOST_ID = "local-terminal";

/**
 * Non-secret, in-memory snapshot of a closed terminal session.
 * Never persists to storage and never carries credentials, one-shot snippet
 * startup scripts, or live transport reuse handles.
 */
export interface ClosedTerminalSessionSnapshot {
  sourceSessionId: string;
  hostId: string;
  hostLabel: string;
  hostname: string;
  username: string;
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
  requireFreshConnection?: boolean;
  ephemeralHost?: boolean;
  autoOpenSidePanel?: TerminalSession["autoOpenSidePanel"];
}

export interface ClosedSessionTabEntry {
  kind: "session";
  /** Original session id used to avoid duplicate pushes for the same close event. */
  sourceId: string;
  closedAt: number;
  session: ClosedTerminalSessionSnapshot;
}

export interface ClosedWorkspaceTabEntry {
  kind: "workspace";
  /** Original workspace id used to avoid duplicate pushes for the same close event. */
  sourceId: string;
  closedAt: number;
  title: string;
  autoTitle?: boolean;
  generatedTitle?: boolean;
  viewMode?: WorkspaceViewMode;
  snippetId?: string;
  root: WorkspaceNode;
  focusedSessionId?: string;
  focusSessionOrder?: string[];
  sessions: ClosedTerminalSessionSnapshot[];
}

export type ClosedTabEntry = ClosedSessionTabEntry | ClosedWorkspaceTabEntry;

export type ReopenClosedTabMaterialized =
  | {
      kind: "session";
      tabId: string;
      session: TerminalSession;
    }
  | {
      kind: "workspace";
      tabId: string;
      workspace: Workspace;
      sessions: TerminalSession[];
    };

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

const sanitizeProtocol = (
  value: TerminalSession["protocol"],
): TerminalSession["protocol"] | undefined => {
  if (
    value === "ssh"
    || value === "telnet"
    || value === "mosh"
    || value === "et"
    || value === "local"
    || value === "serial"
  ) {
    return value;
  }
  return typeof value === "string" && isPluginHostProtocol(value) ? value : undefined;
};

const cloneSerialConfig = (config: SerialConfig | undefined): SerialConfig | undefined => (
  config ? { ...config } : undefined
);

const pruneAndCloneWorkspaceRoot = (
  node: WorkspaceNode,
  validSessionIds: ReadonlySet<string>,
): WorkspaceNode | null => {
  if (node.type === "pane") {
    return validSessionIds.has(node.sessionId)
      ? { id: node.id, type: "pane", sessionId: node.sessionId }
      : null;
  }

  const keptChildren = node.children
    .map((child, originalIndex) => ({
      child: pruneAndCloneWorkspaceRoot(child, validSessionIds),
      originalIndex,
    }))
    .filter((item): item is { child: WorkspaceNode; originalIndex: number } => item.child !== null);

  if (keptChildren.length === 0) return null;
  if (keptChildren.length === 1) return keptChildren[0].child;

  const rawSizes = Array.isArray(node.sizes) ? node.sizes : undefined;
  const canReuseSizes = rawSizes?.length === node.children.length
    && rawSizes.every((size) => typeof size === "number" && Number.isFinite(size) && size > 0);
  const nextSizes = canReuseSizes
    ? keptChildren.map(({ originalIndex }) => rawSizes[originalIndex])
    : keptChildren.map(() => 1 / keptChildren.length);
  const total = nextSizes.reduce((sum, size) => sum + size, 0);

  return {
    id: node.id,
    type: "split",
    direction: node.direction,
    children: keptChildren.map((item) => item.child),
    sizes: total > 0
      ? nextSizes.map((size) => size / total)
      : keptChildren.map(() => 1 / keptChildren.length),
  };
};

export function createClosedSessionSnapshot(
  session: TerminalSession,
  options?: { lastCwd?: string },
): ClosedTerminalSessionSnapshot | null {
  // Hidden MCP sessions were never tabs. Ephemeral hosts (password deep links,
  // unsaved quick-connects, and saved-host overrides built by
  // buildSshDeepLinkEphemeralHostFromSaved) have their in-memory Host record
  // purged on close, so host-level routing/settings (hostChain, proxyConfig,
  // legacyAlgorithms, deviceType, one-time auth) cannot be faithfully
  // reconstructed from a TerminalSession snapshot alone. Mirror
  // domain/sessionRestore.ts and exclude them.
  if (session.hiddenFromTabs || session.ephemeralHost) return null;

  const protocol = sanitizeProtocol(session.protocol);
  const pluginConnection = sanitizePluginConnection(session.pluginConnection, protocol);
  const serialConfig = cloneSerialConfig(session.serialConfig);
  const resolvedCwd = options?.lastCwd?.trim() || session.lastCwd?.trim() || undefined;

  return {
    sourceSessionId: session.id,
    hostId: session.hostId,
    hostLabel: session.hostLabel,
    hostname: session.hostname,
    username: session.username,
    ...(protocol ? { protocol } : {}),
    ...(pluginConnection ? { pluginConnection } : {}),
    ...(session.port !== undefined ? { port: session.port } : {}),
    ...(session.moshEnabled !== undefined ? { moshEnabled: session.moshEnabled } : {}),
    ...(session.etEnabled !== undefined ? { etEnabled: session.etEnabled } : {}),
    ...(session.shellType ? { shellType: session.shellType } : {}),
    ...(session.charset ? { charset: session.charset } : {}),
    ...(serialConfig ? { serialConfig } : {}),
    ...(session.localShell !== undefined ? { localShell: session.localShell } : {}),
    ...(session.localShellArgs ? { localShellArgs: [...session.localShellArgs] } : {}),
    ...(session.localShellName !== undefined ? { localShellName: session.localShellName } : {}),
    ...(session.localShellIcon !== undefined ? { localShellIcon: session.localShellIcon } : {}),
    ...(session.localStartDir ? { localStartDir: session.localStartDir } : {}),
    ...(session.fontSize !== undefined ? { fontSize: session.fontSize } : {}),
    ...(session.fontSizeOverride !== undefined ? { fontSizeOverride: session.fontSizeOverride } : {}),
    ...(session.customName ? { customName: session.customName } : {}),
    ...(resolvedCwd ? { lastCwd: resolvedCwd } : {}),
    ...(session.requireFreshConnection === true ? { requireFreshConnection: true } : {}),
    ...(session.ephemeralHost === true ? { ephemeralHost: true } : {}),
    ...(session.autoOpenSidePanel ? { autoOpenSidePanel: session.autoOpenSidePanel } : {}),
  };
}

export function createClosedSessionEntry(
  session: TerminalSession,
  options?: { closedAt?: number; lastCwd?: string },
): ClosedSessionTabEntry | null {
  const snapshot = createClosedSessionSnapshot(session, { lastCwd: options?.lastCwd });
  if (!snapshot) return null;
  return {
    kind: "session",
    sourceId: session.id,
    closedAt: options?.closedAt ?? Date.now(),
    session: snapshot,
  };
}

export function createClosedWorkspaceEntry(
  workspace: Workspace,
  sessions: readonly TerminalSession[],
  options?: {
    closedAt?: number;
    cwdBySessionId?: ReadonlyMap<string, string>;
  },
): ClosedWorkspaceTabEntry | null {
  const snapshotsById = new Map<string, ClosedTerminalSessionSnapshot>();
  for (const session of sessions) {
    if (session.workspaceId !== workspace.id) continue;
    const snapshot = createClosedSessionSnapshot(session, {
      lastCwd: options?.cwdBySessionId?.get(session.id),
    });
    if (snapshot) {
      snapshotsById.set(session.id, snapshot);
    }
  }
  if (snapshotsById.size === 0) return null;

  const validSessionIds = new Set(snapshotsById.keys());
  const prunedRoot = pruneAndCloneWorkspaceRoot(workspace.root, validSessionIds);
  if (!prunedRoot) return null;

  const rootSessionIds = collectSessionIds(prunedRoot);
  if (rootSessionIds.length === 0) return null;

  const rootSessionIdSet = new Set(rootSessionIds);
  const orderedSnapshots = rootSessionIds
    .map((id) => snapshotsById.get(id))
    .filter((snapshot): snapshot is ClosedTerminalSessionSnapshot => Boolean(snapshot));

  const focusedSessionId = workspace.focusedSessionId && rootSessionIdSet.has(workspace.focusedSessionId)
    ? workspace.focusedSessionId
    : rootSessionIds[0];

  const focusSessionOrder = workspace.focusSessionOrder
    ? uniqueStrings(workspace.focusSessionOrder).filter((id) => rootSessionIdSet.has(id))
    : undefined;

  return {
    kind: "workspace",
    sourceId: workspace.id,
    closedAt: options?.closedAt ?? Date.now(),
    title: workspace.title,
    ...(typeof workspace.autoTitle === "boolean" ? { autoTitle: workspace.autoTitle } : {}),
    ...(workspace.generatedTitle === true ? { generatedTitle: true } : {}),
    ...(workspace.viewMode === "split" || workspace.viewMode === "focus"
      ? { viewMode: workspace.viewMode }
      : {}),
    ...(workspace.snippetId ? { snippetId: workspace.snippetId } : {}),
    root: prunedRoot,
    focusedSessionId,
    ...(focusSessionOrder && focusSessionOrder.length > 0 ? { focusSessionOrder } : {}),
    sessions: orderedSnapshots,
  };
}

/**
 * Determine whether a closed session snapshot can still be reopened given the
 * current set of vault host ids.
 *
 * Self-contained sessions (local terminals and quick-connect serial ports) do
 * not depend on a vault host record and remain restorable even when
 * `availableHostIds` is empty. Ephemeral host sessions are rejected because
 * their in-memory Host record (routing, proxy/jump chain, legacy algorithms,
 * and one-time credentials) is purged when the tab closes.
 */
export function isClosedSessionSnapshotRestorable(
  snapshot: ClosedTerminalSessionSnapshot,
  availableHostIds?: ReadonlySet<string>,
): boolean {
  if (snapshot.ephemeralHost === true) {
    return false;
  }
  if (!availableHostIds) return true;
  if (snapshot.protocol === "local" && snapshot.hostId === LOCAL_TERMINAL_HOST_ID) {
    return true;
  }
  if (
    snapshot.protocol === "serial"
    && Boolean(snapshot.serialConfig?.path)
    && snapshot.hostId.startsWith("serial-")
  ) {
    return true;
  }
  return Boolean(snapshot.hostId) && availableHostIds.has(snapshot.hostId);
}

export function pushClosedTabEntry(
  history: readonly ClosedTabEntry[],
  entry: ClosedTabEntry | null,
  maxEntries: number = DEFAULT_CLOSED_TAB_HISTORY_LIMIT,
): ClosedTabEntry[] {
  if (!entry || maxEntries <= 0) return [...history];
  // Deduplicate by original session/workspace id so duplicate close callbacks
  // before React commits cannot record the same closed tab twice.
  if (history.some((existing) => existing.kind === entry.kind && existing.sourceId === entry.sourceId)) {
    return [...history];
  }
  const next = [...history, entry];
  return next.length > maxEntries ? next.slice(next.length - maxEntries) : next;
}

const pruneSingleClosedTabEntry = (
  entry: ClosedTabEntry,
  availableHostIds?: ReadonlySet<string>,
): ClosedTabEntry | null => {
  if (entry.kind === "session") {
    return isClosedSessionSnapshotRestorable(entry.session, availableHostIds) ? entry : null;
  }

  const survivingSessions = entry.sessions.filter((snapshot) =>
    isClosedSessionSnapshotRestorable(snapshot, availableHostIds),
  );
  if (survivingSessions.length === 0) return null;

  const survivingIds = new Set(survivingSessions.map((snapshot) => snapshot.sourceSessionId));
  const prunedRoot = pruneAndCloneWorkspaceRoot(entry.root, survivingIds);
  if (!prunedRoot) return null;

  const rootSessionIds = collectSessionIds(prunedRoot);
  if (rootSessionIds.length === 0) return null;

  const rootSessionIdSet = new Set(rootSessionIds);
  const orderedSessions = rootSessionIds
    .map((id) => survivingSessions.find((snapshot) => snapshot.sourceSessionId === id))
    .filter((snapshot): snapshot is ClosedTerminalSessionSnapshot => Boolean(snapshot));

  const focusedSessionId = entry.focusedSessionId && rootSessionIdSet.has(entry.focusedSessionId)
    ? entry.focusedSessionId
    : rootSessionIds[0];

  const focusSessionOrder = entry.focusSessionOrder
    ? uniqueStrings(entry.focusSessionOrder).filter((id) => rootSessionIdSet.has(id))
    : undefined;

  return {
    ...entry,
    root: prunedRoot,
    focusedSessionId,
    ...(focusSessionOrder && focusSessionOrder.length > 0
      ? { focusSessionOrder }
      : { focusSessionOrder: undefined }),
    sessions: orderedSessions,
  };
};

export function pruneClosedTabEntries(
  history: readonly ClosedTabEntry[],
  options?: { availableHostIds?: ReadonlySet<string> },
): ClosedTabEntry[] {
  const next: ClosedTabEntry[] = [];
  for (const entry of history) {
    const pruned = pruneSingleClosedTabEntry(entry, options?.availableHostIds);
    if (pruned) next.push(pruned);
  }
  return next;
}

export function popClosedTabEntry(
  history: readonly ClosedTabEntry[],
  options?: { availableHostIds?: ReadonlySet<string> },
): { entry: ClosedTabEntry | null; nextHistory: ClosedTabEntry[] } {
  const remaining = [...history];
  while (remaining.length > 0) {
    const candidate = remaining.pop() as ClosedTabEntry;
    const pruned = pruneSingleClosedTabEntry(candidate, options?.availableHostIds);
    if (pruned) {
      return {
        entry: pruned,
        nextHistory: remaining,
      };
    }
  }
  return {
    entry: null,
    nextHistory: [],
  };
}

const materializeSessionSnapshot = (
  snapshot: ClosedTerminalSessionSnapshot,
  params: {
    id: string;
    workspaceId?: string;
    liveHost?: Host;
  },
): TerminalSession => {
  const { id, workspaceId, liveHost } = params;
  const isLocal = snapshot.protocol === "local";
  const hostLabel = liveHost?.label || snapshot.hostLabel;
  const hostname = liveHost?.hostname || snapshot.hostname;
  const username = isLocal
    ? snapshot.username
    : (liveHost?.username ?? snapshot.username);
  const localStartDir = isLocal
    ? (snapshot.lastCwd ?? snapshot.localStartDir)
    : snapshot.localStartDir;

  return {
    id,
    hostId: snapshot.hostId,
    hostLabel,
    hostname,
    username,
    status: "connecting",
    ...(workspaceId ? { workspaceId } : {}),
    ...(snapshot.protocol ? { protocol: snapshot.protocol } : {}),
    ...(snapshot.pluginConnection
      ? { pluginConnection: sanitizePluginConnection(snapshot.pluginConnection, snapshot.protocol) }
      : {}),
    ...(snapshot.port !== undefined ? { port: snapshot.port } : {}),
    ...(snapshot.moshEnabled !== undefined ? { moshEnabled: snapshot.moshEnabled } : {}),
    ...(snapshot.etEnabled !== undefined ? { etEnabled: snapshot.etEnabled } : {}),
    ...(snapshot.shellType ? { shellType: snapshot.shellType } : {}),
    ...(snapshot.charset ? { charset: snapshot.charset } : {}),
    ...(snapshot.serialConfig ? { serialConfig: cloneSerialConfig(snapshot.serialConfig) } : {}),
    ...(snapshot.localShell !== undefined ? { localShell: snapshot.localShell } : {}),
    ...(snapshot.localShellArgs ? { localShellArgs: [...snapshot.localShellArgs] } : {}),
    ...(snapshot.localShellName !== undefined ? { localShellName: snapshot.localShellName } : {}),
    ...(snapshot.localShellIcon !== undefined ? { localShellIcon: snapshot.localShellIcon } : {}),
    ...(localStartDir ? { localStartDir } : {}),
    ...(snapshot.fontSize !== undefined ? { fontSize: snapshot.fontSize } : {}),
    ...(snapshot.fontSizeOverride !== undefined ? { fontSizeOverride: snapshot.fontSizeOverride } : {}),
    ...(snapshot.customName ? { customName: snapshot.customName } : {}),
    ...(snapshot.requireFreshConnection === true ? { requireFreshConnection: true } : {}),
    ...(snapshot.ephemeralHost === true ? { ephemeralHost: true } : {}),
    ...(snapshot.autoOpenSidePanel ? { autoOpenSidePanel: snapshot.autoOpenSidePanel } : {}),
  };
};

export function materializeClosedTabEntry(
  entry: ClosedTabEntry,
  options?: {
    hostsById?: ReadonlyMap<string, Host>;
    createId?: () => string;
  },
): ReopenClosedTabMaterialized | null {
  const createId = options?.createId ?? (() => crypto.randomUUID());

  if (entry.kind === "session") {
    if (entry.session.ephemeralHost === true) return null;
    const newSessionId = createId();
    const liveHost = options?.hostsById?.get(entry.session.hostId);
    const session = materializeSessionSnapshot(entry.session, {
      id: newSessionId,
      liveHost,
    });
    return {
      kind: "session",
      tabId: newSessionId,
      session,
    };
  }

  const rootSessionIds = collectSessionIds(entry.root);
  const snapshotBySourceId = new Map(
    entry.sessions
      .filter((snapshot) => snapshot.ephemeralHost !== true)
      .map((snapshot) => [snapshot.sourceSessionId, snapshot] as const),
  );
  const validSourceIds = rootSessionIds.filter((id) => snapshotBySourceId.has(id));
  if (validSourceIds.length === 0) return null;

  const validRoot = pruneAndCloneWorkspaceRoot(entry.root, new Set(validSourceIds));
  if (!validRoot) return null;

  const newWorkspaceId = `ws-${createId()}`;
  const sessionIdMap = new Map<string, string>(
    validSourceIds.map((oldId) => [oldId, createId()]),
  );
  const nodeIdMap = new Map<string, string>();
  const assignNodeIds = (node: WorkspaceNode) => {
    nodeIdMap.set(node.id, createId());
    if (node.type === "split") {
      node.children.forEach(assignNodeIds);
    }
  };
  assignNodeIds(validRoot);

  const sessions = validSourceIds.map((oldId) => {
    const snapshot = snapshotBySourceId.get(oldId) as ClosedTerminalSessionSnapshot;
    const liveHost = snapshot.ephemeralHost ? undefined : options?.hostsById?.get(snapshot.hostId);
    return materializeSessionSnapshot(snapshot, {
      id: sessionIdMap.get(oldId) as string,
      workspaceId: newWorkspaceId,
      liveHost,
    });
  });

  const remappedFocusedSessionId = (entry.focusedSessionId && sessionIdMap.get(entry.focusedSessionId))
    ?? sessionIdMap.get(validSourceIds[0]);

  const remappedFocusSessionOrder = entry.focusSessionOrder
    ? entry.focusSessionOrder
      .map((oldId) => sessionIdMap.get(oldId))
      .filter((newId): newId is string => Boolean(newId))
    : undefined;

  const workspace: Workspace = {
    id: newWorkspaceId,
    title: entry.title,
    root: cloneWorkspaceTree(validRoot, sessionIdMap, nodeIdMap),
    ...(typeof entry.autoTitle === "boolean" ? { autoTitle: entry.autoTitle } : {}),
    ...(entry.generatedTitle === true ? { generatedTitle: true } : {}),
    ...(entry.viewMode ? { viewMode: entry.viewMode } : {}),
    ...(entry.snippetId ? { snippetId: entry.snippetId } : {}),
    focusedSessionId: remappedFocusedSessionId,
    ...(remappedFocusSessionOrder && remappedFocusSessionOrder.length > 0
      ? { focusSessionOrder: remappedFocusSessionOrder }
      : {}),
  };

  return {
    kind: "workspace",
    tabId: newWorkspaceId,
    workspace,
    sessions,
  };
}
