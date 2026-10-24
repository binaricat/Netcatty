import type { PortForwardingStatus } from './models';

/**
 * Aggregate rule-level status from per-mapping statuses.
 *
 * A multi-mapping rule forwards its mappings independently, so one failed
 * mapping must not fail the others (OpenSSH ExitOnForwardFailure=no
 * semantics). The mix is surfaced as `partial`. `connecting` wins while any
 * mapping is still coming up; a rule with only inactive mappings is
 * `inactive`; a mix without any active mapping is `error`.
 */
export const computeAggregateRuleStatus = (
  statuses: readonly PortForwardingStatus[],
): PortForwardingStatus => {
  if (statuses.length === 0) return 'inactive';
  if (statuses.some((status) => status === 'connecting')) return 'connecting';
  if (statuses.every((status) => status === 'active')) return 'active';
  if (statuses.every((status) => status === 'error')) return 'error';
  if (statuses.every((status) => status === 'inactive')) return 'inactive';
  if (statuses.every((status) => status === 'unknown')) return 'unknown';
  return statuses.some((status) => status === 'active') ? 'partial' : 'error';
};
