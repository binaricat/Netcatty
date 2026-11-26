"use strict";

/**
 * Helpers for `netcatty:chain:progress` events sent while connecting through
 * jump hosts. Each event names the hop being connected (`label`) and its
 * network address (`address`), so the connection dialog can show
 * "Chain 2 of 3: Prod DB" with the matching "SSH 10.0.0.5:22" below it.
 */

/** Format `host:port`, bracketing bare IPv6 literals (`[::1]:22`). */
function formatChainHopAddress(hostname, port) {
  const host = String(hostname || "");
  const display = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${display}:${port || 22}`;
}

/**
 * Address of the 1-based `hop` in a chain of `jumpHosts` followed by the
 * final target. Hops past the jump hosts are the target.
 */
function resolveChainHopAddress(jumpHosts, targetHostname, targetPort, hop) {
  const jumps = Array.isArray(jumpHosts) ? jumpHosts : [];
  const jump = hop >= 1 && hop <= jumps.length ? jumps[hop - 1] : null;
  if (jump) return formatChainHopAddress(jump.hostname, jump.port);
  return formatChainHopAddress(targetHostname, targetPort);
}

/**
 * Label for the final target in chain progress. Jump hops already show their
 * vault label; the target should too, instead of its raw address. Direct
 * (single-hop) connections keep the address, which the dialog does not use
 * as a chain heading.
 */
function resolveChainTargetLabel(options, hasJumpHosts) {
  const hostname = options?.hostname || "";
  if (!hasJumpHosts) return hostname;
  return options?.hostLabel || options?.label || hostname;
}

module.exports = {
  formatChainHopAddress,
  resolveChainHopAddress,
  resolveChainTargetLabel,
};
