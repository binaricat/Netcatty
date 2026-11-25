import assert from "node:assert/strict";
import test from "node:test";

import type { Host, Identity, KnownHost, SSHKey } from "./models.ts";
import { buildSshConnectionCredentials } from "./sshConnectionCredentials.ts";

const makeHost = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Target",
  hostname: "target.example.com",
  username: "root",
  tags: [],
  os: "linux",
  ...overrides,
});

test("buildSshConnectionCredentials formats missing jump host errors with default and custom formatters", () => {
  assert.throws(
    () => buildSshConnectionCredentials({
      host: makeHost({ hostChain: { hostIds: ["missing-a", "missing-b"] } }),
      hosts: [],
      keys: [],
      identities: [],
    }),
    /Jump host "missing-a" is missing\. Open host settings and repair the jump host chain\./,
  );

  assert.throws(
    () => buildSshConnectionCredentials({
      host: makeHost({ hostChain: { hostIds: ["missing-a", "missing-b"] } }),
      hosts: [],
      keys: [],
      identities: [],
      formatMissingJumpHostsError: (missingIds) =>
        `Missing jump host configuration for host chain: ${missingIds.join(", ")}`,
    }),
    /Missing jump host configuration for host chain: missing-a, missing-b/,
  );
});

test("buildSshConnectionCredentials builds target and jump-host credentials with pinned override, TOTP, timeouts, and known hosts", () => {
  const pinnedJump = makeHost({
    id: "jump-1",
    label: "Pinned Bastion",
    hostname: "bastion.pinned.internal",
    port: 2222,
    username: "ops",
    authMethod: "key",
    identityFileId: "key-jump",
    sshTcpConnectTimeoutSeconds: 40,
    sshAuthReadyTimeoutSeconds: 180,
    totp: { uri: "otpauth://totp/Jump?secret=JBSWY3DPEHPK3PXP", autoSubmit: true },
  });
  const liveJump = makeHost({
    id: "jump-1",
    hostname: "bastion.live.internal",
  });
  const jumpKey: SSHKey = {
    id: "key-jump",
    label: "Jump Ref Key",
    type: "ED25519",
    privateKey: "",
    source: "reference",
    category: "key",
    created: 1,
    filePath: "/Users/alice/.ssh/jump_key",
    passphrase: "jump-passphrase",
  };
  const proxyIdentity: Identity = {
    id: "proxy-id",
    label: "Proxy Login",
    username: "proxy-user",
    authMethod: "password",
    password: "proxy-password",
    created: 1,
  };
  const knownHosts: KnownHost[] = [{
    id: "kh-1",
    hostname: "target.example.com",
    port: 22,
    keyType: "ssh-ed25519",
    publicKey: "ssh-ed25519 AAAA",
    fingerprint: "SHA256:test",
    discoveredAt: 1,
  }];

  const result = buildSshConnectionCredentials({
    host: makeHost({
      hostChain: { hostIds: ["jump-1"] },
      proxyConfig: {
        type: "http",
        host: "proxy.internal",
        port: 8080,
        identityId: "proxy-id",
      },
      sshTcpConnectTimeoutSeconds: 25,
      sshAuthReadyTimeoutSeconds: 120,
      legacyAlgorithms: true,
      skipEcdsaHostKey: true,
      totp: { uri: "otpauth://totp/Target?secret=JBSWY3DPEHPK3PXP", autoSubmit: false },
    }),
    hosts: [liveJump],
    keys: [jumpKey],
    identities: [proxyIdentity],
    knownHosts,
    terminalSettings: {
      verifyHostKeys: false,
      keepaliveInterval: 45,
      keepaliveCountMax: 6,
    },
    jumpHostsOverride: [pinnedJump],
  });

  assert.equal(result.port, 22);
  assert.equal(result.knownHosts, knownHosts);
  assert.equal(result.verifyHostKeys, false);
  assert.equal(result.keepaliveInterval, 45);
  assert.equal(result.keepaliveCountMax, 6);
  assert.equal(result.sshTcpConnectTimeoutMs, 25_000);
  assert.equal(result.sshAuthReadyTimeoutMs, 120_000);
  assert.equal(result.legacyAlgorithms, true);
  assert.equal(result.skipEcdsaHostKey, true);
  assert.deepEqual(result.totp, {
    uri: "otpauth://totp/Target?secret=JBSWY3DPEHPK3PXP",
    autoSubmit: false,
  });
  assert.deepEqual(result.proxy, {
    type: "http",
    host: "proxy.internal",
    port: 8080,
    username: "proxy-user",
    password: "proxy-password",
  });
  assert.equal(result.jumpHosts?.length, 1);
  assert.equal(result.jumpHosts?.[0]?.hostname, "bastion.pinned.internal");
  assert.equal(result.jumpHosts?.[0]?.port, 2222);
  assert.deepEqual(result.jumpHosts?.[0]?.identityFilePaths, ["/Users/alice/.ssh/jump_key"]);
  assert.equal(result.jumpHosts?.[0]?.passphrase, "jump-passphrase");
  assert.equal(result.jumpHosts?.[0]?.sshTcpConnectTimeoutMs, 40_000);
  assert.equal(result.jumpHosts?.[0]?.sshAuthReadyTimeoutMs, 180_000);
  assert.deepEqual(result.jumpHosts?.[0]?.totp, {
    uri: "otpauth://totp/Jump?secret=JBSWY3DPEHPK3PXP",
    autoSubmit: true,
  });
});

test("buildSshConnectionCredentials validates missing saved proxies and undecryptable credentials", () => {
  assert.throws(
    () => buildSshConnectionCredentials({
      host: makeHost({ proxyProfileId: "missing-profile" }),
      hosts: [],
      keys: [],
      identities: [],
    }),
    /Saved proxy for host "Target" is missing/,
  );

  assert.throws(
    () => buildSshConnectionCredentials({
      host: makeHost({
        authMethod: "password",
        password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
      }),
      hosts: [],
      keys: [],
      identities: [],
    }),
    /Saved credentials cannot be decrypted on this device/,
  );

  const encryptedJump = makeHost({
    id: "jump-enc",
    label: "Encrypted Jump",
    authMethod: "password",
    password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
  });
  assert.throws(
    () => buildSshConnectionCredentials({
      host: makeHost({ hostChain: { hostIds: ["jump-enc"] } }),
      hosts: [encryptedJump],
      keys: [],
      identities: [],
    }),
    /Saved credentials for jump host "Encrypted Jump" cannot be decrypted on this device/,
  );
});
