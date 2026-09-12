import type { PortForwardingRule } from "./models";

/**
 * Whether a port-forwarding rule should automatically reconnect (with bounded
 * retries) after an unexpected disconnect.
 *
 * Legacy rules without `autoReconnect` retain their auto-start reconnect
 * behavior. An explicit choice always takes precedence.
 */
export const isPortForwardingAutoReconnectEnabled = (
  rule: Pick<PortForwardingRule, "autoStart" | "autoReconnect">,
): boolean => rule.autoReconnect ?? rule.autoStart === true;
