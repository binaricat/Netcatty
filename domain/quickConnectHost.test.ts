import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQuickConnectHost,
  getQuickConnectDefaultPort,
  isQuickConnectIdentityCompatible,
  isQuickConnectIdentityUsable,
} from "./quickConnectHost.ts";
import { resolveHostAuth } from "./sshAuth.ts";

const target = { hostname: "example.com" };

test("JumpServer login only offers identities with the full asset selector", () => {
  const identity = {
    id: "jump-user",
    label: "Jump user",
    username: "chenyi",
    authMethod: "password" as const,
    password: "secret",
    created: 1,
  };
  const jumpTarget = { hostname: "jump.example", username: "chenyi@root@10.2.0.8", isJumpServerLogin: true as const };
  assert.equal(isQuickConnectIdentityCompatible(identity, jumpTarget), false);
  assert.equal(isQuickConnectIdentityCompatible(
    { ...identity, username: "other" }, jumpTarget,
  ), false);
  assert.equal(isQuickConnectIdentityCompatible(
    { ...identity, username: jumpTarget.username }, jumpTarget,
  ), true);
  assert.equal(isQuickConnectIdentityCompatible(identity, { hostname: "jump.example", username: "chenyi" }), true);
  assert.equal(isQuickConnectIdentityCompatible(identity, { hostname: "host.example", username: "user@realm" }), true);
});

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

test("quick connect builds valid standalone RDP and VNC hosts and resolves default ports", () => {
  assert.equal(getQuickConnectDefaultPort("rdp"), 3389);
  assert.equal(getQuickConnectDefaultPort("vnc"), 5900);

  const rdpHost = buildQuickConnectHost({
    id: "quick-rdp",
    createdAt: 10,
    target: { hostname: "win.example.com", protocol: "rdp", domain: "CORP" },
    protocol: "rdp",
    port: 3390,
    username: "Administrator",
    authMethod: "password",
    password: "rdp-secret",
  });
  assert.equal(rdpHost.protocol, "rdp");
  assert.equal(rdpHost.os, "windows");
  assert.equal(rdpHost.port, 3390);
  assert.equal(rdpHost.username, "Administrator");
  assert.equal(rdpHost.password, "rdp-secret");
  assert.equal(rdpHost.authMethod, "password");
  assert.equal(rdpHost.rdpConfig?.domain, "CORP");
  assert.equal(rdpHost.rdpConfig?.port, 3390);
  assert.equal(rdpHost.ephemeral, true);

  const vncHost = buildQuickConnectHost({
    id: "quick-vnc",
    createdAt: 20,
    target: { hostname: "vnc.example.com", protocol: "vnc" },
    protocol: "vnc",
    port: 5901,
    username: "",
    authMethod: "password",
    password: "vnc-secret",
    save: true,
  });
  assert.equal(vncHost.protocol, "vnc");
  assert.equal(vncHost.username, "");
  assert.equal(vncHost.port, 5901);
  assert.equal(vncHost.password, "vnc-secret");
  assert.equal(vncHost.authMethod, "password");
  assert.equal(vncHost.vncConfig?.port, 5901);
  assert.equal(vncHost.ephemeral, false);

  assert.equal(isQuickConnectIdentityUsable({
    id: "vnc-pass-only",
    label: "VNC Pass",
    username: "",
    authMethod: "password",
    password: "secret",
    created: 1,
  }, [], "vnc"), true);

  assert.equal(isQuickConnectIdentityUsable({
    id: "ssh-key-only",
    label: "Key Only",
    username: "admin",
    authMethod: "key",
    keyId: "k1",
    created: 1,
  }, [{ id: "k1", label: "K", type: "ED25519", privateKey: "pem", source: "imported", category: "key", created: 1 }], "rdp"), false);
});
