/**
 * Port Forwarding utilities and constants
 */
import type { PortForwardingRule, PortForwardingType } from '../../domain/models';

const TYPE_LABEL_KEYS: Record<PortForwardingType, string> = {
  local: 'pf.type.local',
  remote: 'pf.type.remote',
  dynamic: 'pf.type.dynamic',
};

const TYPE_MENU_LABEL_KEYS: Record<PortForwardingType, string> = {
  local: 'pf.type.menu.local',
  remote: 'pf.type.menu.remote',
  dynamic: 'pf.type.menu.dynamic',
};

const TYPE_DESCRIPTION_KEYS: Record<PortForwardingType, string> = {
  local: 'pf.type.local.desc',
  remote: 'pf.type.remote.desc',
  dynamic: 'pf.type.dynamic.desc',
};

export function getTypeLabel(
  t: (key: string, vars?: Record<string, unknown>) => string,
  type: PortForwardingType
): string {
  return t(TYPE_LABEL_KEYS[type]);
}

export function getTypeMenuLabel(
  t: (key: string, vars?: Record<string, unknown>) => string,
  type: PortForwardingType
): string {
  return t(TYPE_MENU_LABEL_KEYS[type]);
}

export function getTypeDescription(
  t: (key: string, vars?: Record<string, unknown>) => string,
  type: PortForwardingType
): string {
  return t(TYPE_DESCRIPTION_KEYS[type]);
}

export function buildRuleSummary(
  t: (key: string, vars?: Record<string, unknown>) => string,
  rule: PortForwardingRule
): string {
  const vars = {
    bindAddress: rule.bindAddress,
    localPort: rule.localPort,
    remoteHost: rule.remoteHost,
    remotePort: rule.remotePort,
  };

  switch (rule.type) {
    case 'local':
      return t('pf.rule.summary.local', vars);
    case 'remote':
      return t('pf.rule.summary.remote', vars);
    case 'dynamic':
      return t('pf.rule.summary.dynamic', vars);
    default:
      return t('pf.rule.summary.local', vars);
  }
}

export interface PortForwardingFormRow {
  localPort?: number;
  remotePort?: number;
}

/**
 * Working draft for the create/edit forms: the rule fields plus the editable
 * mapping rows for local/remote rules. Row 0 mirrors localPort/remotePort on
 * save; `mappings` is persisted only when more than one row remains.
 */
export type PortForwardingFormDraft = Partial<PortForwardingRule> & {
  mappingRows?: PortForwardingFormRow[];
};

/**
 * Effective mapping rows for a form draft: the working rows when present,
 * otherwise the single pair derived from the scalar fields.
 */
export function getFormRows(draft: PortForwardingFormDraft): PortForwardingFormRow[] {
  if (draft.mappingRows && draft.mappingRows.length > 0) return draft.mappingRows;
  return [{ localPort: draft.localPort, remotePort: draft.remotePort }];
}

/**
 * One line per mapping for multi-mapping rules (single-mapping rules return
 * the one legacy summary line). Bind address and destination host are shared
 * by all mappings, so only the port pair varies per line.
 */
export function buildRuleMappingSummaries(
  t: (key: string, vars?: Record<string, unknown>) => string,
  rule: PortForwardingRule
): string[] {
  if (!rule.mappings || rule.mappings.length <= 1) {
    return [buildRuleSummary(t, rule)];
  }
  return rule.mappings.map((mapping) =>
    t('pf.rule.summary.mapping', {
      localPort: mapping.localPort,
      remoteHost: rule.remoteHost,
      remotePort: mapping.remotePort,
    })
  );
}

export async function stopRuntimeTunnelBeforeDelete(
  ruleId: string,
  stopTunnel: (ruleId: string) => Promise<{ success: boolean }>,
): Promise<boolean> {
  return (await stopTunnel(ruleId)).success;
}

/**
 * Get status color class for a rule
 */
export function getStatusColor(status: string): string {
  switch (status) {
    case 'active':
      return 'bg-emerald-500';
    case 'connecting':
      return 'bg-yellow-500 animate-pulse';
    case 'partial':
      return 'bg-amber-500';
    case 'error':
      return 'bg-red-500';
    case 'unknown':
      return 'bg-muted-foreground/60 animate-pulse';
    default:
      return 'bg-muted-foreground/40';
  }
}

/**
 * Get type badge color class
 */
export function getTypeColor(type: PortForwardingType, isActive: boolean): string {
  const colors = {
    local: isActive ? 'bg-sky-500 text-white' : 'bg-sky-600 text-white dark:bg-sky-400 dark:text-slate-950',
    remote: isActive ? 'bg-indigo-500 text-white' : 'bg-indigo-600 text-white dark:bg-indigo-400 dark:text-slate-950',
    dynamic: isActive ? 'bg-violet-500 text-white' : 'bg-violet-600 text-white dark:bg-violet-400 dark:text-slate-950',
  };
  return colors[type];
}

/**
 * Generate default label for a rule
 */
export function generateRuleLabel(
  type: PortForwardingType,
  localPort?: number,
  remoteHost?: string,
  remotePort?: number
): string {
  switch (type) {
    case 'local':
      return `Local:${localPort} -> ${remoteHost}:${remotePort}`;
    case 'remote':
      return `Remote:${localPort} -> ${remoteHost}:${remotePort}`;
    case 'dynamic':
      return `SOCKS:${localPort}`;
    default:
      return 'New Rule';
  }
}
