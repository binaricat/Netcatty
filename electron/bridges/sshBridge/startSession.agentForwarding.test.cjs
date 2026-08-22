"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveUnlockedEncryptedKeysForAuth,
  applyAgentForwarding,
  shouldOfferAgentForLogin,
  shouldPrepareSystemAgentForLogin,
  shouldPromoteCachedAuthMethod,
  prepareAgentForwardingOptions,
} = require("./startSession.cjs");

test("forwarding agent selection is resolved before connection reuse", async () => {
  const calls = [];
  const prepared = await prepareAgentForwardingOptions(
    { agentForwarding: true, identityAgent: "none" },
    async (identityAgent) => {
      calls.push(identityAgent);
      return "/Users/alice/.bitwarden-ssh-agent.sock";
    },
  );

  assert.deepEqual(calls, ["none"]);
  assert.equal(prepared._resolvedForwardingAgentSocket, "/Users/alice/.bitwarden-ssh-agent.sock");
  assert.equal(prepared.forwardingAgentSocket, "/Users/alice/.bitwarden-ssh-agent.sock");
});

test("pre-resolved forwarding agent selection is reused during SSH setup", async () => {
  const connectOptions = {};
  await applyAgentForwarding(
    {
      agentForwarding: true,
      _resolvedForwardingAgentSocket: "/Users/alice/.bitwarden-ssh-agent.sock",
    },
    connectOptions,
    async () => {
      throw new Error("forwarding socket should not be resolved twice");
    },
  );

  assert.equal(connectOptions.agent, "/Users/alice/.bitwarden-ssh-agent.sock");
  assert.equal(connectOptions.agentForward, true);
});

test("agent forwarding resolves the forwarding socket independently from login auth", async () => {
  const connectOptions = { password: "login-password" };
  const resolved = [];

  await applyAgentForwarding(
    { agentForwarding: true, useSshAgent: false },
    connectOptions,
    async (identityAgent) => {
      resolved.push(identityAgent);
      return "/Users/alice/.bitwarden-ssh-agent.sock";
    },
  );

  assert.deepEqual(resolved, [undefined]);
  assert.equal(connectOptions.agent, "/Users/alice/.bitwarden-ssh-agent.sock");
  assert.equal(connectOptions.agentForward, true);
});

test("agent forwarding replaces an automatically discovered empty login agent", async () => {
  const connectOptions = { agent: "/private/tmp/com.apple.launchd.test/Listeners" };

  await applyAgentForwarding(
    { agentForwarding: true },
    connectOptions,
    async () => "/Users/alice/.bitwarden-ssh-agent.sock",
    { replaceExistingAgent: true },
  );

  assert.equal(connectOptions.agent, "/Users/alice/.bitwarden-ssh-agent.sock");
  assert.equal(connectOptions.agentForward, true);
});

test("agent forwarding configures ssh2 separately from an explicitly prepared login agent", async () => {
  const explicitAgent = { kind: "selected-agent" };
  const connectOptions = { agent: explicitAgent };
  let resolutions = 0;

  await applyAgentForwarding(
    { agentForwarding: true, identityAgent: "/tmp/selected-agent.sock" },
    connectOptions,
    async () => {
      resolutions += 1;
      return "/tmp/other-agent.sock";
    },
  );

  assert.equal(connectOptions.agent, "/tmp/other-agent.sock");
  assert.equal(connectOptions.agentForward, true);
  assert.equal(resolutions, 1);
});

test("agent forwarding does not enable agent login after an explicit opt-out", () => {
  assert.equal(shouldOfferAgentForLogin(
    { useSshAgent: false, agentForwarding: true },
    { agent: "/tmp/agent.sock", agentForward: true },
  ), false);
});

test("agent login remains available when it is not explicitly disabled", () => {
  assert.equal(shouldOfferAgentForLogin(
    { agentForwarding: true },
    { agent: "/tmp/agent.sock", agentForward: true },
  ), true);
});

test("direct SSH allows only a restricted selected agent-backed key", () => {
  const selectedAgentKey = {
    authMethod: "key",
    useSshAgent: true,
    identitiesOnly: true,
    agentPublicKeys: ["ssh-ed25519 AAAASELECTED"],
  };
  assert.equal(shouldPrepareSystemAgentForLogin(selectedAgentKey), true);
  assert.equal(shouldOfferAgentForLogin(selectedAgentKey, { agent: {} }), true);

  const selectedReferencedKey = {
    ...selectedAgentKey,
    agentPublicKeys: [],
    identityFilePaths: ["~/.ssh/id_work"],
  };
  assert.equal(shouldPrepareSystemAgentForLogin(selectedReferencedKey), true);
  assert.equal(shouldOfferAgentForLogin(selectedReferencedKey, { agent: {} }), true);

  assert.equal(shouldPrepareSystemAgentForLogin({
    ...selectedAgentKey,
    agentPublicKeys: [],
    identityFilePaths: [],
  }), false);
  assert.equal(shouldOfferAgentForLogin({
    ...selectedAgentKey,
    identitiesOnly: false,
  }, { agent: {} }), false);
});

test("FIDO agent login is offered after path/inline sk detection even when renderer opted out of ssh-agent", () => {
  const pathOnlySk = {
    authMethod: "key",
    useSshAgent: false,
    useFidoAgent: true,
    identitiesOnly: true,
    identityFilePaths: ["~/.ssh/id_ed25519_sk"],
  };
  assert.equal(shouldOfferAgentForLogin(pathOnlySk, { agent: {} }), true);

  const inlineSk = {
    authMethod: "key",
    useSshAgent: false,
    useFidoAgent: true,
  };
  assert.equal(shouldOfferAgentForLogin(inlineSk, { agent: {} }), true);

  assert.equal(shouldOfferAgentForLogin({
    authMethod: "password",
    useSshAgent: false,
    useFidoAgent: true,
  }, { agent: {} }), false);
});

test("strict agent selection excludes unlocked default keys", () => {
  const unlocked = [{ keyName: "id_other", privateKey: "PRIVATE KEY" }];
  assert.deepEqual(resolveUnlockedEncryptedKeysForAuth({
    _unlockedEncryptedKeys: unlocked,
  }, true), []);
  assert.equal(resolveUnlockedEncryptedKeysForAuth({
    _unlockedEncryptedKeys: unlocked,
  }, false), unlocked);
});

test("explicit auth modes exclude unlocked unrelated default keys", () => {
  const unlocked = [{ keyName: "id_other", privateKey: "PRIVATE KEY" }];
  for (const authMethod of ["password", "key", "certificate"]) {
    assert.deepEqual(resolveUnlockedEncryptedKeysForAuth({
      authMethod,
      _unlockedEncryptedKeys: unlocked,
    }, false), []);
  }
  assert.equal(resolveUnlockedEncryptedKeysForAuth({
    authMethod: "auto",
    _unlockedEncryptedKeys: unlocked,
  }, false), unlocked);
});

test("cached methods cannot override explicit authentication ordering", () => {
  for (const authMethod of ["password", "key", "certificate"]) {
    assert.equal(shouldPromoteCachedAuthMethod(authMethod, "password"), false);
    assert.equal(shouldPromoteCachedAuthMethod(authMethod, "keyboard-interactive"), false);
  }
  assert.equal(shouldPromoteCachedAuthMethod("auto", "password"), false);
  assert.equal(shouldPromoteCachedAuthMethod("auto", "keyboard-interactive"), false);
  assert.equal(shouldPromoteCachedAuthMethod("auto", "agent"), true);
  assert.equal(shouldPromoteCachedAuthMethod("auto", "publickey-default-id_work"), true);
  assert.equal(shouldPromoteCachedAuthMethod(undefined, "password"), true);
});
