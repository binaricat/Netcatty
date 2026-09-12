import type { PortForwardingRule, PortForwardingStatus } from "./models";

export type PortForwardingRuntimeLike = {
  status?: PortForwardingStatus | string;
};

export const isPortForwardingRuntimeBusy = (
  connection?: PortForwardingRuntimeLike | null,
): boolean =>
  connection?.status === "active"
  || connection?.status === "connecting"
  || connection?.status === "error";

export const isPortForwardingRuleStartable = (
  rule: Pick<PortForwardingRule, "status">,
  runtimeBusy: boolean,
): boolean => !runtimeBusy && (rule.status === "inactive" || rule.status === "error");

export const isPortForwardingRuleStoppable = (
  rule: Pick<PortForwardingRule, "status">,
  runtimeBusy: boolean,
): boolean => runtimeBusy || rule.status === "active" || rule.status === "connecting";

export const selectStartablePortForwardingRules = (
  rules: readonly PortForwardingRule[],
  isRuntimeBusy: (ruleId: string) => boolean,
): PortForwardingRule[] =>
  rules.filter((rule) => isPortForwardingRuleStartable(rule, isRuntimeBusy(rule.id)));

export const selectStoppablePortForwardingRules = (
  rules: readonly PortForwardingRule[],
  isRuntimeBusy: (ruleId: string) => boolean,
): PortForwardingRule[] =>
  rules.filter((rule) => isPortForwardingRuleStoppable(rule, isRuntimeBusy(rule.id)));
