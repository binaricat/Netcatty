import type { Host, PortForwardingMapping, PortForwardingRule } from './models';
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
  || JSON.stringify(existing.mappings ?? []) !== JSON.stringify(updated.mappings ?? [])
);

/**
 * Effective port pairs a rule forwards. Multi-mapping rules return their
 * `mappings`; single-mapping rules derive the one pair from the scalar
 * fields. `dynamic` rules have no destination pairs, so no mappings.
 */
export const getRuleMappings = (
  rule: Pick<PortForwardingRule, 'type' | 'localPort' | 'remotePort' | 'mappings'>,
): PortForwardingMapping[] => {
  if (rule.type === 'dynamic') return [];
  if (rule.mappings && rule.mappings.length > 1) return rule.mappings;
  return [{ localPort: rule.localPort, remotePort: rule.remotePort! }];
};

export const normalizeRuleMappings = (
  type: PortForwardingRule['type'],
  value: unknown,
): Result<PortForwardingMapping[]> => {
  if (value === undefined) return { ok: true, value: [] };
  let rows: unknown = value;
  if (typeof value === 'string') {
    try {
      rows = JSON.parse(value);
    } catch {
      return { ok: false, error: 'mappings must be a JSON array of { localPort, remotePort }.' };
    }
  }
  if (!Array.isArray(rows)) {
    return { ok: false, error: 'mappings must be an array of { localPort, remotePort }.' };
  }
  if (rows.length === 0) return { ok: true, value: [] };
  if (type === 'dynamic') {
    return { ok: false, error: 'mappings are not supported for dynamic forwarding.' };
  }
  const seenLocalPorts = new Set<number>();
  const mappings: PortForwardingMapping[] = [];
  for (const row of rows) {
    const record = (row ?? {}) as Record<string, unknown>;
    const localPort = parsePort(record.localPort, 'mappings localPort');
    if ('error' in localPort) return localPort;
    const remotePort = parsePort(record.remotePort, 'mappings remotePort');
    if ('error' in remotePort) return remotePort;
    if (seenLocalPorts.has(localPort.value)) {
      return { ok: false, error: `Duplicate local port ${localPort.value} in mappings.` };
    }
    seenLocalPorts.add(localPort.value);
    mappings.push({ localPort: localPort.value, remotePort: remotePort.value });
  }
  return { ok: true, value: mappings };
};

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
  const parsedMappings = normalizeRuleMappings(
    type,
    source.mappings !== undefined ? source.mappings : existing?.mappings,
  );
  if ('error' in parsedMappings) return { ok: false, error: parsedMappings.error };
  let mappings = parsedMappings.value;
  // A scalar-only update to a multi-mapping rule patches the first row — the
  // row the scalar fields mirror — instead of silently dropping the new
  // ports. The result is re-validated for duplicate local ports.
  if (
    source.mappings === undefined
    && mappings.length > 0
    && (source.localPort !== undefined || source.remotePort !== undefined)
  ) {
    const patched = mappings.map((mapping, index) => index === 0
      ? {
          localPort: source.localPort !== undefined ? localPort.value : mapping.localPort,
          remotePort: source.remotePort !== undefined && remotePort !== undefined
            ? remotePort
            : mapping.remotePort,
        }
      : mapping);
    const seenLocalPorts = new Set<number>();
    for (const mapping of patched) {
      if (seenLocalPorts.has(mapping.localPort)) {
        return { ok: false, error: `Duplicate local port ${mapping.localPort} in mappings.` };
      }
      seenLocalPorts.add(mapping.localPort);
    }
    mappings = patched;
  }
  // When mappings are provided they are authoritative; the first row is
  // mirrored into the scalar fields so every existing reader (persistence,
  // CLI schemas, bridge payloads) keeps working unchanged.
  const effectiveLocalPort = mappings.length > 0 ? mappings[0].localPort : localPort.value;
  const effectiveRemotePort = mappings.length > 0 ? mappings[0].remotePort : remotePort;
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
      label: String(source.label ?? existing?.label ?? `${type} ${effectiveLocalPort}`).trim() || `${type} ${effectiveLocalPort}`,
      type,
      localPort: effectiveLocalPort,
      bindAddress: String(source.bindAddress ?? existing?.bindAddress ?? '127.0.0.1').trim() || '127.0.0.1',
      ...(type === 'dynamic' ? {} : { remoteHost, remotePort: effectiveRemotePort }),
      ...(mappings.length > 1 ? { mappings } : {}),
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
