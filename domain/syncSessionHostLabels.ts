import type { Host, TerminalSession } from './models';

/**
 * Mirror vault host labels onto open terminal sessions.
 *
 * Session records snapshot the host label at connect time (`hostLabel`), so a
 * host renamed in the vault leaves already-open session tabs showing the old
 * name until the session is closed and reopened. Pure helper: returns the same
 * array reference when nothing needs to change, so React state updaters bail
 * out without triggering a re-render.
 *
 * Rules per session:
 * - Only sessions whose `hostId` matches a vault host are touched. Local
 *   terminals and standalone serial-port sessions use a synthetic `hostId`,
 *   and ephemeral/deep-link hosts are absent from the vault, so their snapshot
 *   label (e.g. the shell name, "Serial: …") is preserved.
 * - A user rename of the pane (`customName`) wins over the host label in every
 *   consumer, so renamed panes are left untouched; their `hostLabel` is only
 *   an echo of the rename.
 */
export const syncSessionHostLabels = (
  sessions: readonly TerminalSession[],
  hosts: readonly Pick<Host, 'id' | 'label'>[],
): TerminalSession[] => {
  if (hosts.length === 0) return sessions as TerminalSession[];
  const labelById = new Map<string, string>();
  for (const host of hosts) {
    if (host.id && host.label) labelById.set(host.id, host.label);
  }
  if (labelById.size === 0) return sessions as TerminalSession[];
  let changed = false;
  const next = sessions.map((session) => {
    if (session.customName?.trim()) return session;
    const label = session.hostId ? labelById.get(session.hostId) : undefined;
    if (label === undefined || session.hostLabel === label) return session;
    changed = true;
    return { ...session, hostLabel: label };
  });
  return changed ? next : (sessions as TerminalSession[]);
};
