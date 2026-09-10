"use strict";

const {
  TOOL_CLI_CHAT_SESSION_ENV_VAR,
  TOOL_CLI_DISCOVERY_ENV_VAR,
} = require("./discoveryPath.cjs");

function trimId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function describeRemovedChatSessionFlag() {
  return (
    `--chat-session is not a CLI flag. ` +
    `The host binds the chat session via ${TOOL_CLI_CHAT_SESSION_ENV_VAR}.`
  );
}

function isRemovedChatSessionFlag(arg) {
  return arg === "--chat-session" || (typeof arg === "string" && arg.startsWith("--chat-session="));
}

/**
 * Resolve the chat-session tenant key from the host-injected env only.
 * Each SDK agent process gets its own NETCATTY_CLI_CHAT_SESSION_ID, so
 * concurrent chat windows do not share this binding.
 */
function bindChatSessionId(env = process.env) {
  const fromEnv = trimId(env?.[TOOL_CLI_CHAT_SESSION_ENV_VAR]);
  return fromEnv || null;
}

function describeMissingChatSession(commandLabel) {
  return (
    `Missing chat session for ${commandLabel}. ` +
    `Set ${TOOL_CLI_CHAT_SESSION_ENV_VAR} in the host-launched environment.`
  );
}

/**
 * Env handed to SDK agent subprocesses for Skills + CLI.
 * Always strips a caller-supplied chat-session id, then writes the trusted host id.
 */
function injectCliTransportEnv(env, { discoveryFilePath, chatSessionId } = {}) {
  const next = { ...(env && typeof env === "object" ? env : {}) };
  delete next[TOOL_CLI_CHAT_SESSION_ENV_VAR];
  if (discoveryFilePath) {
    next[TOOL_CLI_DISCOVERY_ENV_VAR] = discoveryFilePath;
  }
  const id = trimId(chatSessionId);
  if (id) {
    next[TOOL_CLI_CHAT_SESSION_ENV_VAR] = id;
  }
  return next;
}

module.exports = {
  bindChatSessionId,
  describeMissingChatSession,
  describeRemovedChatSessionFlag,
  isRemovedChatSessionFlag,
  injectCliTransportEnv,
  TOOL_CLI_CHAT_SESSION_ENV_VAR,
};
