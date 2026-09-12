"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bindChatSessionId,
  describeMissingChatSession,
  describeRemovedChatSessionFlag,
  isRemovedChatSessionFlag,
  injectCliTransportEnv,
  TOOL_CLI_CHAT_SESSION_ENV_VAR,
} = require("./cliChatSession.cjs");
const { TOOL_CLI_DISCOVERY_ENV_VAR } = require("./discoveryPath.cjs");

test("bindChatSessionId reads host env", () => {
  assert.equal(
    bindChatSessionId({ [TOOL_CLI_CHAT_SESSION_ENV_VAR]: " env-id " }),
    "env-id",
  );
});

test("bindChatSessionId ignores argv-shaped objects and only reads env", () => {
  assert.equal(
    bindChatSessionId({
      [TOOL_CLI_CHAT_SESSION_ENV_VAR]: "env-id",
      chatSessionId: "flag-id",
    }),
    "env-id",
  );
});

test("bindChatSessionId returns null when env is blank", () => {
  assert.equal(bindChatSessionId({ [TOOL_CLI_CHAT_SESSION_ENV_VAR]: "  " }), null);
});

test("isRemovedChatSessionFlag matches the dropped flag forms", () => {
  assert.equal(isRemovedChatSessionFlag("--chat-session"), true);
  assert.equal(isRemovedChatSessionFlag("--chat-session=chat-1"), true);
  assert.equal(isRemovedChatSessionFlag("--session"), false);
});

test("describeMissingChatSession names the env var and not a flag", () => {
  assert.match(describeMissingChatSession("env"), /NETCATTY_CLI_CHAT_SESSION_ID/);
  assert.doesNotMatch(describeMissingChatSession("env"), /--chat-session/);
});

test("describeRemovedChatSessionFlag points at the host env var", () => {
  assert.match(describeRemovedChatSessionFlag(), /NETCATTY_CLI_CHAT_SESSION_ID/);
});

test("injectCliTransportEnv writes discovery path and trusted chat session", () => {
  const env = injectCliTransportEnv(
    { PATH: "/usr/bin", [TOOL_CLI_CHAT_SESSION_ENV_VAR]: "spoof" },
    { discoveryFilePath: "/tmp/discovery.json", chatSessionId: " ai_123 " },
  );
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env[TOOL_CLI_DISCOVERY_ENV_VAR], "/tmp/discovery.json");
  assert.equal(env[TOOL_CLI_CHAT_SESSION_ENV_VAR], "ai_123");
});

test("injectCliTransportEnv strips spoofed chat session when host id is absent", () => {
  const env = injectCliTransportEnv(
    { [TOOL_CLI_CHAT_SESSION_ENV_VAR]: "spoof" },
    { discoveryFilePath: "/tmp/discovery.json" },
  );
  assert.equal(env[TOOL_CLI_CHAT_SESSION_ENV_VAR], undefined);
  assert.equal(env[TOOL_CLI_DISCOVERY_ENV_VAR], "/tmp/discovery.json");
});
