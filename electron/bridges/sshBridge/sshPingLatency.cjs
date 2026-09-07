"use strict";

const DEFAULT_PING_TIMEOUT_MS = 3000;

/**
 * Measures SSH round-trip latency with a transport-level ping
 * (GLOBAL_REQUEST keepalive@openssh.com, want_reply) on an already
 * authenticated ssh2 connection.
 *
 * This deliberately does NOT open a second TCP connection to the SSH port:
 * a raw TCP probe is indistinguishable from a pre-auth connection attempt
 * on the server and shows up as a failed login with no username in sshd
 * logs / login-audit panels (see issue #3320).
 *
 * The ssh2 client dispatches global-request replies through the FIFO
 * `conn._callbacks` queue (REQUEST_SUCCESS/REQUEST_FAILURE handlers shift
 * the next entry), so pushing a callback immediately before sending the
 * ping pairs it with the matching reply. On connection teardown the client
 * flushes the queue with an error argument, which resolves `null`.
 */
function createSshPingLatencyProbe({
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = () => performance.now(),
  defaultTimeoutMs = DEFAULT_PING_TIMEOUT_MS,
} = {}) {
  return function measureSshPingLatency(conn, timeoutMs = defaultTimeoutMs) {
    return new Promise((resolve) => {
      const proto = conn?._protocol;
      const callbacks = conn?._callbacks;
      if (!proto || typeof proto.ping !== "function" || !Array.isArray(callbacks)) {
        resolve(null);
        return;
      }

      const startedAt = now();
      let settled = false;
      let timer = null;

      const finish = (value, consumeSlot) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeoutFn(timer);
        if (consumeSlot) {
          const index = callbacks.indexOf(onReply);
          if (index >= 0) callbacks.splice(index, 1);
        }
        resolve(value);
      };
      const onReply = (hadErr) => {
        // ssh2 reports REQUEST_SUCCESS as `false` and REQUEST_FAILURE as
        // `true`; the latter is OpenSSH's normal reply to the unsupported
        // keepalive@openssh.com request, so both count as a completed ping.
        // Only an Error instance (transport teardown/flush) is a failure.
        if (hadErr instanceof Error) {
          finish(null, true);
          return;
        }
        finish(Math.max(0, Math.round(now() - startedAt)), true);
      };

      callbacks.push(onReply);
      try {
        proto.ping();
      } catch {
        // The request was never sent, so the queued callback can never be
        // consumed; remove it to keep the FIFO intact.
        finish(null, true);
        return;
      }
      // On timeout, deliberately leave `onReply` in the queue as a tombstone:
      // global-request replies carry no request ID and ssh2 correlates them
      // by FIFO order, so a late reply must still consume this slot.
      timer = setTimeoutFn(() => finish(null, false), timeoutMs);
    });
  };
}

module.exports = {
  createSshPingLatencyProbe,
  DEFAULT_PING_TIMEOUT_MS,
};
