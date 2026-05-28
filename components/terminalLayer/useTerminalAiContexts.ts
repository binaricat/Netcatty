import type React from 'react';
import { useCallback, useMemo } from 'react';

import { collectSessionIds } from '../../domain/workspace';
import { detectLocalOs } from '../../lib/localShell';
import type { Host, TerminalSession, Workspace } from '../../types';
import { buildAITerminalSessionInfo, type AIPanelContext } from './TerminalLayerSupport';

interface UseTerminalAiContextsOptions {
  hostsRef: React.MutableRefObject<Host[]>;
  mountedAiTabIds: string[];
  sessionHostsMap: Map<string, Host>;
  sessions: TerminalSession[];
  sessionsRef: React.MutableRefObject<TerminalSession[]>;
  workspaces: Workspace[];
  workspacesRef: React.MutableRefObject<Workspace[]>;
}

export function useTerminalAiContexts({
  hostsRef,
  mountedAiTabIds,
  sessionHostsMap,
  sessions,
  sessionsRef,
  workspaces,
  workspacesRef,
}: UseTerminalAiContextsOptions) {
  // Build per-tab AI contexts so hidden panels can stay mounted without
    // recomputing scope resolution from scratch on every tab switch.
    const aiContextsByTabId = useMemo(() => {
      const localOs = detectLocalOs(navigator.userAgent || navigator.platform);
      const sessionById = new Map<string, TerminalSession>(sessions.map((session) => [session.id, session]));
      const workspaceById = new Map<string, Workspace>(workspaces.map((workspace) => [workspace.id, workspace]));
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
            terminalSessions: sessionIds.map((sessionId) =>
              buildAITerminalSessionInfo(
                sessionById.get(sessionId),
                sessionHostsMap.get(sessionId),
                localOs,
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
            ),
          ],
        });
      }
  
      return contexts;
    }, [sessions, workspaces, mountedAiTabIds, sessionHostsMap]);
  
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
          const host = session?.hostId ? latestHosts.find((h) => h.id === session.hostId) : undefined;
          return buildAITerminalSessionInfo(session, host, localOs);
        }),
        workspaceId: scope.type === 'workspace' ? scope.targetId : undefined,
        workspaceName,
      };
    }, [hostsRef, sessionsRef, workspacesRef]);

  return {
    aiContextsByTabId,
    resolveAIExecutorContext,
  };
}
