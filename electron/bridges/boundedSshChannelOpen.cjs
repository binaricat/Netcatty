"use strict";

const { invalidateSshTransport } = require("./sshTransportInvalidation.cjs");

const DEFAULT_SSH_CHANNEL_OPEN_TIMEOUT_MS = 30_000;
const DEFAULT_SSH_CHANNEL_OPEN_RATE_LIMIT_RETRIES = 3;
const DEFAULT_SSH_CHANNEL_OPEN_RATE_LIMIT_BACKOFF_MS = 150;

function closeLateChannel(channel) {
  if (!channel || typeof channel === "number") return;
  try { channel.once?.("error", () => {}); } catch { /* ignore */ }
  try { channel.close?.(); } catch { /* ignore */ }
  try { channel.end?.(); } catch { /* ignore */ }
  try { channel.destroy?.(); } catch { /* ignore */ }
}

function channelAbortError(signal, label) {
  const reason = signal?.reason;
  const error = reason instanceof Error ? reason : new Error(`${label} was cancelled`);
  if (!error.code) error.code = "ABORT_ERR";
  return error;
}

function monotonicNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/**
 * Bastion / jump hosts sometimes reject rapid session channel opens with a
 * distinctive rate-limit message. The common Chinese bastion typo "offen"
 * (for "often") is part of the real wire text we see in the field.
 */
function isSshChannelOpenRateLimitedError(error) {
  const message = String(error?.message || error || "");
  return /channelOpen\s+too\s+offen\b/i.test(message)
    || /channelOpen\s+too\s+often\b/i.test(message);
}

function sleep(ms, sleepFn = null, signal = null, label = "SSH channel retry") {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(channelAbortError(signal, label));

    if (signal?.aborted) {
      finish(channelAbortError(signal, label));
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (typeof sleepFn === "function") {
      void Promise.resolve()
        .then(() => sleepFn(ms))
        .then(() => finish(), (error) => finish(error));
      return;
    }
    timer = setTimeout(() => finish(), ms);
  });
}

function openBoundedSshChannel(sshClient, invoke, options = {}) {
  const label = String(options.label || "SSH channel open");
  const timeoutMs = Math.max(
    1,
    Number(options.timeoutMs) || DEFAULT_SSH_CHANNEL_OPEN_TIMEOUT_MS,
  );
  const signal = options.signal || null;
  const closeLateResult = options.closeLateResult || closeLateChannel;
  const timeoutCode = options.timeoutCode || "SSH_CHANNEL_OPEN_TIMEOUT";
  const invalidateOnAbort = options.invalidateOnAbort !== false;
  const invalidateOnTimeout = options.invalidateOnTimeout !== false;
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;

  return new Promise((resolve, reject) => {
    let settled = false;
    let invoked = false;
    let abandoned = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeoutFn(timer);
      timer = null;
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = (error, result, { invalidate = false, abandon = false } = {}) => {
      if (settled) {
        if (result) closeLateResult(result);
        if (abandoned) {
          abandoned = false;
          try { options.onAbandonedOpenSettled?.(); } catch { /* ignore */ }
        }
        return false;
      }
      settled = true;
      cleanup();
      if (error && result) closeLateResult(result);
      if (abandon && invoked) {
        abandoned = true;
        try { options.onAbandonedOpen?.(); } catch { /* ignore */ }
      }
      if (invalidate) invalidateSshTransport(sshClient);
      if (error) reject(error);
      else resolve(result);
      return true;
    };
    const onAbort = () => finish(
      channelAbortError(signal, label),
      null,
      { invalidate: invalidateOnAbort, abandon: !invalidateOnAbort },
    );

    if (signal?.aborted) {
      finish(channelAbortError(signal, label));
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    // This is a correctness deadline, not background housekeeping. It must
    // remain referenced until the channel open settles; cleanup clears it on
    // every success, error, abort, and synchronous-throw path.
    timer = setTimeoutFn(() => {
      const error = new Error(`${label} timed out after ${timeoutMs} ms`);
      error.code = timeoutCode;
      finish(error, null, {
        invalidate: invalidateOnTimeout,
        abandon: !invalidateOnTimeout,
      });
    }, timeoutMs);

    try {
      invoked = true;
      invoke((error, result) => finish(error, result));
    } catch (error) {
      finish(error);
    }
  });
}

async function openBoundedSshShell(sshClient, windowOptions, shellOptions, options = {}) {
  const hasRateLimitRetryTimeout = Number.isFinite(options.rateLimitRetryTimeoutMs);
  const hasExplicitRateLimitRetries = Number.isFinite(options.rateLimitRetries);
  const rateLimitRetries = Math.max(
    0,
    hasExplicitRateLimitRetries
      ? Number(options.rateLimitRetries)
      : hasRateLimitRetryTimeout
        ? Number.POSITIVE_INFINITY
        : DEFAULT_SSH_CHANNEL_OPEN_RATE_LIMIT_RETRIES,
  );
  const rateLimitRetryTimeoutMs = hasRateLimitRetryTimeout
    ? Math.max(0, Number(options.rateLimitRetryTimeoutMs))
    : null;
  const rateLimitBackoffMs = Math.max(
    1,
    Number(options.rateLimitBackoffMs) || DEFAULT_SSH_CHANNEL_OPEN_RATE_LIMIT_BACKOFF_MS,
  );
  const sleepFn = options.sleepFn || null;
  const nowFn = typeof options.nowFn === "function" ? options.nowFn : monotonicNow;
  const retryStartedAt = nowFn();
  const retryDeadline = rateLimitRetryTimeoutMs === null
    ? null
    : retryStartedAt + rateLimitRetryTimeoutMs;
  let attempt = 0;
  let lastRateLimitError = null;

  for (;;) {
    const attemptStartedAt = nowFn();
    if (
      lastRateLimitError
      && retryDeadline !== null
      && attemptStartedAt >= retryDeadline
    ) {
      throw lastRateLimitError;
    }
    const configuredAttemptTimeoutMs = Math.max(
      1,
      Number(options.timeoutMs) || DEFAULT_SSH_CHANNEL_OPEN_TIMEOUT_MS,
    );
    const isRateLimitRetry = lastRateLimitError !== null;
    const attemptTimeoutMs = retryDeadline === null || !isRateLimitRetry
      ? configuredAttemptTimeoutMs
      : Math.max(
          1,
          Math.min(configuredAttemptTimeoutMs, Math.ceil(retryDeadline - attemptStartedAt)),
        );
    const retryBudgetConstrainsAttempt = isRateLimitRetry
      && attemptTimeoutMs < configuredAttemptTimeoutMs;
    try {
      return await openBoundedSshChannel(
        sshClient,
        (callback) => sshClient.shell(windowOptions, shellOptions, callback),
        {
          ...options,
          timeoutMs: attemptTimeoutMs,
          invalidateOnTimeout: retryBudgetConstrainsAttempt
            ? false
            : options.invalidateOnTimeout,
          label: options.label || "SSH shell channel open",
          timeoutCode: "SSH_SHELL_OPEN_TIMEOUT",
        },
      );
    } catch (error) {
      if (
        retryBudgetConstrainsAttempt
        && error?.code === "SSH_SHELL_OPEN_TIMEOUT"
        && lastRateLimitError
      ) {
        throw lastRateLimitError;
      }
      if (!isSshChannelOpenRateLimitedError(error) || options.signal?.aborted) {
        throw error;
      }
      lastRateLimitError = error;
      const nextDelayMs = rateLimitBackoffMs * (attempt + 1);
      const retryTimeoutExpired = rateLimitRetryTimeoutMs !== null
        && nowFn() + nextDelayMs >= retryDeadline;
      if (
        attempt >= rateLimitRetries
        || retryTimeoutExpired
      ) {
        throw error;
      }
      attempt += 1;
      await sleep(
        nextDelayMs,
        sleepFn,
        options.signal,
        options.label || "SSH shell channel retry",
      );
    }
  }
}

function openBoundedForwardOut(
  sshClient,
  sourceAddress,
  sourcePort,
  targetAddress,
  targetPort,
  options = {},
) {
  return openBoundedSshChannel(
    sshClient,
    (callback) => sshClient.forwardOut(
      sourceAddress,
      sourcePort,
      targetAddress,
      targetPort,
      callback,
    ),
    {
      ...options,
      label: options.label || "SSH forwardOut channel open",
      timeoutCode: "SSH_FORWARD_OUT_TIMEOUT",
    },
  );
}

function openBoundedForwardIn(sshClient, bindAddress, bindPort, options = {}) {
  return openBoundedSshChannel(
    sshClient,
    (callback) => sshClient.forwardIn(bindAddress, bindPort, callback),
    {
      ...options,
      label: options.label || "SSH forwardIn request",
      timeoutCode: "SSH_FORWARD_IN_TIMEOUT",
      closeLateResult: () => {},
    },
  );
}

function deliverChannelOpenCallback(promise, callback) {
  void promise.then(
    (result) => callback(null, result),
    (error) => callback(error),
  );
}

function openBoundedSshShellCallback(
  sshClient,
  windowOptions,
  shellOptions,
  callback,
  options = {},
) {
  deliverChannelOpenCallback(
    openBoundedSshShell(sshClient, windowOptions, shellOptions, options),
    callback,
  );
}

function openBoundedForwardOutCallback(
  sshClient,
  sourceAddress,
  sourcePort,
  targetAddress,
  targetPort,
  callback,
  options = {},
) {
  deliverChannelOpenCallback(
    openBoundedForwardOut(
      sshClient,
      sourceAddress,
      sourcePort,
      targetAddress,
      targetPort,
      options,
    ),
    callback,
  );
}

function openBoundedForwardInCallback(
  sshClient,
  bindAddress,
  bindPort,
  callback,
  options = {},
) {
  deliverChannelOpenCallback(
    openBoundedForwardIn(sshClient, bindAddress, bindPort, options),
    callback,
  );
}

module.exports = {
  DEFAULT_SSH_CHANNEL_OPEN_TIMEOUT_MS,
  DEFAULT_SSH_CHANNEL_OPEN_RATE_LIMIT_RETRIES,
  DEFAULT_SSH_CHANNEL_OPEN_RATE_LIMIT_BACKOFF_MS,
  closeLateChannel,
  isSshChannelOpenRateLimitedError,
  openBoundedSshChannel,
  openBoundedSshShell,
  openBoundedSshShellCallback,
  openBoundedForwardOut,
  openBoundedForwardOutCallback,
  openBoundedForwardIn,
  openBoundedForwardInCallback,
};
