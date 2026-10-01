import test from "node:test";
import assert from "node:assert/strict";

import { buildHostConnectionTestPlan, formatConnectionTestProgressLog } from "./hostConnectionTest";
import type { Host, SSHKey } from "./models";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Target",
  hostname: "target.example.test",
  port: 22,
  username: "alice",
  tags: [],
  os: "linux",
  protocol: "ssh",
  ...overrides,
});

const key = (overrides: Partial<SSHKey> = {}): SSHKey => ({
  id: "key-1",
  label: "id_ed25519",
  type: "ED25519",
  privateKey: "PRIVATE KEY MATERIAL",
  source: "generated",
  category: "key",
  created: 1,
  ...overrides,
});

const base = {
  hosts: [],
  keys: [],
  identities: [],
  knownHosts: [],
  groupConfigs: [],
  proxyProfiles: [],
  sessionId: "test-session",
  bootEpoch: 7,
};

test("builds password-auth options without proxy or chain", () => {
  const plan = buildHostConnectionTestPlan({
    ...base,
    host: host({ password: "secret", authMethod: "password" }),
  });

  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.needsCredentialReentry, false);
  assert.equal(plan.options.hostname, "target.example.test");
  assert.equal(plan.options.port, 22);
  assert.equal(plan.options.username, "alice");
  assert.equal(plan.options.password, "secret");
  assert.equal(plan.options.authMethod, "password");
  assert.equal(plan.options.proxy, undefined);
  assert.equal(plan.options.jumpHosts, undefined);
  assert.equal(plan.options.sessionId, "test-session");
  assert.equal(plan.options.bootEpoch, 7);
  assert.equal(plan.options.verifyHostKeys, true);
});

test("builds key-auth options with the resolved private key", () => {
  const plan = buildHostConnectionTestPlan({
    ...base,
    host: host({ identityFileId: "key-1" }),
    keys: [key()],
  });

  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.options.privateKey, "PRIVATE KEY MATERIAL");
  assert.equal(plan.options.keyId, "key-1");
  assert.equal(plan.options.password, undefined);
});

test("resolves a jump-host chain by id", () => {
  const plan = buildHostConnectionTestPlan({
    ...base,
    host: host({ hostChain: { hostIds: ["jump-1"] } }),
    hosts: [
      host({
        id: "jump-1",
        label: "Bastion",
        hostname: "jump.example.test",
        username: "root",
        password: "jump-pass",
        authMethod: "password",
      }),
    ],
  });

  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.options.jumpHosts?.length, 1);
  assert.equal(plan.options.jumpHosts?.[0].hostname, "jump.example.test");
  assert.equal(plan.options.jumpHosts?.[0].username, "root");
  assert.equal(plan.options.jumpHosts?.[0].password, "jump-pass");
});

test("fails when a configured chain host is missing", () => {
  const plan = buildHostConnectionTestPlan({
    ...base,
    host: host({ hostChain: { hostIds: ["missing-1"] } }),
  });

  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.match(plan.error, /jump host is missing/);
});

test("flags an undecryptable primary password for re-entry and strips it", () => {
  const encrypted = `enc:v1:${Buffer.from(`v10${"\0".repeat(16)}`).toString("base64")}`;
  const plan = buildHostConnectionTestPlan({
    ...base,
    host: host({ password: encrypted, authMethod: "password" }),
  });

  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.needsCredentialReentry, true);
  assert.equal(plan.options.password, undefined);
});

test("sanitizes an encrypted proxy credential into a failure plan", () => {
  const encrypted = `enc:v1:${Buffer.from(`v10${"\0".repeat(16)}`).toString("base64")}`;
  const plan = buildHostConnectionTestPlan({
    ...base,
    host: host({
      proxyConfig: {
        type: "socks5",
        host: "proxy.example.test",
        port: 1080,
        username: "proxy-user",
        password: encrypted,
      },
    }),
  });

  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.match(plan.error, /Proxy credentials cannot be decrypted/);
});

test("pins auto + password to a single password attempt", () => {
  const plan = buildHostConnectionTestPlan({
    ...base,
    host: host({ password: "secret", authPolicyVersion: 1 }),
  });

  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.options.authMethod, "password");
  assert.equal(plan.options.password, "secret");
});

test("uses short test-only connection timeouts", () => {
  const plan = buildHostConnectionTestPlan({
    ...base,
    host: host({ password: "secret", authMethod: "password" }),
  });

  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.options.sshTcpConnectTimeoutMs, 8000);
  assert.equal(plan.options.sshAuthReadyTimeoutMs, 15000);
});

test("formats single-hop progress log lines", () => {
  assert.equal(
    formatConnectionTestProgressLog({ hop: 1, total: 1, label: "target.example.test", phase: "connecting" }),
    "Connecting to target.example.test...",
  );
  assert.equal(
    formatConnectionTestProgressLog({ hop: 1, total: 1, label: "target.example.test", phase: "authenticated" }),
    "target.example.test - Authenticated",
  );
});

test("formats jump-host progress log lines with a hop prefix", () => {
  assert.equal(
    formatConnectionTestProgressLog({ hop: 1, total: 2, label: "jump.example.test", phase: "tcp-connected" }),
    "[1/2] jump.example.test - TCP connected",
  );
  assert.equal(
    formatConnectionTestProgressLog({ hop: 2, total: 2, label: "target.example.test", phase: "authenticating" }),
    "[2/2] target.example.test - Key exchange complete",
  );
  assert.equal(
    formatConnectionTestProgressLog({ hop: 2, total: 2, label: "target.example.test", phase: "error", error: "boom" }),
    "[2/2] target.example.test - Error: boom",
  );
});
