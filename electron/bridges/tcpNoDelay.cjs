"use strict";

function enableTcpNoDelay(socket) {
  try {
    socket?.setNoDelay?.(true);
  } catch {
    // Best-effort latency hint; the connection can continue without it.
  }
}

function enableSshNoDelay(conn) {
  try {
    conn?.setNoDelay?.(true);
  } catch {
    // Best-effort latency hint; the SSH session can continue without it.
  }
}

module.exports = {
  enableSshNoDelay,
  enableTcpNoDelay,
};
