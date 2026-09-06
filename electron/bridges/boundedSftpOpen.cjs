"use strict";

// An abandoned OPEN cannot be cancelled in SSH, but its physical connection
// may own unrelated terminals. Block only additional opens until its callback
// or transport closure settles; retain no unbounded retry queue.
const abandonedOpens = new WeakMap();

function abandonOpen(client, token) {
  let state = abandonedOpens.get(client);
  if (!state) {
    state = { tokens: new Set(), onClose: null };
    state.onClose = () => {
      if (abandonedOpens.get(client) === state) abandonedOpens.delete(client);
      state.tokens.clear();
    };
    abandonedOpens.set(client, state);
    client.once?.("close", state.onClose);
  }
  state.tokens.add(token);
}

function settleAbandonedOpen(client, token) {
  const state = abandonedOpens.get(client);
  if (!state || !state.tokens.delete(token) || state.tokens.size > 0) return;
  abandonedOpens.delete(client);
  client.removeListener?.("close", state.onClose);
}

const DEFAULT_SFTP_CHANNEL_OPEN_TIMEOUT_MS = 10_000;

function closeSftpChannel(channel) {
  if (!channel) return;
  try { channel.once?.("error", () => {}); } catch { /* ignore */ }
  try { channel.end?.(); } catch { /* ignore */ }
  try { channel.close?.(); } catch { /* ignore */ }
  try { channel.destroy?.(); } catch { /* ignore */ }
}

function createSftpOpenAbortError(signal) {
  const reason = signal?.reason;
  const error = reason instanceof Error ? reason : new Error("SFTP channel open was aborted");
  if (!error.code) error.code = "ABORT_ERR";
  return error;
}

function openBoundedSftpChannel(sshClient, options = {}) {
  if (!sshClient || typeof sshClient.sftp !== "function") {
    return Promise.resolve(null);
  }
  const signal = options.signal || null;
  if (signal?.aborted) return Promise.reject(createSftpOpenAbortError(signal));
  if (abandonedOpens.has(sshClient)) {
    const error = new Error("A previous SFTP channel open is still pending on this connection");
    error.code = "SFTP_CHANNEL_OPEN_PENDING";
    return Promise.reject(error);
  }
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const timeoutMs = Math.max(
    1,
    Number(options.timeoutMs) || DEFAULT_SFTP_CHANNEL_OPEN_TIMEOUT_MS,
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let requestPending = false;
    const token = Symbol("sftp-open");
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeoutFn(timer);
      timer = null;
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = (error, channel = null, { abandon = false } = {}) => {
      if (settled) {
        closeSftpChannel(channel);
        return false;
      }
      settled = true;
      cleanup();
      if (error && channel) closeSftpChannel(channel);
      if (abandon && requestPending) abandonOpen(sshClient, token);
      if (error) reject(error);
      else resolve(channel);
      return true;
    };
    const onAbort = () => finish(createSftpOpenAbortError(signal), null, {
      abandon: true,
    });

    if (signal?.aborted) {
      finish(createSftpOpenAbortError(signal));
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    // Keep the correctness deadline referenced until the open settles. An
    // unreferenced timer can let Node exit with this promise still pending.
    timer = setTimeoutFn(() => {
      const error = new Error(`SFTP channel open timed out after ${timeoutMs}ms`);
      error.code = "SFTP_CHANNEL_OPEN_TIMEOUT";
      finish(error, null, { abandon: true });
    }, timeoutMs);

    try {
      requestPending = true;
      sshClient.sftp((error, channel) => {
        requestPending = false;
        settleAbandonedOpen(sshClient, token);
        if (error) finish(error, channel || null);
        else finish(null, channel || null);
      });
    } catch (error) {
      requestPending = false;
      settleAbandonedOpen(sshClient, token);
      finish(error);
    }
  });
}

module.exports = {
  DEFAULT_SFTP_CHANNEL_OPEN_TIMEOUT_MS,
  closeSftpChannel,
  openBoundedSftpChannel,
};
