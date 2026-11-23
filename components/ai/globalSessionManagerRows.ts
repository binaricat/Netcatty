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

export interface GlobalManagerHostInfo {
  id: string;
  label?: string;
  hostname?: string;
}

/** A currently-open scope a chat can be moved to (explicit target picker). */
export interface GlobalManagerScopeTarget {
  type: 'terminal' | 'workspace';
  targetId: string;
  label: string;
  /** Host ids carried onto the moved chat for terminal-scope reconnection. */
  hostIds?: string[];
}

export interface GlobalManagerRow {
  session: AISession;
  title: string;
  agentId: string;
  agentLabel: string;
  scopeLabel: string;
  scopeState: 'active' | 'dangling' | 'idle';
  /** True when the chat already lives in the viewing panel's scope. */
  isCurrentView: boolean;
  /** True when the chat is the active chat of the viewing panel. */
  isCurrentActive: boolean;
  /** True when the chat is currently active in another open panel. */
  isActiveElsewhere: boolean;
  /**
   * Clicking the row opens the chat in the viewing panel: directly when it is
   * already in scope, or by attaching it to the viewing panel automatically.
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
  hosts?: ReadonlyArray<GlobalManagerHostInfo>;
  externalAgents: ExternalAgentConfig[];
  t: (key: string) => string;
}

function resolveHistoricalHostLabel(
  hostIds: ReadonlyArray<string> | undefined,
  hostNamesById: ReadonlyMap<string, string>,
): string {
  if (!hostIds || hostIds.length === 0) return '';
  const names: string[] = [];
  const seen = new Set<string>();
  for (const hostId of hostIds) {
    const name = hostNamesById.get(hostId);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  if (names.length === 0) return '';
  if (names.length <= 2) return names.join(', ');
  return `${names[0]}, ${names[1]} +${names.length - 2}`;
}

export function buildGlobalManagerRows(input: BuildGlobalManagerRowsInput): GlobalManagerRow[] {
  const {
    sessions,
    activeSessionIdMap,
    currentScopeType,
    currentScopeTargetId,
    workspaces,
    terminalInfos,
    hosts = [],
    externalAgents,
    t,
  } = input;

  const workspaceTitles = new Map(workspaces.map((workspace) => [workspace.id, workspace.title]));
  const liveTerminals = new Map(terminalInfos.map((info) => [info.sessionId, info]));
  const hostNamesById = new Map<string, string>();
  for (const host of hosts) {
    const name = (host.label || host.hostname || '').trim();
    if (host.id && name) hostNamesById.set(host.id, name);
  }
  for (const info of terminalInfos) {
    const name = (info.label || info.hostname || '').trim();
    if (info.hostId && name && !hostNamesById.has(info.hostId)) {
      hostNamesById.set(info.hostId, name);
    }
  }
  const activeSessionIds = new Set(
    Object.values(activeSessionIdMap).filter((id): id is string => Boolean(id)),
  );
  const currentScopeKey = currentScopeTargetId
    ? `${currentScopeType}:${currentScopeTargetId}`
    : null;
  const currentPanelActiveSessionId = currentScopeKey
    ? activeSessionIdMap[currentScopeKey] ?? null
    : null;

  return sessions
    .map((session) => {
      const isCurrentView = Boolean(
        currentScopeTargetId
        && !session.scopeDangling
        && session.scope.type === currentScopeType
        && session.scope.targetId === currentScopeTargetId,
      );
      let scopeLabel: string;
      let isDangling: boolean;
      if (session.scope.type === 'workspace') {
        const title = workspaceTitles.get(session.scope.targetId ?? '');
        if (title != null && !session.scopeDangling) {
          scopeLabel = title;
          isDangling = false;
        } else {
          scopeLabel = resolveHistoricalHostLabel(session.scope.hostIds, hostNamesById);
          isDangling = true;
        }
      } else if (session.scope.type === 'terminal') {
        const terminal = liveTerminals.get(session.scope.targetId ?? '');
        if (terminal && !session.scopeDangling) {
          scopeLabel = terminal.label || terminal.hostname || t('ai.chat.chatsScopeTerminal');
          isDangling = false;
        } else {
          scopeLabel = resolveHistoricalHostLabel(session.scope.hostIds, hostNamesById);
          isDangling = true;
        }
      } else {
        scopeLabel = t('ai.chat.chatsScopeGlobal');
        isDangling = false;
      }

      const isCurrentActive = currentPanelActiveSessionId === session.id;
      const isActiveElsewhere = !isCurrentActive && !isDangling && activeSessionIds.has(session.id);

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
        isCurrentActive,
        isActiveElsewhere,
        canActivate: Boolean(isCurrentView || currentScopeTargetId),
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
