import React, { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import type { Host, Identity, KnownHost, SftpConnection, SftpFileEntry, SftpFilenameEncoding, SSHKey } from "../../../domain/models";
import { createKnownHostFromHostKeyInfo } from "../../../domain/knownHosts";
import type { SftpHostKeyInfo, SftpHostKeyVerificationState, SftpPane } from "./types";
import { useSftpDirectoryListing } from "./useSftpDirectoryListing";
import { useSftpHostCredentials } from "./useSftpHostCredentials";
import { buildCacheKey, getSharedRemoteHostCache, setSharedRemoteHostCache } from "./sharedRemoteHostCache";
import { resolveRemoteSftpStartState } from "./sftpConnectStartPath";
import { normalizeSftpPaneNavigationPath } from "./utils";
import {
  setDirectoryCacheEntry,
  type DirectoryListingCache,
} from "./directoryListingCache";

interface UseSftpConnectionsParams {
  hosts: Host[];
  keys: SSHKey[];
  identities: Identity[];
  knownHosts?: KnownHost[];
  onAddKnownHost?: (knownHost: KnownHost) => void;
  terminalSettings?: { keepaliveInterval: number; keepaliveCountMax: number };
  leftTabsRef: MutableRefObject<{ tabs: SftpPane[]; activeTabId: string | null }>;
  rightTabsRef: MutableRefObject<{ tabs: SftpPane[]; activeTabId: string | null }>;
  leftTabs: { tabs: SftpPane[] };
  rightTabs: { tabs: SftpPane[] };
  leftPane: SftpPane;
  rightPane: SftpPane;
  setLeftTabs: React.Dispatch<React.SetStateAction<{ tabs: SftpPane[]; activeTabId: string | null }>>;
  setRightTabs: React.Dispatch<React.SetStateAction<{ tabs: SftpPane[]; activeTabId: string | null }>>;
  getActivePane: (side: "left" | "right") => SftpPane | null;
  updateTab: (side: "left" | "right", tabId: string, updater: (prev: SftpPane) => SftpPane) => void;
  navSeqRef: MutableRefObject<{ left: number; right: number }>;
  dirCacheRef: MutableRefObject<DirectoryListingCache>;
  sftpSessionsRef: MutableRefObject<Map<string, string>>;
  disposedRef: MutableRefObject<boolean>;
  browseConnectionLifecycleRef: MutableRefObject<{
    generation: number;
    interactive: boolean;
  }>;
  lastConnectedHostRef: MutableRefObject<{ left: Host | "local" | null; right: Host | "local" | null }>;
  connectionCacheKeyMapRef: MutableRefObject<Map<string, string>>;
  connectedHostByTabIdRef: MutableRefObject<Map<string, Host | "local">>;
  connectInFlightRef: MutableRefObject<Map<string, Promise<void>>>;
  connectRequestByTabIdRef: MutableRefObject<Map<string, symbol>>;
  makeCacheKey: (connectionId: string, path: string, encoding?: SftpFilenameEncoding) => string;
  clearCacheForConnection: (connectionId: string) => void;
  createEmptyPane: (id?: string, showHiddenFiles?: boolean) => SftpPane;
  autoConnectLocalOnMount?: boolean;
  /** Fired after a browse SFTP id is closed so renderer retainers can drop. */
  onRemoteSessionClosed?: (sftpId: string) => void;
}

export interface SftpConnectOptions {
  forceNewTab?: boolean;
  ignoreSharedCache?: boolean;
  initialPath?: string;
  /** Reconnect this tab instead of whichever tab is currently active on the side. */
  tabId?: string;
  onTabCreated?: (tabId: string) => void;
  sourceSessionId?: string;
  /** Fail instead of opening a new route when the requested terminal transport cannot be reused. */
  requireSourceSessionReuse?: boolean;
  /** Prevent a forced terminal-drop route rebind from sharing an older open. */
  connectRequestKey?: string;
  /** Identifies the exact tab and connection created for a route-bound request. */
  onConnectionCreated?: (target: { tabId: string; connectionId: string }) => void;
}

type SftpOpenBridge = Pick<NetcattyBridge, "openSftp"> &
  Partial<Pick<NetcattyBridge, "openSftpForSession">>;

interface OpenSftpWithSessionPreferenceParams {
  bridge: SftpOpenBridge | null | undefined;
  sourceSessionId?: string;
  requireSourceSessionReuse?: boolean;
  openOptions: NetcattySSHOptions;
}

export function takeSftpConnectionMetadataForClose(params: {
  connectionId: string;
  sftpSessions: Map<string, string>;
  connectionCacheKeys: Map<string, string>;
  clearCacheForConnection: (connectionId: string) => void;
}): string | undefined {
  const sftpId = params.sftpSessions.get(params.connectionId);
  params.sftpSessions.delete(params.connectionId);
  params.connectionCacheKeys.delete(params.connectionId);
  params.clearCacheForConnection(params.connectionId);
  return sftpId;
}

export async function releaseSftpConnectionMetadata(params: {
  connectionId: string;
  isLocal?: boolean;
  sftpSessions: Map<string, string>;
  connectionCacheKeys: Map<string, string>;
  clearCacheForConnection: (connectionId: string) => void;
  closeSftp: (sftpId: string) => Promise<unknown>;
  onRemoteSessionClosed?: (sftpId: string) => void;
}): Promise<void> {
  const sftpId = takeSftpConnectionMetadataForClose(params);
  if (params.isLocal || !sftpId) return;
  try {
    await params.closeSftp(sftpId);
  } catch {
    // Best-effort: backend owner cleanup remains the final safety net.
  }
  params.onRemoteSessionClosed?.(sftpId);
}

/** Register a completed open, or close it immediately if its owner unmounted. */
export async function registerOpenedSftpSession(params: {
  disposedRef: MutableRefObject<boolean>;
  canRegister?: () => boolean;
  connectionId: string;
  sftpId: string;
  sftpSessions: Map<string, string>;
  closeSftp: (sftpId: string) => Promise<unknown>;
  onRemoteSessionClosed?: (sftpId: string) => void;
}): Promise<boolean> {
  if (!params.disposedRef.current && (params.canRegister?.() ?? true)) {
    params.sftpSessions.set(params.connectionId, params.sftpId);
    return true;
  }

  try {
    await params.closeSftp(params.sftpId);
  } catch {
    // Best-effort: backend owner cleanup remains the final safety net.
  }
  params.onRemoteSessionClosed?.(params.sftpId);
  return false;
}

/** Hardcoded home-path candidates when SSH exec / listable realpath fail. */
export function buildSftpHomeDirCandidates(username?: string | null): string[] {
  if (username === "root") return ["/root"];
  if (username) return [`/home/${username}`, "/root"];
  return ["/root"];
}

export function createSftpConnectionId(
  side: "left" | "right",
  randomUUID: () => string = () => crypto.randomUUID(),
): string {
  return `${side}-${randomUUID()}`;
}

/** Open SFTP through an already-authenticated terminal session before retrying normal auth. */
export async function openSftpWithSessionPreference({
  bridge,
  sourceSessionId,
  requireSourceSessionReuse = false,
  openOptions,
}: OpenSftpWithSessionPreferenceParams): Promise<string> {
  if (!bridge?.openSftp) throw new Error("SFTP bridge unavailable");
  if (requireSourceSessionReuse && (!sourceSessionId || !bridge.openSftpForSession)) {
    throw new Error("The requested terminal connection is no longer available");
  }
  if (sourceSessionId && bridge.openSftpForSession) {
    try {
      return await bridge.openSftpForSession(sourceSessionId, requireSourceSessionReuse
        ? { ...openOptions, requireExactSourceSession: true }
        : openOptions);
    } catch (error) {
      if (requireSourceSessionReuse) throw error;
      // Fall through to the existing SFTP open path so users still get a usable
      // file browser when the live SSH transport cannot provide an SFTP channel.
    }
  }
  return bridge.openSftp(openOptions);
}

/** One complete SFTP connect attempt: optional shared-channel reuse, then one fresh dial. */
export const openSftpConnectionOnce = openSftpWithSessionPreference;

export function rejectHostKeyVerificationRequest(
  bridge: Partial<Pick<NetcattyBridge, "respondHostKeyVerification">> | null | undefined,
  requestId: string,
): void {
  void bridge?.respondHostKeyVerification?.(requestId, false, false);
}

/**
 * Pinned reconnects must follow a tab across left/right moves. Callers may still
 * pass the side captured at upload start; resolve the tab's live side instead.
 */
export function resolvePinnedReconnectSide(
  requestedSide: "left" | "right",
  tabId: string | undefined,
  leftTabs: ReadonlyArray<{ id: string }>,
  rightTabs: ReadonlyArray<{ id: string }>,
): "left" | "right" {
  if (!tabId) return requestedSide;
  if (leftTabs.some((tab) => tab.id === tabId)) return "left";
  if (rightTabs.some((tab) => tab.id === tabId)) return "right";
  throw new Error("SFTP tab is no longer available");
}

export function createPinnedReconnectSideResolver(
  requestedSide: "left" | "right",
  tabId: string | undefined,
  getLeftTabs: () => ReadonlyArray<{ id: string }>,
  getRightTabs: () => ReadonlyArray<{ id: string }>,
): () => "left" | "right" {
  let lastResolvedSide = requestedSide;
  try {
    lastResolvedSide = resolvePinnedReconnectSide(
      requestedSide,
      tabId,
      getLeftTabs(),
      getRightTabs(),
    );
  } catch {
    // A newly allocated tab is not visible in React refs until the state update
    // commits. Its requested side is authoritative during that brief window.
  }
  return () => {
    try {
      lastResolvedSide = resolvePinnedReconnectSide(
        requestedSide,
        tabId,
        getLeftTabs(),
        getRightTabs(),
      );
    } catch {
      // Keep the last known side so stale-session cleanup remains non-throwing
      // when the tab is closed during an asynchronous reconnect.
    }
    return lastResolvedSide;
  };
}

export function applyToLiveSftpTabSide(params: {
  requestedSide: "left" | "right";
  tabId: string;
  leftTabs: ReadonlyArray<{ id: string }>;
  rightTabs: ReadonlyArray<{ id: string }>;
  apply: (side: "left" | "right") => void;
}): boolean {
  try {
    const liveSide = resolvePinnedReconnectSide(
      params.requestedSide,
      params.tabId,
      params.leftTabs,
      params.rightTabs,
    );
    params.apply(liveSide);
    return true;
  } catch {
    return false;
  }
}

export function resolveSftpReconnectSchedule(params: {
  requestedSide: "left" | "right";
  pane: SftpPane | null | undefined;
  leftTabs: ReadonlyArray<{ id: string }>;
  rightTabs: ReadonlyArray<{ id: string }>;
}): { side: "left" | "right"; tabId: string } | null {
  if (!params.pane?.reconnecting) return null;
  try {
    return {
      side: resolvePinnedReconnectSide(
        params.requestedSide,
        params.pane.id,
        params.leftTabs,
        params.rightTabs,
      ),
      tabId: params.pane.id,
    };
  } catch {
    return null;
  }
}

/** Retry the last terminal transport, then fall through to a fresh/sudo open. */
export function resolveSftpReconnectOptions(
  pane: SftpPane,
): SftpConnectOptions {
  const sourceSessionId = pane.connection?.sourceSessionId;
  return {
    tabId: pane.id,
    ...(sourceSessionId ? { sourceSessionId } : undefined),
  };
}

export function resolveSftpReconnectAttempt(params: {
  isPinnedBackgroundReconnect: boolean;
  initialPath?: string;
  previousPaneReconnecting?: boolean;
  previousConnectionKey: string | null;
  targetConnectionKey: string;
}): boolean {
  if (params.isPinnedBackgroundReconnect) return !!params.initialPath;
  return Boolean(
    params.previousPaneReconnecting
    && params.previousConnectionKey === params.targetConnectionKey,
  );
}

export function resolveSftpPaneEndpointKey(params: {
  connection: SftpConnection | null | undefined;
  cachedConnectionKey?: string | null;
  connectedHost?: Host | "local" | null;
}): string | null {
  const { connection } = params;
  if (!connection) return null;
  if (connection.isLocal) return "local";
  if (params.cachedConnectionKey) return params.cachedConnectionKey;

  const connectedHost = params.connectedHost;
  if (!connectedHost || connectedHost === "local" || connectedHost.id !== connection.hostId) {
    return null;
  }
  return buildCacheKey(
    connectedHost.id,
    connectedHost.hostname,
    connectedHost.port,
    connectedHost.protocol,
    connectedHost.sftpSudo,
    connectedHost.username,
    connectedHost.sftpFileProtocol,
  );
}

export function beginSftpTabConnectRequest(
  requests: Map<string, symbol>,
  tabId: string,
): symbol {
  const token = Symbol(tabId);
  requests.set(tabId, token);
  return token;
}

export function isSftpTabConnectRequestCurrent(
  requests: ReadonlyMap<string, symbol>,
  tabId: string,
  token: symbol,
): boolean {
  return requests.get(tabId) === token;
}

export function finishSftpTabConnectRequest(
  requests: Map<string, symbol>,
  tabId: string,
  token: symbol,
): void {
  if (isSftpTabConnectRequestCurrent(requests, tabId, token)) {
    requests.delete(tabId);
  }
}

export function invalidateSftpTabConnectRequest(
  requests: Map<string, symbol>,
  tabId: string,
): void {
  requests.delete(tabId);
}

export function isSftpHostKeySessionCurrent(
  requests: ReadonlyMap<string, symbol>,
  owner: { tabId: string; connectRequestToken: symbol },
): boolean {
  return isSftpTabConnectRequestCurrent(
    requests,
    owner.tabId,
    owner.connectRequestToken,
  );
}

export async function settleFailedSftpConnectIfCurrent(params: {
  isCurrent: () => boolean;
  close: () => Promise<void>;
  updateFailure: () => void;
}): Promise<boolean> {
  if (!params.isCurrent()) {
    await params.close();
    return false;
  }
  await params.close();
  if (!params.isCurrent()) return false;
  params.updateFailure();
  return true;
}

export async function runSftpTabDisconnectIfLatest(params: {
  requests: Map<string, symbol>;
  tabId: string;
  disconnect: () => Promise<void>;
  clear: () => void;
}): Promise<boolean> {
  const token = beginSftpTabConnectRequest(params.requests, params.tabId);
  try {
    await params.disconnect();
    if (!isSftpTabConnectRequestCurrent(params.requests, params.tabId, token)) {
      return false;
    }
    params.clear();
    return true;
  } finally {
    finishSftpTabConnectRequest(params.requests, params.tabId, token);
  }
}

export async function closeSftpTabLifecycle(params: {
  requestedSide: "left" | "right";
  tabId: string;
  leftTabs: ReadonlyArray<{ id: string }>;
  rightTabs: ReadonlyArray<{ id: string }>;
  connectRequests: Map<string, symbol>;
  connectInFlight: Map<string, Promise<void>>;
  connectedHosts: { delete: (tabId: string) => boolean };
  closeTab: (side: "left" | "right") => void;
  releaseConnection: () => Promise<void>;
}): Promise<void> {
  invalidateSftpTabConnectRequest(params.connectRequests, params.tabId);
  clearSftpConnectInFlightForTab(params.connectInFlight, params.tabId);
  params.connectedHosts.delete(params.tabId);
  applyToLiveSftpTabSide({
    requestedSide: params.requestedSide,
    tabId: params.tabId,
    leftTabs: params.leftTabs,
    rightTabs: params.rightTabs,
    apply: params.closeTab,
  });
  await params.releaseConnection();
}

export function runSftpConnectOnceByKey(
  inFlight: Map<string, Promise<void>>,
  key: string,
  run: () => Promise<void>,
): Promise<void> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = run().finally(() => {
    if (inFlight.get(key) === promise) {
      inFlight.delete(key);
    }
  });
  inFlight.set(key, promise);
  return promise;
}

export function clearSftpConnectInFlightForTab(
  inFlight: Map<string, Promise<void>>,
  tabId: string,
): void {
  const prefix = `${tabId}\u0000`;
  for (const key of inFlight.keys()) {
    if (key.startsWith(prefix)) inFlight.delete(key);
  }
}

export function buildSftpConnectInFlightKey(params: {
  side: "left" | "right";
  tabId: string;
  targetConnectionKey: string;
  sourceSessionId?: string;
  requireSourceSessionReuse?: boolean;
  initialPath?: string;
  forceNewTab?: boolean;
  browseLifecycleGeneration?: number;
  connectRequestKey?: string;
}): string {
  return [
    params.tabId,
    params.targetConnectionKey,
    params.sourceSessionId ?? "",
    params.requireSourceSessionReuse ? "strict-source" : "",
    params.initialPath ?? "",
    params.forceNewTab ? "force-new-tab" : "",
    params.browseLifecycleGeneration ?? 0,
    params.connectRequestKey ?? "",
  ].join("\u0000");
}

/** Resolve reconnect identity from the active tab before side-wide history. */
export function resolveSftpReconnectHost(params: {
  pane: SftpPane | null | undefined;
  lastHost: Host | "local" | null;
  connectedHostByTabId: ReadonlyMap<string, Host | "local">;
  hosts: ReadonlyArray<Host>;
}): Host | "local" | null {
  const connection = params.pane?.connection;
  if (!connection) return params.lastHost;

  const tabHost = params.pane
    ? params.connectedHostByTabId.get(params.pane.id) ?? null
    : null;
  if (connection.isLocal) {
    return tabHost === "local" ? tabHost : "local";
  }
  if (tabHost && tabHost !== "local" && tabHost.id === connection.hostId) {
    return tabHost;
  }
  const vaultHost = params.hosts.find((candidate) => candidate.id === connection.hostId) ?? null;
  if (vaultHost) return vaultHost;
  if (
    params.lastHost
    && params.lastHost !== "local"
    && params.lastHost.id === connection.hostId
  ) return params.lastHost;
  return null;
}

interface UseSftpConnectionsResult {
  connect: (side: "left" | "right", host: Host | "local", options?: SftpConnectOptions) => Promise<void>;
  disconnect: (side: "left" | "right") => Promise<void>;
  listLocalFiles: (path: string) => Promise<SftpFileEntry[]>;
  listRemoteFiles: (sftpId: string, path: string, encoding?: SftpFilenameEncoding) => Promise<SftpFileEntry[]>;
  hostKeyVerification: SftpHostKeyVerificationState | null;
  rejectHostKeyVerification: () => void;
  acceptHostKeyVerification: () => void;
  acceptAndSaveHostKeyVerification: () => void;
}

type HostKeyVerificationRequest = SftpHostKeyInfo & {
  requestId: string;
  sessionId?: string;
};

type ActiveHostKeySession = {
  side: "left" | "right";
  tabId: string;
  connectRequestToken: symbol;
};

type PendingHostKeyVerification = SftpHostKeyVerificationState & {
  requestId: string;
  sessionId: string;
  tabId: string;
  connectRequestToken: symbol;
};

const toSftpHostKeyInfo = (request: HostKeyVerificationRequest): SftpHostKeyInfo => ({
  hostname: request.hostname,
  port: request.port || 22,
  keyType: request.keyType,
  fingerprint: request.fingerprint,
  publicKey: request.publicKey,
  status: request.status,
  knownHostId: request.knownHostId,
  knownFingerprint: request.knownFingerprint,
});

const createKnownHostFromSftpHostKeyInfo = (
  hostKeyInfo: SftpHostKeyInfo,
  now = Date.now(),
  idSuffix = Math.random().toString(36).slice(2, 11),
): KnownHost => createKnownHostFromHostKeyInfo(hostKeyInfo, { now, idSuffix });

export const useSftpConnections = ({
  hosts,
  keys,
  identities,
  knownHosts,
  onAddKnownHost,
  terminalSettings,
  leftTabsRef,
  rightTabsRef,
  leftTabs,
  rightTabs: _rightTabs,
  leftPane,
  rightPane,
  setLeftTabs,
  setRightTabs,
  getActivePane,
  updateTab,
  navSeqRef,
  dirCacheRef,
  sftpSessionsRef,
  disposedRef,
  browseConnectionLifecycleRef,
  lastConnectedHostRef,
  connectionCacheKeyMapRef,
  connectedHostByTabIdRef,
  connectInFlightRef,
  connectRequestByTabIdRef,
  makeCacheKey,
  clearCacheForConnection,
  createEmptyPane,
  autoConnectLocalOnMount = true,
  onRemoteSessionClosed,
}: UseSftpConnectionsParams): UseSftpConnectionsResult => {
  const onRemoteSessionClosedRef = useRef(onRemoteSessionClosed);
  onRemoteSessionClosedRef.current = onRemoteSessionClosed;
  const notifyRemoteSessionClosed = useCallback((sftpId: string | undefined) => {
    if (sftpId) onRemoteSessionClosedRef.current?.(sftpId);
  }, []);
  const getHostCredentials = useSftpHostCredentials({ hosts, keys, identities, knownHosts, terminalSettings });
  const { listLocalFiles, listRemoteFiles } = useSftpDirectoryListing();
  const [hostKeyVerification, setHostKeyVerification] = useState<SftpHostKeyVerificationState | null>(null);
  const hostKeyVerificationRef = useRef<PendingHostKeyVerification | null>(null);
  const activeHostKeySessionsRef = useRef<Map<string, ActiveHostKeySession>>(new Map());

  const setPendingHostKeyVerification = useCallback((
    next: PendingHostKeyVerification | null,
  ) => {
    hostKeyVerificationRef.current = next;
    setHostKeyVerification(next ? {
      hostKeyInfo: next.hostKeyInfo,
      progressLogs: next.progressLogs,
    } : null);
  }, []);

  useEffect(() => {
    const dispose = netcattyBridge.get()?.onHostKeyVerification?.((request: HostKeyVerificationRequest) => {
      const sessionId = request.sessionId;
      if (!sessionId) return;
      const activeSession = activeHostKeySessionsRef.current.get(sessionId);
      if (!activeSession) return;
      if (!isSftpHostKeySessionCurrent(connectRequestByTabIdRef.current, activeSession)) {
        rejectHostKeyVerificationRequest(netcattyBridge.get(), request.requestId);
        return;
      }

      const hostKeyInfo = toSftpHostKeyInfo(request);
      const logLine = request.status === "changed"
        ? `Host key changed for ${request.hostname}. Waiting for confirmation...`
        : `Host key verification required for ${request.hostname}.`;

      let activeSide: "left" | "right";
      try {
        activeSide = resolvePinnedReconnectSide(
          activeSession.side,
          activeSession.tabId,
          leftTabsRef.current.tabs,
          rightTabsRef.current.tabs,
        );
      } catch {
        rejectHostKeyVerificationRequest(netcattyBridge.get(), request.requestId);
        return;
      }
      updateTab(activeSide, activeSession.tabId, (prev) => ({
        ...prev,
        connectionLogs: [...prev.connectionLogs, logLine],
      }));
      setPendingHostKeyVerification({
        requestId: request.requestId,
        sessionId,
        tabId: activeSession.tabId,
        connectRequestToken: activeSession.connectRequestToken,
        hostKeyInfo,
        progressLogs: [logLine],
      });
    });

    return () => {
      dispose?.();
    };
  }, [connectRequestByTabIdRef, leftTabsRef, rightTabsRef, setPendingHostKeyVerification, updateTab]);

  const respondToHostKeyVerification = useCallback((accept: boolean, addToKnownHosts = false) => {
    const pending = hostKeyVerificationRef.current;
    if (!pending) return;
    const owner = activeHostKeySessionsRef.current.get(pending.sessionId);
    if (!owner || !isSftpHostKeySessionCurrent(connectRequestByTabIdRef.current, owner)) {
      rejectHostKeyVerificationRequest(netcattyBridge.get(), pending.requestId);
      setPendingHostKeyVerification(null);
      return;
    }
    if (accept && addToKnownHosts) {
      onAddKnownHost?.(createKnownHostFromSftpHostKeyInfo(pending.hostKeyInfo));
    }
    void netcattyBridge.get()?.respondHostKeyVerification?.(
      pending.requestId,
      accept,
      addToKnownHosts,
    );
    setPendingHostKeyVerification(null);
  }, [connectRequestByTabIdRef, onAddKnownHost, setPendingHostKeyVerification]);

  const rejectHostKeyVerification = useCallback(() => {
    respondToHostKeyVerification(false);
  }, [respondToHostKeyVerification]);

  const acceptHostKeyVerification = useCallback(() => {
    respondToHostKeyVerification(true, false);
  }, [respondToHostKeyVerification]);

  const acceptAndSaveHostKeyVerification = useCallback(() => {
    respondToHostKeyVerification(true, true);
  }, [respondToHostKeyVerification]);

  const connect = useCallback(
    async (requestedSide: "left" | "right", host: Host | "local", options?: SftpConnectOptions) => {
      // Follow pinned tabs that were dragged to the other side mid-reconnect.
      const resolveRequestedSide = createPinnedReconnectSideResolver(
        requestedSide,
        options?.tabId,
        () => leftTabsRef.current.tabs,
        () => rightTabsRef.current.tabs,
      );
      const side = resolveRequestedSide();
      const setTabs = side === "left" ? setLeftTabs : setRightTabs;

      let activeTabId: string | null = null;
      const sideTabs = side === "left" ? leftTabsRef.current : rightTabsRef.current;

      if (options?.tabId) {
        // Background reconnect for a pinned upload must not retarget the focused tab.
        activeTabId = options.tabId;
      } else if (!sideTabs.activeTabId || options?.forceNewTab) {
        const newPane = createEmptyPane();
        activeTabId = newPane.id;
        setTabs((prev) => ({
          tabs: [...prev.tabs, newPane],
          activeTabId: newPane.id,
        }));
      } else {
        activeTabId = sideTabs.activeTabId;
      }

      if (!activeTabId) return;

      // Once a tab has been selected or allocated, follow that exact tab if it
      // is dragged across panes while the asynchronous connect is in flight.
      const resolveTargetSide = createPinnedReconnectSideResolver(
        side,
        activeTabId,
        () => leftTabsRef.current.tabs,
        () => rightTabsRef.current.tabs,
      );

      // Pinned reconnect of a non-active tab must not clobber the active tab's
      // lastConnectedHost / reconnecting recovery state on this side.
      const isPinnedBackgroundReconnect =
        !!options?.tabId
        && !!sideTabs.activeTabId
        && options.tabId !== sideTabs.activeTabId;
      const getTargetPaneEarly = () => {
        const targetSide = resolveTargetSide();
        const tabs = targetSide === "left" ? leftTabsRef.current.tabs : rightTabsRef.current.tabs;
        return tabs.find((tab) => tab.id === activeTabId) ?? null;
      };
      const updateTargetTab = (updater: (prev: SftpPane) => SftpPane) => {
        updateTab(resolveTargetSide(), activeTabId, updater);
      };

      // Capture path/endpoint before we replace the connection so same-endpoint
      // auto-reconnect can land back where the user was browsing instead of home.
      // Do not inherit path across endpoints (including same hostId with different
      // hostname/port/user) if a reconnect flag is still set while switching.
      const previousPane = getTargetPaneEarly();
      const previousConnection = previousPane?.connection;
      const previousPath = previousConnection?.currentPath;
      const previousConnectionKey = resolveSftpPaneEndpointKey({
        connection: previousConnection,
        cachedConnectionKey: previousConnection
          ? connectionCacheKeyMapRef.current.get(previousConnection.id)
          : null,
        connectedHost: connectedHostByTabIdRef.current.get(activeTabId) ?? null,
      });
      const targetConnectionKey = host === "local"
        ? "local"
        : buildCacheKey(
          host.id,
          host.hostname,
          host.port,
          host.protocol,
          host.sftpSudo,
          host.username,
          host.sftpFileProtocol,
        );
      // Reconnect state belongs to the exact tab, not the side it occupies.
      const isReconnectAttempt = resolveSftpReconnectAttempt({
        isPinnedBackgroundReconnect,
        initialPath: options?.initialPath,
        previousPaneReconnecting: previousPane?.reconnecting,
        previousConnectionKey,
        targetConnectionKey,
      });
      const sameEndpointReconnect =
        isReconnectAttempt
        && !!previousPath
        && previousConnectionKey === targetConnectionKey;
      const effectiveInitialPath =
        options?.initialPath
        ?? (sameEndpointReconnect ? previousPath : undefined);

      // Notify caller of the tab ID synchronously, before any async work.
      // This allows callers to map metadata (e.g. connection keys) to the tab
      // immediately, avoiding race conditions with deferred effects.
      options?.onTabCreated?.(activeTabId);

      const connectInFlightKey = buildSftpConnectInFlightKey({
        side,
        tabId: activeTabId,
        targetConnectionKey,
        sourceSessionId: host === "local" ? undefined : options?.sourceSessionId,
        requireSourceSessionReuse: host === "local" ? false : options?.requireSourceSessionReuse,
        initialPath: effectiveInitialPath,
        forceNewTab: options?.forceNewTab,
        browseLifecycleGeneration: browseConnectionLifecycleRef.current.generation,
        connectRequestKey: options?.connectRequestKey,
      });

      return runSftpConnectOnceByKey(connectInFlightRef.current, connectInFlightKey, async () => {
        const connectRequestToken = beginSftpTabConnectRequest(
          connectRequestByTabIdRef.current,
          activeTabId,
        );
        const isConnectRequestCurrent = () => isSftpTabConnectRequestCurrent(
          connectRequestByTabIdRef.current,
          activeTabId,
          connectRequestToken,
        );
        const pendingHostKey = hostKeyVerificationRef.current;
        if (
          pendingHostKey?.tabId === activeTabId
          && pendingHostKey.connectRequestToken !== connectRequestToken
        ) {
          rejectHostKeyVerificationRequest(netcattyBridge.get(), pendingHostKey.requestId);
          setPendingHostKeyVerification(null);
        }
        try {
        const browseLifecycleGeneration = browseConnectionLifecycleRef.current.generation;
        const connectionId = createSftpConnectionId(side);
        options?.onConnectionCreated?.({ tabId: activeTabId, connectionId });

        navSeqRef.current[side] += 1;
        const connectRequestId = navSeqRef.current[side];
        const getTargetPane = () => {
          const targetSide = resolveTargetSide();
          const tabs = targetSide === "left" ? leftTabsRef.current.tabs : rightTabsRef.current.tabs;
          return tabs.find((tab) => tab.id === activeTabId) ?? null;
        };
        const isTargetConnectionCurrent = () => {
          if (!isConnectRequestCurrent()) return false;
          const pane = getTargetPane();
          if (!pane) return false;
          if (pane.connection?.id === connectionId) return true;
          return !pane.connection && navSeqRef.current[side] === connectRequestId;
        };
      const isTargetConnectionAtPath = (path: string) => {
        if (!isConnectRequestCurrent()) return false;
        const connection = getTargetPane()?.connection;
        if (!connection) return navSeqRef.current[side] === connectRequestId;
        return connection?.id === connectionId && connection.currentPath === path;
      };
      const closeSftpSessionForConnection = async () => {
        await releaseSftpConnectionMetadata({
          connectionId,
          sftpSessions: sftpSessionsRef.current,
          connectionCacheKeys: connectionCacheKeyMapRef.current,
          clearCacheForConnection,
          closeSftp: async (sftpId) => netcattyBridge.get()?.closeSftp(sftpId),
          onRemoteSessionClosed: (sftpId) => notifyRemoteSessionClosed(sftpId),
        });
      };

      // Keep side-wide recovery host pointed at the active tab only.
      if (!isPinnedBackgroundReconnect) {
        lastConnectedHostRef.current[side] = host;
      }
      // Always remember the full connect-time Host for this tab so background
      // upload reconnects can restore session-time overrides (not just vault hostId).
      connectedHostByTabIdRef.current.set(activeTabId, host);
      // Store the cache key for this connection so pane actions can look it up
      // by connectionId instead of relying on the per-side lastConnectedHostRef.
      if (host !== "local") {
        connectionCacheKeyMapRef.current.set(
          connectionId,
          buildCacheKey(host.id, host.hostname, host.port, host.protocol, host.sftpSudo, host.username, host.sftpFileProtocol),
        );
      }

      const currentPane = getTargetPaneEarly();
      // Reset encoding to host's configured encoding or "auto" when connecting to a new host
      // This ensures proper auto-detection works and respects host-level encoding settings
      const filenameEncoding: SftpFilenameEncoding =
        host === "local" ? "auto" : (host.sftpEncoding ?? "auto");

      // When forceNewTab is set, we're preserving the old tab for instant switching —
      // don't close its SFTP session or clear its cache.
      if (!options?.forceNewTab) {
        if (currentPane?.connection) {
          const oldSftpId = takeSftpConnectionMetadataForClose({
            connectionId: currentPane.connection.id,
            sftpSessions: sftpSessionsRef.current,
            connectionCacheKeys: connectionCacheKeyMapRef.current,
            clearCacheForConnection,
          });
          if (!currentPane.connection.isLocal && oldSftpId) {
            try {
              await netcattyBridge.get()?.closeSftp(oldSftpId);
            } catch {
              // Ignore errors when closing stale SFTP sessions
            }
            notifyRemoteSessionClosed(oldSftpId);
          }
        }
      }

      if (!isConnectRequestCurrent()) {
        await closeSftpSessionForConnection();
        return;
      }

      if (host === "local") {
        let homeDir = await netcattyBridge.get()?.getHomeDir?.();
        if (!isConnectRequestCurrent()) {
          await closeSftpSessionForConnection();
          return;
        }
        if (!homeDir) {
          const isWindows = navigator.platform.toLowerCase().includes("win");
          homeDir = isWindows ? "C:\\Users\\damao" : "/Users/damao";
        }

        const startPath = normalizeSftpPaneNavigationPath(
          effectiveInitialPath || homeDir,
          homeDir,
        );

        const connection: SftpConnection = {
          id: connectionId,
          hostId: "local",
          hostLabel: "Local",
          isLocal: true,
          status: "connected",
          currentPath: startPath,
          homeDir,
        };

        updateTargetTab((prev) => ({
          ...prev,
          connection,
          loading: true,
          reconnecting: false,
          error: null,
          connectionLogs: [],
          filenameEncoding, // Reset encoding for new connection
        }));

        try {
          const files = await listLocalFiles(startPath);
          if (!isTargetConnectionAtPath(startPath)) return;
          setDirectoryCacheEntry(dirCacheRef.current, makeCacheKey(connectionId, startPath, filenameEncoding), {
            files,
            timestamp: Date.now(),
          });
          updateTargetTab((prev) => ({
            ...prev,
            files,
            loading: false,
            reconnecting: false,
          }));
        } catch (err) {
          if (!isTargetConnectionAtPath(startPath)) return;
          updateTargetTab((prev) => ({
            ...prev,
            error: err instanceof Error ? err.message : "Failed to list directory",
            loading: false,
            reconnecting: false,
          }));
        }
      } else {
        const hostCacheKey = buildCacheKey(host.id, host.hostname, host.port, host.protocol, host.sftpSudo, host.username, host.sftpFileProtocol);
        const sharedHostCacheCandidate = options?.ignoreSharedCache
          ? null
          : getSharedRemoteHostCache(hostCacheKey);
        const { initialPath, sharedHostCache, cachedStartPath } = resolveRemoteSftpStartState({
          filenameEncoding,
          ignoreSharedCache: options?.ignoreSharedCache,
          initialPath: effectiveInitialPath,
          sharedHostCacheCandidate,
        });
        const normalizedCachedStartPath = normalizeSftpPaneNavigationPath(
          cachedStartPath,
          sharedHostCache?.homeDir,
          sharedHostCache?.path,
        );

        const sourceSessionId = options?.sourceSessionId;
        const requireSourceSessionReuse = options?.requireSourceSessionReuse === true;

        const connection: SftpConnection = {
          id: connectionId,
          hostId: host.id,
          hostLabel: host.label,
          isLocal: false,
          status: "connecting",
          currentPath: normalizedCachedStartPath,
          // Suppress loading animation when connection reuse is requested.
          // If the backend falls back to a fresh connection, the pane stays
          // non-interactive (loading=true) with stale cached files visible —
          // no worse than the previous UX of always showing a spinner.
          reusedConnection: !!sourceSessionId,
          sourceSessionId: requireSourceSessionReuse ? sourceSessionId : undefined,
          fileProtocol: host.sftpFileProtocol ?? 'auto',
        };

        updateTargetTab((prev) => ({
          ...prev,
          connection,
          // Always show loading while connecting — even with cached files.
          // The cached file list is shown as a preview, but the pane stays
          // non-interactive until the SFTP session is actually established.
          loading: true,
          reconnecting: isReconnectAttempt,
          error: null,
          connectionLogs: [],
          files: isReconnectAttempt ? prev.files : (sharedHostCache?.files ?? []),
          filenameEncoding, // Reset encoding for new connection
        }));

        // Subscribe to SFTP connection progress events for auth logging
        const sftpSessionId = `sftp-${connectionId}`;
        activeHostKeySessionsRef.current.set(sftpSessionId, {
          side,
          tabId: activeTabId,
          connectRequestToken,
        });
        let unsubSftpProgress: (() => void) | undefined;
        const bridge = netcattyBridge.get();
        if (bridge?.onSftpConnectionProgress) {
          unsubSftpProgress = bridge.onSftpConnectionProgress((sid, label, status, detail) => {
            if (sid !== sftpSessionId) return;
            let logLine: string;
            switch (status) {
              case 'connecting':
                logLine = `Connecting to ${label}...`;
                break;
              case 'authenticating':
                logLine = `${label} - Key exchange complete`;
                break;
              case 'auth-attempt':
                if (detail?.endsWith('rejected')) {
                  logLine = `${label} - ✗ ${detail}`;
                } else if (detail === 'all methods exhausted') {
                  logLine = `${label} - ✗ All authentication methods exhausted`;
                } else if (detail === 'waiting for user input...' || detail === 'user responded') {
                  logLine = `${label} - ${detail}`;
                } else {
                  logLine = `${label} - Trying ${detail}...`;
                }
                break;
              case 'connected':
                logLine = `${label} - Connected`;
                break;
              case 'error':
                logLine = `${label} - Error${detail ? `: ${detail}` : ''}`;
                break;
              default:
                logLine = `${label} - ${status}${detail ? `: ${detail}` : ''}`;
            }
            // Only update if this is still the active request (avoids stale logs leaking)
            if (!isTargetConnectionCurrent()) return;
            updateTargetTab((prev) => ({
              ...prev,
              connectionLogs: [...prev.connectionLogs, logLine],
            }));
          });
        }

        try {
          const openSftp = bridge?.openSftp;
          if (!openSftp) throw new Error("SFTP bridge unavailable");

          const credentials = getHostCredentials(host);
          // The main-process SSH auth driver owns key/password/MFA fallback.
          // Keep one renderer connect entry so a failed fresh dial is never
          // immediately repeated after a shared-channel attempt fails.
          const sftpId = await openSftpConnectionOnce({
            bridge,
            sourceSessionId,
            requireSourceSessionReuse,
            openOptions: {
              sessionId: sftpSessionId,
              ...credentials,
            },
          });

          if (!sftpId) throw new Error("Failed to open SFTP session");

          const registered = await registerOpenedSftpSession({
            disposedRef,
            canRegister: () => (
              browseConnectionLifecycleRef.current.interactive
              && browseConnectionLifecycleRef.current.generation === browseLifecycleGeneration
            ),
            connectionId,
            sftpId,
            sftpSessions: sftpSessionsRef.current,
            closeSftp: async (openedSftpId) => bridge.closeSftp(openedSftpId),
            onRemoteSessionClosed: notifyRemoteSessionClosed,
          });
          if (!registered) return;
          if (!isTargetConnectionCurrent()) {
            await closeSftpSessionForConnection();
            return;
          }

          let startPath = sharedHostCache?.path ?? "/";
          let homeDir = sharedHostCache?.homeDir ?? startPath;

          if (!sharedHostCache) {
            // Detect home directory: SSH exec `echo ~` → SFTP realpath('.') → hardcoded fallback
            const bridge = netcattyBridge.get();
            let detected = false;

            if (bridge?.getSftpHomeDir) {
              try {
                const result = await bridge.getSftpHomeDir(sftpId, host.sftpEncoding);
                if (result?.success && result.homeDir) {
                  startPath = result.homeDir;
                  homeDir = result.homeDir;
                  detected = true;
                }
              } catch {
                // Fall through to hardcoded candidates
              }
            }

            if (!detected) {
              const candidates = buildSftpHomeDirCandidates(credentials.username);
              const statSftp = bridge?.statSftp;
              if (statSftp) {
                for (const candidate of candidates) {
                  try {
                    const stat = await statSftp(sftpId, candidate, filenameEncoding);
                    if (stat?.type === "directory") {
                      startPath = candidate;
                      homeDir = candidate;
                      break;
                    }
                  } catch {
                    // Ignore missing/permission errors
                  }
                }
              } else {
                // Fallback: probe candidates via listSftp when statSftp is unavailable
                for (const candidate of candidates) {
                  try {
                    const files = await bridge?.listSftp(sftpId, candidate, filenameEncoding);
                    if (files) {
                      startPath = candidate;
                      homeDir = candidate;
                      break;
                    }
                  } catch {
                    // Ignore missing/permission errors
                  }
                }
              }
            }
          }

          if (initialPath) {
            startPath = initialPath;
          }
          startPath = normalizeSftpPaneNavigationPath(startPath, homeDir);

          const provisionalCacheKey = sharedHostCache
            ? makeCacheKey(connectionId, startPath, filenameEncoding)
            : null;
          if (sharedHostCache && provisionalCacheKey) {
            setDirectoryCacheEntry(dirCacheRef.current, provisionalCacheKey, {
              files: sharedHostCache.files,
              timestamp: Date.now(),
            });
          }

          let files: SftpFileEntry[] = [];
          try {
            files = await listRemoteFiles(sftpId, startPath, filenameEncoding);
          } catch {
            // Cached path may be stale (deleted, permissions changed).
            // Remove the provisional cache entry so phantom files don't resurface.
            if (provisionalCacheKey) {
              dirCacheRef.current.delete(provisionalCacheKey);
            }
            // Fall back to homeDir, then "/", chaining attempts.
            // Remembered/reconnect paths can be stale even when shared cache is gone.
            let fallbackSucceeded = false;
            if (startPath !== homeDir) {
              try {
                startPath = homeDir;
                files = await listRemoteFiles(sftpId, startPath, filenameEncoding);
                fallbackSucceeded = true;
              } catch {
                // homeDir also failed, try root
              }
            }
            if (!fallbackSucceeded && startPath !== "/") {
              try {
                startPath = "/";
                files = await listRemoteFiles(sftpId, startPath, filenameEncoding);
                fallbackSucceeded = true;
              } catch {
                // root also failed
              }
            }
            // Last resort: home candidates. Covers provisional "/" from realpath
            // when discovery treated root as home and listing it failed, so
            // /home/<user> or /root can still recover the session.
            if (!fallbackSucceeded) {
              for (const candidate of buildSftpHomeDirCandidates(credentials.username)) {
                if (candidate === startPath) continue;
                try {
                  files = await listRemoteFiles(sftpId, candidate, filenameEncoding);
                  startPath = candidate;
                  homeDir = candidate;
                  fallbackSucceeded = true;
                  break;
                } catch {
                  // Ignore missing/permission errors
                }
              }
            }
            if (!fallbackSucceeded) {
              throw new Error("Cannot list any remote directory");
            }
          }
          if (!isTargetConnectionCurrent()) {
            await closeSftpSessionForConnection();
            return;
          }
          setDirectoryCacheEntry(dirCacheRef.current, makeCacheKey(connectionId, startPath, filenameEncoding), {
            files,
            timestamp: Date.now(),
          });
          setSharedRemoteHostCache(hostCacheKey, {
            path: startPath,
            homeDir,
            files,
            filenameEncoding,
          });

          updateTargetTab((prev) => ({
            ...prev,
            connection: prev.connection
              ? {
                  ...prev.connection,
                  status: "connected",
                  currentPath: startPath,
                  homeDir,
                  reusedConnection: undefined,
                }
              : null,
            files,
            loading: false,
            reconnecting: false,
            connectionLogs: [], // Clear after successful connect to avoid replay during navigation
          }));
        } catch (err) {
          await settleFailedSftpConnectIfCurrent({
            isCurrent: isTargetConnectionCurrent,
            close: closeSftpSessionForConnection,
            updateFailure: () => {
              updateTargetTab((prev) => ({
                ...prev,
                connection: prev.connection
                  ? {
                      ...prev.connection,
                      status: "error",
                      error: err instanceof Error ? err.message : "Connection failed",
                    }
                  : null,
                files: isReconnectAttempt ? [] : prev.files,
                selectedFiles: isReconnectAttempt ? new Set<string>() : prev.selectedFiles,
                error: isReconnectAttempt
                  ? "sftp.error.reconnectFailed"
                  : (err instanceof Error ? err.message : "Connection failed"),
                loading: false,
                reconnecting: false,
              }));
            },
          });
        } finally {
          activeHostKeySessionsRef.current.delete(sftpSessionId);
          if (hostKeyVerificationRef.current?.sessionId === sftpSessionId) {
            setPendingHostKeyVerification(null);
          }
          unsubSftpProgress?.();
        }
      }
        } finally {
          finishSftpTabConnectRequest(
            connectRequestByTabIdRef.current,
            activeTabId,
            connectRequestToken,
          );
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      getHostCredentials,
      getActivePane,
      updateTab,
      clearCacheForConnection,
      createEmptyPane,
      makeCacheKey,
      listLocalFiles,
      listRemoteFiles,
      setPendingHostKeyVerification,
      browseConnectionLifecycleRef,
    ],
  );

  const initialConnectDoneRef = useRef(false);

  useEffect(() => {
    if (
      autoConnectLocalOnMount &&
      !initialConnectDoneRef.current &&
      leftTabs.tabs.length === 0
    ) {
      const timer = window.setTimeout(() => {
        initialConnectDoneRef.current = true;
        connect("left", "local");
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [autoConnectLocalOnMount, connect, leftTabs.tabs.length]);

  useEffect(() => {
    const reconnectTimers: number[] = [];

    const resolveReconnectHost = (
      side: "left" | "right",
      pane: SftpPane | null = getActivePane(side),
    ): Host | "local" | null => {
      const host = resolveSftpReconnectHost({
        pane,
        lastHost: lastConnectedHostRef.current[side],
        connectedHostByTabId: connectedHostByTabIdRef.current,
        hosts,
      });
      if (host) {
        // Keep legacy side-wide recovery state aligned with the active tab.
        lastConnectedHostRef.current[side] = host;
      }
      return host;
    };

    const scheduleReconnect = (requestedSide: "left" | "right", pane: SftpPane | null) => {
      const schedule = resolveSftpReconnectSchedule({
        requestedSide,
        pane,
        leftTabs: leftTabsRef.current.tabs,
        rightTabs: rightTabsRef.current.tabs,
      });
      if (!schedule) return;

      const timer = window.setTimeout(() => {
        const livePane = [
          ...leftTabsRef.current.tabs,
          ...rightTabsRef.current.tabs,
        ].find((candidate) => candidate.id === schedule.tabId) ?? null;
        const liveSchedule = resolveSftpReconnectSchedule({
          requestedSide: schedule.side,
          pane: livePane,
          leftTabs: leftTabsRef.current.tabs,
          rightTabs: rightTabsRef.current.tabs,
        });
        if (!liveSchedule) return;
        const host = resolveReconnectHost(liveSchedule.side, livePane);
        if (!host) return;
        if (!livePane) return;
        void connect(
          liveSchedule.side,
          host,
          resolveSftpReconnectOptions(livePane),
        );
      }, 1000);
      reconnectTimers.push(timer);
    };

    scheduleReconnect("left", leftPane);
    scheduleReconnect("right", rightPane);

    return () => {
      reconnectTimers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [
    leftPane,
    rightPane,
    leftTabsRef,
    rightTabsRef,
    connect,
    connectedHostByTabIdRef,
    getActivePane,
    hosts,
    lastConnectedHostRef,
  ]);

  const disconnect = useCallback(
    async (side: "left" | "right") => {
      const pane = getActivePane(side);
      const sideTabs = side === "left" ? leftTabsRef.current : rightTabsRef.current;
      const activeTabId = sideTabs.activeTabId;

      if (!pane || !activeTabId) return;

      await runSftpTabDisconnectIfLatest({
        requests: connectRequestByTabIdRef.current,
        tabId: activeTabId,
        disconnect: async () => {
          clearSftpConnectInFlightForTab(connectInFlightRef.current, activeTabId);
          const pendingHostKey = hostKeyVerificationRef.current;
          if (pendingHostKey?.tabId === activeTabId) {
            rejectHostKeyVerificationRequest(netcattyBridge.get(), pendingHostKey.requestId);
            setPendingHostKeyVerification(null);
          }
          navSeqRef.current[side] += 1;

          const sftpId = pane.connection
            ? takeSftpConnectionMetadataForClose({
              connectionId: pane.connection.id,
              sftpSessions: sftpSessionsRef.current,
              connectionCacheKeys: connectionCacheKeyMapRef.current,
              clearCacheForConnection,
            })
            : undefined;

          lastConnectedHostRef.current[side] = null;
          connectedHostByTabIdRef.current.delete(activeTabId);

          if (pane.connection && !pane.connection.isLocal && sftpId) {
            try {
              await netcattyBridge.get()?.closeSftp(sftpId);
            } catch {
              // Ignore errors when closing SFTP session during disconnect
            }
            notifyRemoteSessionClosed(sftpId);
          }
        },
        clear: () => {
          applyToLiveSftpTabSide({
            requestedSide: side,
            tabId: activeTabId,
            leftTabs: leftTabsRef.current.tabs,
            rightTabs: rightTabsRef.current.tabs,
            apply: (liveSide) => {
              updateTab(liveSide, activeTabId, () => createEmptyPane(activeTabId, pane.showHiddenFiles));
            },
          });
        },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getActivePane, clearCacheForConnection, updateTab],
  );

  return {
    connect,
    disconnect,
    listLocalFiles,
    listRemoteFiles,
    hostKeyVerification,
    rejectHostKeyVerification,
    acceptHostKeyVerification,
    acceptAndSaveHostKeyVerification,
  };
};
