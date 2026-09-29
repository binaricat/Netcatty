"use strict";

/**
 * Merge two scoped snapshots without letting an older cross-scope copy
 * overwrite newer connection state. Metadata revisions are assigned by the
 * main-process bridge when a renderer update arrives.
 *
 * @param {Record<string, unknown> | null | undefined} previous
 * @param {Record<string, unknown> | null | undefined} fallback
 * @returns {Record<string, unknown> | null}
 */
function mergeRetentionMeta(previous, fallback) {
  if (!previous && !fallback) return null;
  if (!previous) return fallback && typeof fallback === "object" ? fallback : null;
  if (!fallback || typeof fallback !== "object") return previous;

  const previousRevision = Number.isSafeInteger(previous._revision) ? previous._revision : 0;
  const fallbackRevision = Number.isSafeInteger(fallback._revision) ? fallback._revision : 0;
  // Unversioned direct helper inputs retain the historical fallback-wins
  // behavior. Bridge-owned metadata is always versioned.
  const fallbackIsNewer = fallbackRevision >= previousRevision;
  const newer = fallbackIsNewer ? fallback : previous;
  const older = fallbackIsNewer ? previous : fallback;
  const connected = Object.prototype.hasOwnProperty.call(newer, "connected")
    ? newer.connected !== false
    : older.connected !== false;
  return {
    ...older,
    ...newer,
    hostname: newer.hostname || older.hostname,
    label: newer.label || older.label,
    os: newer.os || older.os,
    username: newer.username || older.username,
    protocol: newer.protocol || older.protocol,
    shellType: newer.shellType || older.shellType,
    deviceType: newer.deviceType || older.deviceType,
    hostId: newer.hostId || older.hostId,
    savedHostId: Object.prototype.hasOwnProperty.call(newer, "savedHostId")
      ? newer.savedHostId || ""
      : older.savedHostId,
    hostChain: Array.isArray(newer.hostChain) ? newer.hostChain : older.hostChain,
    // Explicit empty arrays in the newer snapshot clear stopped forwards.
    activePortForwards: Array.isArray(newer.activePortForwards)
      ? newer.activePortForwards
      : older.activePortForwards,
    connected,
    ...(Math.max(previousRevision, fallbackRevision) > 0
      ? { _revision: Math.max(previousRevision, fallbackRevision) }
      : {}),
  };
}

/**
 * Keep host_open-owned sessions in a chat scope when a full metadata replace
 * would otherwise drop them (e.g. AIChatSidePanel pushing only the current
 * terminal tab after a mid-turn host_open).
 *
 * Empty incoming lists are treated as authoritative clears and are not retained.
 *
 * @param {{
 *   incomingSessions: Array<Record<string, unknown>>,
 *   ownedSessionIds: string[],
 *   previousById?: Map<string, Record<string, unknown>> | null,
 *   findFallbackMeta?: ((sessionId: string) => Record<string, unknown> | null | undefined) | null,
 * }} args
 * @returns {Array<Record<string, unknown>>}
 */
function retainOwnedSessions({
  incomingSessions,
  ownedSessionIds,
  previousById = null,
  findFallbackMeta = null,
}) {
  if (!Array.isArray(incomingSessions) || incomingSessions.length === 0) {
    return incomingSessions;
  }
  if (!Array.isArray(ownedSessionIds) || ownedSessionIds.length === 0) {
    return incomingSessions;
  }

  const byId = new Map();
  for (const entry of incomingSessions) {
    if (!entry || typeof entry !== "object" || !entry.sessionId) continue;
    byId.set(String(entry.sessionId), entry);
  }

  for (const ownedIdRaw of ownedSessionIds) {
    const ownedId = typeof ownedIdRaw === "string" ? ownedIdRaw.trim() : "";
    if (!ownedId || byId.has(ownedId)) continue;

    const previous = previousById?.get?.(ownedId) || null;
    // Always consult fallback — a stale previous connected:false must not
    // block a fresher cross-scope snapshot (e.g. External MCP / other tab).
    const fallback = typeof findFallbackMeta === "function"
      ? findFallbackMeta(ownedId)
      : null;
    const meta = mergeRetentionMeta(previous, fallback);
    if (!meta || typeof meta !== "object") continue;

    byId.set(ownedId, {
      sessionId: ownedId,
      hostname: meta.hostname || "",
      label: meta.label || "",
      os: meta.os || "",
      username: meta.username || "",
      protocol: meta.protocol || "",
      shellType: meta.shellType || "",
      deviceType: meta.deviceType || "",
      connected: meta.connected !== false,
      hostId: meta.hostId || "",
      savedHostId: meta.savedHostId || "",
      hostChain: Array.isArray(meta.hostChain) ? meta.hostChain : [],
      activePortForwards: Array.isArray(meta.activePortForwards) ? meta.activePortForwards : [],
      ...(Number.isSafeInteger(meta._revision) ? { _revision: meta._revision } : {}),
    });
  }

  return Array.from(byId.values());
}

module.exports = { retainOwnedSessions, mergeRetentionMeta };
