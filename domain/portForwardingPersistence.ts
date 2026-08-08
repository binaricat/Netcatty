import type { PortForwardingRule } from './models/portForwarding';

/**
 * Fields that describe a rule's configuration / user metadata.
 * Runtime phase (`status`, `error`) is owned by the main-process registry
 * and must not be treated as durable storage.
 */
export type PersistedPortForwardingRule = Omit<PortForwardingRule, 'status' | 'error'> & {
  status: 'inactive';
  error?: undefined;
};

/** Strip live runtime fields before writing localStorage / sync payloads. */
export function toPersistedPortForwardingRule(
  rule: PortForwardingRule,
): PersistedPortForwardingRule {
  return {
    ...rule,
    status: 'inactive',
    error: undefined,
  };
}

export function toPersistedPortForwardingRules(
  rules: readonly PortForwardingRule[],
): PersistedPortForwardingRule[] {
  return rules.map(toPersistedPortForwardingRule);
}

/**
 * Migrate legacy stored rules that still carry active/connecting phases.
 * Historical `error` is kept as a disposable diagnostic until a successful
 * backend snapshot proves the rule inactive (or a live connection overlays it).
 */
export function migratePortForwardingRulesFromStorage(
  rules: readonly PortForwardingRule[],
): PortForwardingRule[] {
  return rules.map((rule) => {
    if (rule.status === 'active' || rule.status === 'connecting') {
      return {
        ...rule,
        status: 'inactive' as const,
        error: undefined,
      };
    }
    return rule;
  });
}
