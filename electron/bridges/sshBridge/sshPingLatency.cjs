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
 *
 * At most one ping may be unresolved per connection: while a previous ping is
 * in flight or its timeout tombstone still occupies a FIFO slot, subsequent
 * calls resolve `null` without queueing another callback.
 */
// Serializes probes per connection: ssh2 correlates global-request replies
// with queued callbacks purely by FIFO order, so at most one unresolved ping
// (in-flight or timed-out tombstone) may occupy a slot in `conn._callbacks`
// at any time. Otherwise the next reply is delivered to the already-settled
// tombstone and the queue desynchronizes (e.g. swallowing forwardIn results),
// and repeated polls would grow the queue indefinitely.
const lastQueuedCallbackByConn = new WeakMap();

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

      // If a previous ping on this connection is still unresolved (in-flight
      // or left as a timeout tombstone) and its callback still occupies a
      // queue slot, skip this poll entirely: queueing another callback would
      // misalign the FIFO once the outstanding reply (or the tombstone's late
      // reply) arrives.
      const previous = lastQueuedCallbackByConn.get(conn);
      if (previous && callbacks.includes(previous)) {
        resolve(null);
        return;
      }

      const startedAt = now();
      let settled = false;
      let timer = null;

      const finish = (value, consumeSlot, keepTracking) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeoutFn(timer);
        if (consumeSlot) {
          const index = callbacks.indexOf(onReply);
          if (index >= 0) callbacks.splice(index, 1);
        }
        if (!keepTracking) lastQueuedCallbackByConn.delete(conn);
        resolve(value);
      };
      const onReply = (hadErr) => {
        // ssh2 reports REQUEST_SUCCESS as `false` and REQUEST_FAILURE as
        // `true`; the latter is OpenSSH's normal reply to the unsupported
        // keepalive@openssh.com request, so both count as a completed ping.
        // Only an Error instance (transport teardown/flush) is a failure.
        if (hadErr instanceof Error) {
          // The client is flushing the whole queue with an Error while
          // iterating it by index; splicing here would shift later
          // callbacks into already-visited slots, so ssh2 would skip
          // them (e.g. a pending forwardIn reply would hang until its
          // own timeout). Leave the array untouched instead — it is
          // being discarded by the client anyway.
          finish(null, false, false);
          return;
        }
        // A normal reply has already been shifted out of the FIFO by ssh2
        // before reaching this callback, so the splice below is a no-op;
        // consuming this slot also frees the connection for the next ping.
        finish(Math.max(0, Math.round(now() - startedAt)), true, false);
      };

      callbacks.push(onReply);
      lastQueuedCallbackByConn.set(conn, onReply);
      try {
        proto.ping();
      } catch {
        // The request was never sent, so the queued callback can never be
        // consumed; remove it to keep the FIFO intact.
        finish(null, true, false);
        return;
      }
      // On timeout, deliberately leave `onReply` in the queue as a tombstone:
      // global-request replies carry no request ID and ssh2 correlates them
      // by FIFO order, so a late reply must still consume this slot. The
      // tracking entry stays set so later polls skip this connection until
      // the tombstone is actually consumed by a reply.
      timer = setTimeoutFn(() => finish(null, false, true), timeoutMs);
    });
  };
}

module.exports = {
  createSshPingLatencyProbe,
  DEFAULT_PING_TIMEOUT_MS,
};
