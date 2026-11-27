import type { TerminalSession } from '../types';
import type { CodingCliProviderId } from './codingCliProviders';
import { normalizeCodingCliTitle } from './codingCliTitleParse';
import type { DynamicTabTitleMode } from './models/terminal';

/** Configured connection label, independent of live terminal presentation. */
export const getSessionConnectionLabel = (
  session: Pick<TerminalSession, 'customName' | 'hostLabel'>,
): string => {
  return session.customName || session.hostLabel || '';
};

type SessionTabLabelSession = Pick<
  TerminalSession,
  | 'customName'
  | 'hostLabel'
  | 'promptHostname'
  | 'promptHostnameFromJumpServer'
  | 'dynamicTitle'
  | 'codingCliProviderId'
>;

const joinWorkspaceLabels = (labels: readonly string[]): string | null => {
  const uniqueLabels = [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
  return uniqueLabels.length > 0 ? uniqueLabels.join('/') : null;
};

/**
 * Default title given to a freshly created split workspace. Used as a sentinel:
 * while the workspace still carries this title (i.e. the user has not renamed
 * it), the tab derives a label from its sessions instead of showing "Workspace".
 */
export const DEFAULT_WORKSPACE_TITLE = 'Workspace';

/**
 * Compose the title for a workspace created by merging standalone session
 * tabs (e.g. dragging tab "02" onto tab "01"). The merged workspace inherits
 * both tabs' connection labels joined with "/" ("01/02") so the window title
 * and the rename dialog show the merged identity instead of the generic
 * "Workspace". Returns null when neither session has a label — the caller
 * keeps the default auto-titled behavior in that case. Identical labels
 * collapse to a single name so two panes on the same host don't read
 * "web-01/web-01".
 */
export const buildMergedWorkspaceTitle = (
  baseLabel: string,
  joiningLabel: string,
): string | null => {
  return joinWorkspaceLabels([baseLabel, joiningLabel]);
};

type WorkspaceTabLabelSession = Pick<TerminalSession, 'id' | 'hostId'> & SessionTabLabelSession;

/**
 * Recompute a merged workspace's composed title from its *current* member
 * sessions. Unlike the one-shot `buildMergedWorkspaceTitle` call at merge
 * time, this runs over live membership, so pane renames and panes being
 * added or removed are reflected. Returns null when no member has a label.
 * Labels are deduplicated by exact match against the other member labels
 * (not against the accumulated title, which would only catch full-string
 * repeats like "web/db/web/db"), keeping first-seen order: `web/db/web`
 * collapses to `web/db`.
 */
export const buildMergedWorkspaceTitleFromSessions = (
  sessions: readonly WorkspaceTabLabelSession[],
): string | null => {
  return joinWorkspaceLabels(sessions.map(getSessionConnectionLabel));
};

/**
 * Resolve the label shown on a split-workspace tab. When the user has renamed
 * the workspace, that name wins. Otherwise derive it from the focused session's
 * host (e.g. "Localhost" for a local shell, the host config name for SSH) so the
 * tab reads as a concrete host instead of the generic "Workspace". If the
 * workspace holds sessions for more than one distinct host, the focused host is
 * shown with a "+N" suffix for the others.
 *
 * Presented sessions use the same title policy as individual tabs. Generated
 * merge titles are display-only compositions; their persisted identity is built
 * separately by buildMergedWorkspaceTitleFromSessions. Host counts always use
 * hostId, never a dynamic title or per-pane rename.
 */
export const resolveWorkspaceTabLabel = (
  workspace: {
    title?: string;
    focusedSessionId?: string | null;
    autoTitle?: boolean;
    generatedTitle?: boolean;
  },
  sessions: readonly WorkspaceTabLabelSession[],
  dynamicTabTitleMode: DynamicTabTitleMode = 'agent',
): string => {
  const title = workspace.title?.trim();
  if (workspace.generatedTitle) {
    return joinWorkspaceLabels(sessions.map((session) => resolveSessionTabTitle(session, dynamicTabTitleMode)))
      ?? DEFAULT_WORKSPACE_TITLE;
  }
  // Derive a host label only for an auto-titled workspace. The `autoTitle` flag
  // is authoritative when present (so a workspace a user explicitly named
  // "Workspace" is kept, not overwritten); legacy workspaces without the flag
  // fall back to matching the default-title string.
  const isAutoTitle = workspace.autoTitle ?? (title === DEFAULT_WORKSPACE_TITLE);
  if (!isAutoTitle) {
    return title || DEFAULT_WORKSPACE_TITLE;
  }
  if (sessions.length === 0) {
    return title || DEFAULT_WORKSPACE_TITLE;
  }
  const focused = sessions.find((s) => s.id === workspace.focusedSessionId) ?? sessions[0];
  const primary = resolveSessionTabTitle(focused, dynamicTabTitleMode);
  // Count distinct HOSTS by hostId, the only stable host identity: a rename
  // rewrites both customName and hostLabel (useSessionState.submitSessionRename),
  // so neither is safe to count by — a renamed pane on the same host would add a
  // spurious "+1". hostId is shared across all local terminals and per host
  // config, and is untouched by renames. The focused pane may still show its
  // rename as the primary label.
  const distinctHosts = new Set(sessions.map((s) => s.hostId).filter(Boolean));
  if (distinctHosts.size > 1) {
    return `${primary} +${distinctHosts.size - 1}`;
  }
  return primary || title || DEFAULT_WORKSPACE_TITLE;
};

export const shouldUpdateCodingCliTabIcon = (
  dynamicTabTitleMode: DynamicTabTitleMode = 'agent',
): boolean => dynamicTabTitleMode !== 'off';

export const resolveCodingCliProviderIconUpdate = ({
  dynamicTabTitleMode,
  currentProviderId,
  nextProviderId,
}: {
  dynamicTabTitleMode: DynamicTabTitleMode;
  currentProviderId?: CodingCliProviderId;
  nextProviderId: CodingCliProviderId | null;
}): CodingCliProviderId | null | undefined => {
  if (!shouldUpdateCodingCliTabIcon(dynamicTabTitleMode)) return undefined;
  if ((currentProviderId ?? null) === nextProviderId) return undefined;
  return nextProviderId;
};

const shellTitleHostname = (title: string): string | undefined => {
  // A title is not a prompt: require an anchored identity plus cwd/port evidence,
  // so program titles, email addresses, and URIs do not become host reports.
  const match = /^[a-z0-9_.+-]+@(\[[^\]\s]+\]|[a-z0-9][a-z0-9_.-]*):\s*(.*)$/iu.exec(title);
  if (!match) return undefined;
  const [, hostname, suffix] = match;
  const isPath = /^(?:~(?:\/|$)|\/)/u.test(suffix);
  const isPort = /^\d{1,5}$/u.test(suffix) && Number(suffix) > 0 && Number(suffix) <= 65_535;
  if (!isPath && !isPort) return undefined;
  if (hostname.startsWith('[')) {
    try {
      // Validate IPv6 brackets only; do not use URL canonicalization to infer
      // aliases or compressed/expanded address equivalence.
      new URL(`http://${hostname}/`);
    } catch {
      return undefined;
    }
  }
  return hostname;
};

const titleHostnameKey = (hostname: string): string =>
  hostname.replace(/^\[(.*)\]$/u, '$1').replace(/\.$/u, '').toLowerCase();

/**
 * Resolve the label shown on session tabs and pane headers.
 * Live shell titles require all mode; agent mode permits Agent titles and
 * nested JumpServer target hostnames.
 */
export const resolveSessionTabTitle = (
  session: SessionTabLabelSession,
  dynamicTabTitleMode: DynamicTabTitleMode = 'agent',
): string => {
  const connectionLabel = getSessionConnectionLabel(session);
  if (session.customName || dynamicTabTitleMode === 'off') {
    return connectionLabel;
  }

  const rawTitle = session.dynamicTitle?.trim();
  const dynamicTitle = rawTitle ? normalizeCodingCliTitle(rawTitle) || rawTitle : undefined;
  if (session.codingCliProviderId && dynamicTitle) {
    return dynamicTitle;
  }
  const promptHostname = session.promptHostname?.trim();
  if (dynamicTabTitleMode !== 'all') {
    return promptHostname && session.promptHostnameFromJumpServer
      ? promptHostname
      : connectionLabel;
  }
  if (!dynamicTitle) return promptHostname || connectionLabel;
  if (promptHostname) {
    const reportedHost = shellTitleHostname(dynamicTitle);
    if (reportedHost && titleHostnameKey(reportedHost) !== titleHostnameKey(promptHostname)) {
      return promptHostname;
    }
  }
  return dynamicTitle;
};
