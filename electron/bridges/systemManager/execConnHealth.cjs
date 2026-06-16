"use strict";

/** Best-effort check that an ssh2 Client transport is still usable. */
function isSshConnAlive(conn) {
  if (!conn) return false;
  const sock = conn._sock;
  if (sock && sock.destroyed) return false;
  return true;
}

/** True when conn.exec failed because the underlying transport/channel is gone. */
function isTransportExecError(message) {
  const msg = String(message || "").toLowerCase();
  return (
    msg.includes("not connected")
    || msg.includes("connection lost")
    || msg.includes("socket hang up")
    || msg.includes("econnreset")
    || msg.includes("closed")
    || msg.includes("destroyed")
    || msg.includes("channel open failure")
    || msg.includes("unable to exec")
    || msg.includes("no response")
  );
}

module.exports = { isSshConnAlive, isTransportExecError };
