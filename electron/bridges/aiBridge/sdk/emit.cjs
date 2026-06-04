"use strict";

/**
 * Stream emitter: forwards translated SDK events to the renderer over the
 * SDK agent IPC channels consumed by sdkAgentAdapter.ts.
 *
 * Canonical event shapes consumed by sdkAgentAdapter.handleStreamEvent:
 *   { type: 'text-delta', textDelta }
 *   { type: 'reasoning-delta', delta }
 *   { type: 'reasoning-end' }
 *   { type: 'tool-call', toolName, args, toolCallId }
 *   { type: 'tool-result', toolCallId, output, toolName }
 *   { type: 'status', message }
 *   { type: 'session-id', sessionId }
 *   { type: 'error', error }
 */
function createStreamEmitter({ safeSend, sender, requestId }) {
  const emitEvent = (event) => {
    safeSend(sender, "netcatty:ai:sdk-agent:event", { requestId, event });
  };
  return {
    emitEvent,
    emitDone() {
      safeSend(sender, "netcatty:ai:sdk-agent:done", { requestId });
    },
    emitError(error) {
      safeSend(sender, "netcatty:ai:sdk-agent:error", { requestId, error });
    },
    text(textDelta) {
      if (textDelta) emitEvent({ type: "text-delta", textDelta });
    },
    reasoning(delta) {
      if (delta) emitEvent({ type: "reasoning-delta", delta });
    },
    reasoningEnd() {
      emitEvent({ type: "reasoning-end" });
    },
    toolCall(toolName, args, toolCallId) {
      emitEvent({ type: "tool-call", toolName: toolName || "unknown", args: args || {}, toolCallId });
    },
    toolResult(toolCallId, output, toolName) {
      emitEvent({ type: "tool-result", toolCallId: toolCallId || "", output, toolName });
    },
    status(message) {
      if (message) emitEvent({ type: "status", message });
    },
    sessionId(sessionId) {
      if (sessionId) emitEvent({ type: "session-id", sessionId });
    },
  };
}

module.exports = { createStreamEmitter };
