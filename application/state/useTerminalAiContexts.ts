import type React from 'react';
import { useCallback, useMemo, useRef } from 'react';

import { retainStableAiPanelContexts } from '../../domain/aiPanelContextsEqual';
import {
  buildAITerminalSessionInfo,
  type AIPanelContext,
  type AITerminalSessionInfo,
} from '../../domain/buildAITerminalSessionInfo';
import { collectSessionIds } from '../../domain/workspace';
import type { TerminalContextReader } from '../../domain/terminalContextRead';
import { detectLocalOs } from '../../lib/localShell';
import type { Host, PortForwardingRule, TerminalSession, Workspace } from '../../types';

interface UseTerminalAiContextsOptions {
  hosts: Host[];
  hostsRef: React.MutableRefObject<Host[]>;
  portForwardingRules: PortForwardingRule[];
  portForwardingRulesRef: React.MutableRefObject<PortForwardingRule[]>;
  mountedAiTabIds: string[];
  sessionHostsMap: Map<string, Host>;
  sessions: TerminalSession[];
  sessionsRef: React.MutableRefObject<TerminalSession[]>;
  terminalContextReadersRef: React.MutableRefObject<Map<string, TerminalContextReader>>;
  workspaces: Workspace[];
  workspacesRef: React.MutableRefObject<Workspace[]>;
}

/**
 * Per-session AI info for EVERY live terminal in the session store, not only
 * those reachable through `aiContextsByTabId` (which covers just the tabs
 * whose AI panel context was mounted — a terminal there is missing as a
 * global session manager rebind target until its tab opens the AI panel).
 * Rebinding to a context-less terminal is still valid: the association is
 * created on demand. Uses the same `buildAITerminalSessionInfo` as the
 * per-tab contexts, so infos merge seamlessly where a context exists.
 */
export function buildAllTerminalAiInfos(
  sessions: TerminalSession[],
  sessionHostsMap: Map<string, Host>,
  hosts: Host[],
  portForwardingRules: PortForwardingRule[],
  localOs: 'linux' | 'macos' | 'windows',
): AITerminalSessionInfo[] {
  const infos: AITerminalSessionInfo[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    if (!session.id || seen.has(session.id)) continue;
    seen.add(session.id);
    infos.push(buildAITerminalSessionInfo(session, sessionHostsMap.get(session.id), localOs, {
      allHosts: hosts,
      portForwardingRules,
    }));
  }
  return infos;
}

export function useTerminalAiContexts({
  hosts,
  hostsRef,
  portForwardingRules,
  portForwardingRulesRef,
  mountedAiTabIds,
  sessionHostsMap,
  sessions,
  sessionsRef,
  terminalContextReadersRef,
  workspaces,
  workspacesRef,
}: UseTerminalAiContextsOptions) {
  const previousAiContextsRef = useRef<Map<string, AIPanelContext> | null>(null);
  const aiContextsByTabId = useMemo(() => {
    const localOs = detectLocalOs(navigator.userAgent || navigator.platform);
    const sessionById = new Map<string, TerminalSession>(sessions.map((session) => [session.id, session]));
    const workspaceById = new Map<string, Workspace>(workspaces.map((workspace) => [workspace.id, workspace]));
    const allHosts = hosts;
    const tabIds = new Set<string>(mountedAiTabIds);

    const contexts = new Map<string, AIPanelContext>();

    for (const tabId of tabIds) {
      const workspace = workspaceById.get(tabId);
      if (workspace) {
        const sessionIds = collectSessionIds(workspace.root);
        contexts.set(tabId, {
          scopeType: 'workspace',
          scopeTargetId: workspace.id,
          scopeHostIds: sessionIds
            .map((sessionId) => sessionById.get(sessionId)?.hostId)
            .filter((hostId): hostId is string => !!hostId),
          scopeLabel: workspace.title,
          focusedSessionId: workspace.focusedSessionId,
          terminalSessions: sessionIds.map((sessionId) =>
            buildAITerminalSessionInfo(
              sessionById.get(sessionId),
              sessionHostsMap.get(sessionId),
              localOs,
              { allHosts, portForwardingRules },
            ),
          ),
        });
        continue;
      }

      const session = sessionById.get(tabId);
      if (!session) continue;

      contexts.set(tabId, {
        scopeType: 'terminal',
        scopeTargetId: session.id,
        scopeHostIds: session.hostId ? [session.hostId] : [],
        scopeLabel: session.hostLabel ?? '',
        terminalSessions: [
          buildAITerminalSessionInfo(
            session,
            sessionHostsMap.get(session.id),
            localOs,
            { allHosts, portForwardingRules },
          ),
        ],
      });
    }

    const retained = retainStableAiPanelContexts(previousAiContextsRef.current, contexts);
    previousAiContextsRef.current = retained;
    return retained;
  }, [sessions, workspaces, mountedAiTabIds, sessionHostsMap, hosts, portForwardingRules]);

  const appTerminalInfos = useMemo(() => {
    const localOs = detectLocalOs(navigator.userAgent || navigator.platform);
    return buildAllTerminalAiInfos(sessions, sessionHostsMap, hosts, portForwardingRules, localOs);
  }, [sessions, sessionHostsMap, hosts, portForwardingRules]);

  const resolveAIExecutorContext = useCallback((scope: {
    type: 'terminal' | 'workspace';
    targetId?: string;
    label?: string;
  }) => {
    const latestWorkspaces = workspacesRef.current;
    const latestSessions = sessionsRef.current;
    const latestHosts = hostsRef.current;
    const localOs = detectLocalOs(navigator.userAgent || navigator.platform);
    const sessionIds = scope.type === 'workspace'
      ? (() => {
          const workspace = scope.targetId ? latestWorkspaces.find((w) => w.id === scope.targetId) : undefined;
          return workspace?.root ? collectSessionIds(workspace.root) : [];
        })()
      : scope.targetId ? [scope.targetId] : [];

    const workspaceName = scope.type === 'workspace'
      ? latestWorkspaces.find((w) => w.id === scope.targetId)?.title ?? scope.label
      : undefined;

    return {
      sessions: sessionIds.map((sid) => {
        const session = latestSessions.find((s) => s.id === sid);
        const host = session ? sessionHostsMap.get(session.id) : undefined;
        return buildAITerminalSessionInfo(session, host, localOs, {
          allHosts: latestHosts,
          portForwardingRules: portForwardingRulesRef.current,
        });
      }),
      workspaceId: scope.type === 'workspace' ? scope.targetId : undefined,
      workspaceName,
      readTerminalContext: (request: Parameters<TerminalContextReader>[0]) => {
        const reader = terminalContextReadersRef.current.get(request.sessionId);
        if (!reader) {
          return Promise.resolve({
            ok: false as const,
            error: `Terminal session "${request.sessionId}" has no readable terminal buffer.`,
          });
        }
        return reader(request);
      },
    };
  }, [hostsRef, portForwardingRulesRef, sessionHostsMap, sessionsRef, terminalContextReadersRef, workspacesRef]);

  return {
    aiContextsByTabId,
    appTerminalInfos,
    resolveAIExecutorContext,
  };
}
