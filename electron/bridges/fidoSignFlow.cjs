"use strict";

const prompts = require("./fidoPromptHandler.cjs");

function failureReason(context) {
  if (context.timedOut) return "timeout";
  if (context.helperError === 60) return "device-unavailable";
  if (context.helperError === 43 && context.pinSubmitted) return "pin-failed";
  return "failed";
}

function cancelledError() {
  const error = new Error("Security key authentication cancelled.");
  error.code = "ERR_FIDO_CANCELLED";
  return error;
}

async function signWithRecovery(context, options, sign) {
  context.keyName = options.keyLabel || "";
  context.allowPasswordFallback = Boolean(options.password);
  for (;;) {
    if (context.controller.signal.aborted) return { error: cancelledError() };
    context.helperError = null;
    context.pinSubmitted = false;
    context.cancelled = false;
    context.timedOut = false;
    context.attemptController = new AbortController();
    const result = await new Promise(resolve => {
      try { sign((error, signature) => resolve({ error, signature })); }
      catch (error) { resolve({ error }); }
    });
    context.attemptController.abort();
    if (context.cancelled || context.controller.signal.aborted) return { error: cancelledError() };
    if (!result.error && !context.timedOut) return result;
    if (context.timedOut) result.error = new Error("Security key operation timed out");
    const sender = options.resolveWebContents?.();
    if (!sender || sender.isDestroyed?.()) return { error: cancelledError() };
    const response = await prompts.requestFidoPrompt(sender, {
      kind: "recovery", reason: failureReason(context), keyName: context.keyName,
      allowPasswordFallback: context.allowPasswordFallback, leaseId: context.leaseId,
      signal: context.controller.signal,
    });
    if (response?.response === "retry") continue;
    if (response?.response === "fallback" && context.allowPasswordFallback) return result;
    return { error: cancelledError() };
  }
}

module.exports = { signWithRecovery, failureReason, cancelledError };
