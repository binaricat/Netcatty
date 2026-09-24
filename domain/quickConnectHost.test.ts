import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQuickConnectHost,
  buildQuickConnectJumpHost,
  isQuickConnectIdentityUsable,
} from "./quickConnectHost.ts";
import { resolveHostAuth } from "./sshAuth.ts";

const target = { hostname: "example.com" };

test("quick connect keeps a selected credential preset as the host identity", () => {
  const host = buildQuickConnectHost({
    id: "quick-1",
    createdAt: 123,
    target,
    protocol: "ssh",
    port: 22,
    username: "root",
    authMethod: "password",
    password: "must-not-be-copied",
    selectedIdentityId: "identity-root",
  });

  assert.equal(host.identityId, "identity-root");
  assert.equal(host.username, "root");
  assert.equal(host.authMethod, "password");
  assert.equal(host.password, undefined);
  assert.equal(host.identityFileId, undefined);
  assert.equal(host.ephemeral, true);

  const resolved = resolveHostAuth({
    host,
    keys: [],
    identities: [{
      id: "identity-root",
      label: "Root",
      username: "root",
      authMethod: "password",
      password: "resolved-secret",
      created: 1,
    }],
  });
  assert.equal(resolved.password, "resolved-secret");
});

test("quick connect only offers one-click connection for usable credential presets", () => {
  assert.equal(isQuickConnectIdentityUsable({
    id: "password",
    label: "Root",
    username: "root",
    authMethod: "password",
    password: "secret",
    created: 1,
  }, []), true);

  assert.equal(isQuickConnectIdentityUsable({
    id: "missing-key",
    label: "Deploy",
    username: "deploy",
    authMethod: "key",
    keyId: "key-that-is-not-here",
    created: 2,
  }, []), false);

  assert.equal(isQuickConnectIdentityUsable({
    id: "telnet-password",
    label: "Network password",
    username: "admin",
    authMethod: "password",
    password: "secret",
    created: 3,
  }, [], "telnet"), false);
});

test("quick connect preserves manually entered password authentication", () => {
  const host = buildQuickConnectHost({
    id: "quick-2",
    createdAt: 456,
    target,
    protocol: "ssh",
    port: 2222,
    username: "operator",
    authMethod: "password",
    password: "manual-secret",
  });

  assert.equal(host.identityId, undefined);
  assert.equal(host.username, "operator");
  assert.equal(host.password, "manual-secret");
  assert.equal(host.port, 2222);
  assert.equal(host.ephemeral, true);
});

test("quick connect creates an ephemeral ET connection without saving credentials", () => {
  const host = buildQuickConnectHost({
    id: "quick-et",
    createdAt: 1,
    target,
    protocol: "et",
    port: 22,
    username: "alice",
    authMethod: "password",
    password: "secret",
  });

  assert.equal(host.protocol, "ssh");
  assert.equal(host.etEnabled, true);
  assert.equal(host.etPort, 2022);
  assert.equal(host.ephemeral, true);
  assert.equal(host.password, "secret");
});

test("quick connect keeps Mosh on SSH bootstrap settings", () => {
  const host = buildQuickConnectHost({
    id: "quick-mosh",
    createdAt: 1,
    target,
    protocol: "mosh",
    port: 2202,
    username: "root",
    authMethod: "key",
    selectedKeyId: "key-1",
    save: true,
  });

  assert.equal(host.protocol, "ssh");
  assert.equal(host.port, 2202);
  assert.equal(host.moshEnabled, true);
  assert.equal(host.identityFileId, "key-1");
  assert.equal(host.ephemeral, false);
});

test("quick connect never applies an SSH identity to Telnet", () => {
  const host = buildQuickConnectHost({
    id: "quick-telnet",
    createdAt: 1,
    target,
    protocol: "telnet",
    port: 2323,
    username: "telnet-user",
    authMethod: "password",
    password: "telnet-secret",
    selectedIdentityId: "stale-ssh-identity",
  });

  assert.equal(host.identityId, undefined);
  assert.equal(host.telnetIdentityId, undefined);
  assert.equal(host.username, "telnet-user");
  assert.equal(host.password, "telnet-secret");
  assert.equal(host.telnetPort, 2323);
});

test("quick connect attaches a jump chain by id when given", () => {
  const host = buildQuickConnectHost({
    id: "quick-jump-target",
    createdAt: 1,
    target: { hostname: "10.2.0.8", username: "root" },
    protocol: "ssh",
    port: 22,
    username: "root",
    authMethod: "password",
    chainHostIds: ["quick-jump-1"],
  });

  assert.deepEqual(host.hostChain, { hostIds: ["quick-jump-1"] });
});

test("quick connect builds an ephemeral SSH host for a jump hop", () => {
  const jumpHost = buildQuickConnectJumpHost({
    id: "quick-jump-1",
    createdAt: 42,
    jump: { hostname: "devjumpserver.example.cn", username: "chenyi", port: 2200 },
  });

  assert.equal(jumpHost.id, "quick-jump-1");
  assert.equal(jumpHost.hostname, "devjumpserver.example.cn");
  assert.equal(jumpHost.username, "chenyi");
  assert.equal(jumpHost.port, 2200);
  assert.equal(jumpHost.protocol, "ssh");
  assert.equal(jumpHost.ephemeral, true);
  assert.equal(jumpHost.label, "chenyi@devjumpserver.example.cn");

  const anonymousJump = buildQuickConnectJumpHost({
    id: "quick-jump-2",
    createdAt: 1,
    jump: { hostname: "jump.corp.example" },
  });
  assert.equal(anonymousJump.username, "");
  assert.equal(anonymousJump.port, 22);
  assert.equal(anonymousJump.label, "jump.corp.example");

  const savedJump = buildQuickConnectJumpHost({
    id: "quick-jump-3",
    createdAt: 1,
    jump: { hostname: "jump.corp.example" },
    save: true,
  });
  assert.equal(savedJump.ephemeral, false);
});
