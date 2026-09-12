import type { TerminalSession } from '../types';
import type { CodingCliProviderId } from './codingCliProviders';
import { normalizeCodingCliTitle } from './codingCliTitleParse';
import type { DynamicTabTitleMode } from './models/terminal';

/** Static connection label: user rename or host label. */
export const getSessionConnectionLabel = (session: Pick<TerminalSession, 'customName' | 'hostLabel'>): string => {
  return session.customName || session.hostLabel || '';
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
  const base = baseLabel.trim();
  const joining = joiningLabel.trim();
  if (!base && !joining) return null;
  if (!base) return joining;
  if (!joining || joining === base) return base;
  return `${base}/${joining}`;
};

type WorkspaceTabLabelSession = Pick<TerminalSession, 'id' | 'customName' | 'hostLabel' | 'hostId'>;

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
  const labels: string[] = [];
  for (const session of sessions) {
    const label = getSessionConnectionLabel(session).trim();
    if (!label || labels.includes(label)) continue;
    labels.push(label);
  }
  if (labels.length === 0) return null;
  return labels.join('/');
};

/**
 * Resolve the label shown on a split-workspace tab. When the user has renamed
 * the workspace, that name wins. Otherwise derive it from the focused session's
 * host (e.g. "Localhost" for a local shell, the host config name for SSH) so the
 * tab reads as a concrete host instead of the generic "Workspace". If the
 * workspace holds sessions for more than one distinct host, the focused host is
 * shown with a "+N" suffix for the others.
 *
 * Uses the stable connection label (rename / host label) rather than the
 * dynamic shell/agent title: those live titles are published only to the
 * session presentation store (not the plain session records passed here), and
 * they can differ per-pane on a single host — counting them would both go stale
 * and produce a bogus "+N". The host identity is what this tab is about.
 */
export const resolveWorkspaceTabLabel = (
  workspace: { title?: string; focusedSessionId?: string | null; autoTitle?: boolean },
  sessions: readonly WorkspaceTabLabelSession[],
): string => {
  const title = workspace.title?.trim();
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
  const primary = getSessionConnectionLabel(focused);
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

/**
 * Resolve the label shown on session tabs and pane headers.
 * Uses the shell-reported title according to the global dynamic title mode.
 */
export const resolveSessionTabTitle = (
  session: Pick<TerminalSession, 'customName' | 'hostLabel' | 'dynamicTitle' | 'codingCliProviderId'>,
  dynamicTabTitleMode: DynamicTabTitleMode = 'agent',
): string => {
  const connectionLabel = getSessionConnectionLabel(session);
  if (dynamicTabTitleMode === 'off') {
    return connectionLabel;
  }
  if (session.customName) {
    return session.customName;
  }
  if (dynamicTabTitleMode === 'agent' && !session.codingCliProviderId) {
    return connectionLabel;
  }
  const dynamicTitle = session.dynamicTitle?.trim();
  if (!dynamicTitle) {
    return connectionLabel;
  }
  return normalizeCodingCliTitle(dynamicTitle) || dynamicTitle;
};
