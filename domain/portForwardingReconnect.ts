import type { PortForwardingRule } from "./models";

/**
 * Whether a port-forwarding rule should automatically reconnect (with bounded
 * retries) after an unexpected disconnect.
 *
 * `autoStart` keeps its pre-existing behavior of implying reconnect; other
 * rules opt in explicitly via `autoReconnect`.
 */
export const isPortForwardingAutoReconnectEnabled = (
  rule: Pick<PortForwardingRule, "autoStart" | "autoReconnect">,
): boolean => rule.autoStart === true || rule.autoReconnect === true;
