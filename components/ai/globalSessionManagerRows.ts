import type { AISession, ExternalAgentConfig } from '../../infrastructure/ai/types';
import { resolveChatAgentLabel } from './aiChatsListing';

/**
 * Pure derivation for the global AI session manager (issue #4098 phases 4-5).
 *
 * The scoped history drawer ranks sessions against ONE panel scope; the
 * manager needs a row for every chat in the store regardless of scope, with
 * the scope resolved against the live workspace/terminal stores so dangling
 * chats (issue #4019) are identifiable at a glance.
 *
 * Rendering consumes titles and counts only — never message bodies — so
 * building the full row list is safe at store scale (the persistence layer
 * caps the store at MAX_STORED_SESSIONS = 1000, see aiStateSnapshots.ts).
 */

export interface GlobalManagerTerminalInfo {
  sessionId: string;
  hostId: string;
  label: string;
  hostname: string;
  connected: boolean;
}

/** A currently-open scope a chat can be rebound to (explicit target picker). */
export interface GlobalManagerScopeTarget {
  type: 'terminal' | 'workspace';
  targetId: string;
  label: string;
  /** Host ids carried onto the rebound chat for terminal-scope reconnection. */
  hostIds?: string[];
}

export interface GlobalManagerRow {
  session: AISession;
  title: string;
  agentId: string;
  agentLabel: string;
  scopeLabel: string;
  scopeState: 'active' | 'dangling' | 'idle';
  /** Active chat of the panel currently viewing the manager. */
  isCurrentView: boolean;
  /**
   * The chat's own scope IS the viewing panel's scope, so "open" can switch
   * this panel to it. Cross-scope activation is deliberately not faked
   * (issue #4098 phase 5): out-of-scope rows offer rebind instead.
   */
  canActivate: boolean;
  messageCount: number;
}

export interface BuildGlobalManagerRowsInput {
  sessions: AISession[];
  activeSessionIdMap: Readonly<Record<string, string | null>>;
  currentScopeType: 'terminal' | 'workspace';
  currentScopeTargetId?: string;
  workspaces: ReadonlyArray<{ id: string; title: string }>;
  terminalInfos: ReadonlyArray<GlobalManagerTerminalInfo>;
  externalAgents: ExternalAgentConfig[];
  t: (key: string) => string;
}

export function buildGlobalManagerRows(input: BuildGlobalManagerRowsInput): GlobalManagerRow[] {
  const {
    sessions,
    activeSessionIdMap,
    currentScopeType,
    currentScopeTargetId,
    workspaces,
    terminalInfos,
    externalAgents,
    t,
  } = input;

  const workspaceTitles = new Map(workspaces.map((workspace) => [workspace.id, workspace.title]));
  const liveTerminals = new Map(terminalInfos.map((info) => [info.sessionId, info]));
  const activeSessionIds = new Set(
    Object.values(activeSessionIdMap).filter((id): id is string => Boolean(id)),
  );

  return sessions
    .map((session) => {
      const isCurrentView = Boolean(
        currentScopeTargetId
        && session.scope.type === currentScopeType
        && session.scope.targetId === currentScopeTargetId,
      );
      let scopeLabel: string;
      let isDangling: boolean;
      if (session.scope.type === 'workspace') {
        const title = workspaceTitles.get(session.scope.targetId ?? '');
        if (title != null) {
          scopeLabel = `${t('ai.chat.chatsScopeWorkspace')}: ${title}`;
          isDangling = false;
        } else {
          scopeLabel = t('ai.chat.chatsScopeDangling');
          isDangling = true;
        }
      } else if (session.scope.type === 'terminal') {
        const terminal = liveTerminals.get(session.scope.targetId ?? '');
        if (terminal) {
          const label = terminal.label || terminal.hostname;
          scopeLabel = label
            ? `${t('ai.chat.chatsScopeTerminal')}: ${label}`
            : t('ai.chat.chatsScopeTerminal');
          isDangling = false;
        } else {
          scopeLabel = t('ai.chat.chatsScopeDangling');
          isDangling = true;
        }
      } else {
        scopeLabel = t('ai.chat.chatsScopeGlobal');
        isDangling = false;
      }

      return {
        session,
        title: session.title || t('ai.chat.untitled'),
        agentId: session.agentId,
        agentLabel: resolveChatAgentLabel(session.agentId, externalAgents),
        scopeLabel,
        scopeState: isDangling
          ? 'dangling'
          : activeSessionIds.has(session.id)
            ? 'active'
            : 'idle',
        isCurrentView,
        canActivate: isCurrentView,
        messageCount: session.messages.length,
      } satisfies GlobalManagerRow;
    })
    // Newest first; the filter helpers preserve this order.
    .sort((a, b) => b.session.updatedAt - a.session.updatedAt);
}

export interface GlobalManagerFilter {
  /** Case-insensitive title substring; empty matches everything. */
  query: string;
  /** Agent id to keep, or 'all'. */
  agentId: string | 'all';
}

export function filterGlobalManagerRows(
  rows: GlobalManagerRow[],
  filter: GlobalManagerFilter,
): GlobalManagerRow[] {
  const query = filter.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.agentId !== 'all' && row.agentId !== filter.agentId) return false;
    if (query && !row.title.toLowerCase().includes(query)) return false;
    return true;
  });
}

/** Distinct agent ids present in the rows, in first-seen order. */
export function collectGlobalManagerAgentIds(rows: GlobalManagerRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) seen.add(row.agentId);
  return Array.from(seen);
}

/**
 * Build explicit rebind targets for every open workspace and terminal,
 * carrying host IDs for both so host-based history filtering survives
 * workspace dissolution and terminal reconnection.
 */
export function buildGlobalManagerRebindTargets(
  workspaces: ReadonlyArray<{ id: string; title: string; hostIds?: ReadonlyArray<string> }>,
  terminalInfos: ReadonlyArray<GlobalManagerTerminalInfo>,
): GlobalManagerScopeTarget[] {
  const targets: GlobalManagerScopeTarget[] = [];
  const seen = new Set<string>();
  for (const workspace of workspaces) {
    if (seen.has(`workspace:${workspace.id}`)) continue;
    seen.add(`workspace:${workspace.id}`);
    const hostIds = workspace.hostIds && workspace.hostIds.length > 0
      ? Array.from(new Set(workspace.hostIds.filter(Boolean)))
      : undefined;
    targets.push({
      type: 'workspace',
      targetId: workspace.id,
      label: workspace.title,
      hostIds: hostIds && hostIds.length > 0 ? hostIds : undefined,
    });
  }
  for (const info of terminalInfos) {
    if (!info.sessionId || seen.has(`terminal:${info.sessionId}`)) continue;
    seen.add(`terminal:${info.sessionId}`);
    targets.push({
      type: 'terminal',
      targetId: info.sessionId,
      label: info.label || info.hostname,
      hostIds: info.hostId ? [info.hostId] : undefined,
    });
  }
  return targets;
}
