import type { Host } from '../../domain/models';
import { redactHostForAgent } from '../../domain/agentAsset';
import { netcattyBridge } from '../services/netcattyBridge';

type AgentSession = {
  id: string;
  hostId?: string;
  status?: string;
  workspaceId?: string;
};

export interface AssetActionDeps {
  getHosts: () => Host[];
  getSessions: () => AgentSession[];
  resolveEffectiveHost: (host: Host) => Host;
  openHost: (hostId: string) => void;
  connectHost: (host: Host) => string | void;
  closeSession: (sessionId: string) => boolean | void;
  focusSession: (sessionId: string) => void;
}

function sessionSummary(session: AgentSession) {
  return {
    sessionId: session.id,
    hostId: session.hostId,
    status: session.status,
    workspaceId: session.workspaceId,
  };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function findHost(deps: AssetActionDeps, hostId: string): Host | undefined {
  return deps.getHosts().find((entry) => entry.id === hostId);
}

function findMatchingSessions(
  deps: AssetActionDeps,
  {
    hostId,
    sessionId,
  }: {
    hostId: string;
    sessionId: string;
  },
): AgentSession[] {
  return deps.getSessions().filter((entry) => {
    if (sessionId) return entry.id === sessionId && (!hostId || entry.hostId === hostId);
    if (hostId) return entry.hostId === hostId;
    return false;
  });
}

function sessionHostMismatchError(sessionId: string, hostId: string) {
  return {
    ok: false,
    error: `Session "${sessionId}" does not belong to host "${hostId}".`,
  };
}

export async function handleAssetActionOp(
  op: string,
  params: Record<string, unknown> = {},
  deps: AssetActionDeps,
) {
  const hostId = readString(params.hostId);
  const sessionId = readString(params.sessionId);

  switch (op) {
    case 'asset.open': {
      if (!hostId) return { ok: false, error: 'hostId is required.' };
      const host = findHost(deps, hostId);
      if (!host) return { ok: false, error: 'Host not found.' };
      deps.openHost(hostId);
      return {
        ok: true,
        asset: redactHostForAgent(deps.resolveEffectiveHost(host)),
      };
    }

    case 'asset.connect': {
      if (!hostId) return { ok: false, error: 'hostId is required.' };
      const host = findHost(deps, hostId);
      if (!host) return { ok: false, error: 'Host not found.' };
      const effectiveHost = deps.resolveEffectiveHost(host);
      if ((effectiveHost.protocol ?? 'ssh') !== 'ssh') {
        return { ok: false, error: 'Only SSH host assets are supported for connect operations.' };
      }
      const newSessionId = deps.connectHost(host);
      if (typeof newSessionId === 'string' && newSessionId) {
        deps.focusSession(newSessionId);
      }
      return {
        ok: true,
        asset: redactHostForAgent(effectiveHost),
        sessionId: typeof newSessionId === 'string' ? newSessionId : undefined,
      };
    }

    case 'asset.disconnect': {
      if (sessionId && hostId) {
        const session = deps.getSessions().find((entry) => entry.id === sessionId);
        if (session && session.hostId !== hostId) {
          return sessionHostMismatchError(sessionId, hostId);
        }
      }
      const sessions = findMatchingSessions(deps, { hostId, sessionId });
      if (sessions.length === 0) {
        return { ok: false, error: 'Session not found or already closed.' };
      }
      if (!sessionId && sessions.length > 1) {
        return {
          ok: false,
          error: 'sessionId is required because multiple sessions match this host.',
          sessions: sessions.map(sessionSummary),
        };
      }
      const target = sessions[0];
      deps.closeSession(target.id);
      return { ok: true, session: sessionSummary(target) };
    }

    case 'asset.reconnect': {
      if (!sessionId) return { ok: false, error: 'sessionId is required.' };
      const session = deps.getSessions().find((entry) => entry.id === sessionId);
      if (!session) return { ok: false, error: 'Session not found or already closed.' };
      if (hostId && session.hostId !== hostId) {
        return sessionHostMismatchError(sessionId, hostId);
      }
      const host = session.hostId ? findHost(deps, session.hostId) : undefined;
      if (!host) return { ok: false, error: 'Host not found.' };
      const effectiveHost = deps.resolveEffectiveHost(host);
      if ((effectiveHost.protocol ?? 'ssh') !== 'ssh') {
        return { ok: false, error: 'Only SSH host assets are supported for reconnect operations.' };
      }
      deps.closeSession(session.id);
      const newSessionId = deps.connectHost(host);
      if (typeof newSessionId === 'string' && newSessionId) {
        deps.focusSession(newSessionId);
      }
      return {
        ok: true,
        previousSession: sessionSummary(session),
        sessionId: typeof newSessionId === 'string' ? newSessionId : undefined,
        asset: redactHostForAgent(effectiveHost),
      };
    }

    default:
      return { ok: false, error: `Unknown asset action operation "${op}".` };
  }
}

export type AssetActionHandler = (op: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

let activeHandler: AssetActionHandler | null = null;

export function registerAssetActionHandler(handler: AssetActionHandler | null): void {
  activeHandler = handler;
}

export function setupAssetActionBridge(): () => void {
  const bridge = netcattyBridge.get();
  if (!bridge?.onAssetActionRequest || !bridge.respondAssetAction) {
    return () => {};
  }

  const unsubscribe = bridge.onAssetActionRequest(async (payload) => {
    const { requestId, op, params } = payload;
    try {
      const result = activeHandler
        ? await activeHandler(op, params || {})
        : { ok: false, error: 'Asset action bridge is not ready.' };
      await bridge.respondAssetAction?.(requestId, result);
    } catch (err) {
      await bridge.respondAssetAction?.(requestId, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return unsubscribe;
}
