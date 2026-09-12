import type { Host, PortForwardingRule } from './models';
import { getNextVaultOrder } from './vaultOrder';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
type NewRuleValues = { id: string; now: number };

export const hasPortForwardingConnectionChanged = (
  existing: PortForwardingRule,
  updated: PortForwardingRule,
): boolean => (
  existing.type !== updated.type
  || existing.localPort !== updated.localPort
  || existing.remoteHost !== updated.remoteHost
  || existing.remotePort !== updated.remotePort
  || existing.bindAddress !== updated.bindAddress
  || existing.hostId !== updated.hostId
);

const parsePort = (value: unknown, name: string): Result<number> => {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? ''));
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535
    ? { ok: true, value: parsed }
    : { ok: false, error: `${name} must be an integer between 1 and 65535.` };
};

const parseToggle = (value: unknown, name: string): Result<boolean | undefined> => {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value === 'boolean') return { ok: true, value };
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return { ok: true, value: true };
  if (['false', '0', 'no'].includes(normalized)) return { ok: true, value: false };
  return { ok: false, error: `${name} must be true or false.` };
};

export const validatePortForwardingHost = (
  hosts: Host[],
  hostId: string | undefined,
): Result<Host> => {
  const host = hosts.find((candidate) => candidate.id === hostId);
  if (!hostId || !host) {
    return { ok: false, error: `Host "${hostId || ''}" was not found.` };
  }
  if (host.protocol && host.protocol !== 'ssh') {
    return { ok: false, error: `Host "${hostId}" does not support port forwarding.` };
  }
  return { ok: true, value: host };
};

function buildRule(
  source: Record<string, unknown>,
  hosts: Host[],
  existing?: PortForwardingRule,
  newRule?: NewRuleValues,
): Result<PortForwardingRule> {
  const type = source.type === undefined ? existing?.type : String(source.type).trim();
  if (type !== 'local' && type !== 'remote' && type !== 'dynamic') {
    return { ok: false, error: 'type must be local, remote, or dynamic.' };
  }
  const localPort = parsePort(source.localPort ?? existing?.localPort, 'localPort');
  if ('error' in localPort) return { ok: false, error: localPort.error };
  const hostId = source.hostId === undefined ? existing?.hostId : String(source.hostId).trim();
  const validatedHost = validatePortForwardingHost(hosts, hostId);
  if (!validatedHost.ok) return validatedHost;
  const remoteHost = source.remoteHost === undefined ? existing?.remoteHost : String(source.remoteHost).trim();
  let remotePort: number | undefined;
  if (type !== 'dynamic') {
    if (!remoteHost) return { ok: false, error: 'remoteHost is required for local and remote forwarding.' };
    const parsedRemotePort = parsePort(source.remotePort ?? existing?.remotePort, 'remotePort');
    if ('error' in parsedRemotePort) return { ok: false, error: parsedRemotePort.error };
    remotePort = parsedRemotePort.value;
  }
  if (!existing && !newRule) return { ok: false, error: 'New rule id and timestamp are required.' };
  const autoStartToggle = parseToggle(source.autoStart, 'autoStart');
  if ('error' in autoStartToggle) return autoStartToggle;
  const autoStart = autoStartToggle.value ?? existing?.autoStart ?? false;
  const autoReconnectToggle = parseToggle(source.autoReconnect, 'autoReconnect');
  if ('error' in autoReconnectToggle) return autoReconnectToggle;
  const autoReconnect = autoReconnectToggle.value ?? existing?.autoReconnect;
  return {
    ok: true,
    value: {
      id: existing?.id ?? newRule!.id,
      label: String(source.label ?? existing?.label ?? `${type} ${localPort.value}`).trim() || `${type} ${localPort.value}`,
      type,
      localPort: localPort.value,
      bindAddress: String(source.bindAddress ?? existing?.bindAddress ?? '127.0.0.1').trim() || '127.0.0.1',
      ...(type === 'dynamic' ? {} : { remoteHost, remotePort }),
      hostId,
      autoStart,
      ...(autoReconnect === undefined ? {} : { autoReconnect }),
      status: existing?.status ?? 'inactive',
      error: existing?.error,
      lastUsedAt: existing?.lastUsedAt,
      createdAt: existing?.createdAt ?? newRule!.now,
      order: existing?.order,
    },
  };
}

export function createPortForwardingRule(
  rules: PortForwardingRule[],
  hosts: Host[],
  source: Record<string, unknown>,
  newRule: NewRuleValues,
): Result<{ rules: PortForwardingRule[]; rule: PortForwardingRule }> {
  const built = buildRule(source, hosts, undefined, newRule);
  if ('error' in built) return { ok: false, error: built.error };
  const rule = { ...built.value, order: getNextVaultOrder(rules) };
  return { ok: true, value: { rules: [...rules, rule], rule } };
}

export function updatePortForwardingRule(
  rules: PortForwardingRule[],
  hosts: Host[],
  ruleId: string,
  source: Record<string, unknown>,
): Result<{ rules: PortForwardingRule[]; rule: PortForwardingRule }> {
  const existing = rules.find((rule) => rule.id === ruleId);
  if (!existing) return { ok: false, error: `Port forwarding rule "${ruleId}" was not found.` };
  const built = buildRule(source, hosts, existing);
  if ('error' in built) return { ok: false, error: built.error };
  const connectionChanged = hasPortForwardingConnectionChanged(existing, built.value);
  const updatedRule = connectionChanged
    ? { ...built.value, status: 'inactive' as const, error: undefined }
    : built.value;
  return {
    ok: true,
    value: { rules: rules.map((rule) => rule.id === ruleId ? updatedRule : rule), rule: updatedRule },
  };
}

export function duplicatePortForwardingRule(
  rules: PortForwardingRule[],
  hosts: Host[],
  ruleId: string,
  newRule: NewRuleValues,
): Result<{ rules: PortForwardingRule[]; rule: PortForwardingRule }> {
  const existing = rules.find((rule) => rule.id === ruleId);
  if (!existing) return { ok: false, error: `Port forwarding rule "${ruleId}" was not found.` };
  const validated = buildRule({}, hosts, existing);
  if ('error' in validated) return { ok: false, error: validated.error };
  const rule: PortForwardingRule = {
    ...validated.value,
    id: newRule.id,
    label: `${existing.label} (Copy)`,
    status: 'inactive',
    error: undefined,
    lastUsedAt: undefined,
    createdAt: newRule.now,
    order: getNextVaultOrder(rules),
  };
  return { ok: true, value: { rules: [...rules, rule], rule } };
}
