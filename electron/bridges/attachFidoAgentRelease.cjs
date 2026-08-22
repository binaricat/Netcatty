"use strict";

/**
 * Attach a one-shot release for an owned FIDO agent / askpass lease to a
 * connection-like EventEmitter (ssh2 Client, etc.).
 *
 * @param {import("events").EventEmitter|null|undefined} conn
 * @param {{ _releaseNetcattyFidoAgent?: () => void }|null|undefined} agent
 */
function attachFidoAgentRelease(conn, agent) {
  if (!conn || typeof conn.once !== "function") return;
  if (!agent || typeof agent._releaseNetcattyFidoAgent !== "function") return;
  let released = false;
  const releaseOwned = () => {
    if (released) return;
    released = true;
    try { agent._releaseNetcattyFidoAgent(); } catch { /* ignore */ }
  };
  conn.once("close", releaseOwned);
  conn.once("end", releaseOwned);
  return releaseOwned;
}

module.exports = { attachFidoAgentRelease };
