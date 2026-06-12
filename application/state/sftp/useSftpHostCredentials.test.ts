import test from "node:test";
import assert from "node:assert/strict";

import { buildSftpHostCredentials } from "./useSftpHostCredentials.ts";
import type { Host, KnownHost, SSHKey } from "../../../domain/models.ts";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  username: "root",
  tags: [],
  os: "linux",
  ...overrides,
});

test("buildSftpHostCredentials rejects missing jump hosts", () => {
  assert.throws(
    () => buildSftpHostCredentials({
      host: host({ hostChain: { hostIds: ["missing-jump"] } }),
      hosts: [],
      keys: [],
      identities: [],
    }),
    /Jump host "missing-jump" is missing/,
  );
});

test("buildSftpHostCredentials rejects missing saved proxy profiles", () => {
  assert.throws(
    () => buildSftpHostCredentials({
      host: host({ proxyProfileId: "missing-proxy" }),
      hosts: [],
      keys: [],
      identities: [],
    }),
    /Saved proxy for host "Host" is missing/,
  );
});

test("buildSftpHostCredentials rejects missing saved proxy profiles on jump hosts", () => {
  const jumpHost = host({ id: "jump-1", label: "Jump", proxyProfileId: "missing-proxy" });

  assert.throws(
    () => buildSftpHostCredentials({
      host: host({ hostChain: { hostIds: ["jump-1"] } }),
      hosts: [jumpHost],
      keys: [],
      identities: [],
    }),
    /Saved proxy for jump host "Jump" is missing/,
  );
});

test("buildSftpHostCredentials forwards custom ProxyCommand settings", () => {
  const credentials = buildSftpHostCredentials({
    host: host({
      proxyConfig: {
        type: "command",
        host: "",
        port: 0,
        command: "cloudflared access ssh --hostname %h",
      },
    }),
    hosts: [],
    keys: [],
    identities: [],
  });

  assert.deepEqual(credentials.proxy, {
    type: "command",
    host: "",
    port: 0,
    command: "cloudflared access ssh --hostname %h",
    username: undefined,
    password: undefined,
  });
});

test("buildSftpHostCredentials passes reference keys as identity file paths", () => {
  const key: SSHKey = {
    id: "key-1",
    label: "Reference key",
    type: "ED25519",
    privateKey: "",
    source: "reference",
    category: "key",
    created: 1,
    filePath: "/Users/alice/.ssh/id_ed25519",
    passphrase: "saved-passphrase",
  };

  const credentials = buildSftpHostCredentials({
    host: host({ authMethod: "key", identityFileId: "key-1" }),
    hosts: [],
    keys: [key],
    identities: [],
  });

  assert.equal(credentials.privateKey, undefined);
  assert.deepEqual(credentials.identityFilePaths, ["/Users/alice/.ssh/id_ed25519"]);
  assert.equal(credentials.passphrase, "saved-passphrase");
});

test("buildSftpHostCredentials forwards known hosts for SFTP host-key checks", () => {
  const knownHosts: KnownHost[] = [{
    id: "kh-1",
    hostname: "example.com",
    port: 22,
    keyType: "ssh-ed25519",
    publicKey: "SHA256:abc",
    fingerprint: "abc",
    discoveredAt: 1,
  }];

  const credentials = buildSftpHostCredentials({
    host: host(),
    hosts: [],
    keys: [],
    identities: [],
    knownHosts,
  });

  assert.equal(credentials.knownHosts, knownHosts);
});

test("buildSftpHostCredentials passes jump host reference keys as identity file paths", () => {
  const key: SSHKey = {
    id: "jump-key",
    label: "Jump key",
    type: "ED25519",
    privateKey: "",
    source: "reference",
    category: "key",
    created: 1,
    filePath: "/Users/alice/.ssh/jump_ed25519",
  };
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    authMethod: "key",
    identityFileId: "jump-key",
  });

  const credentials = buildSftpHostCredentials({
    host: host({ hostChain: { hostIds: ["jump-1"] } }),
    hosts: [jumpHost],
    keys: [key],
    identities: [],
  });

  assert.equal(credentials.jumpHosts?.[0]?.privateKey, undefined);
  assert.deepEqual(credentials.jumpHosts?.[0]?.identityFilePaths, ["/Users/alice/.ssh/jump_ed25519"]);
});

test("buildSftpHostCredentials rejects undecryptable saved password credentials", () => {
  assert.throws(
    () => buildSftpHostCredentials({
      host: host({
        authMethod: "password",
        password: "enc:v1:djEwAAAA",
      }),
      hosts: [],
      keys: [],
      identities: [],
    }),
    /Saved credentials cannot be decrypted/,
  );
});

test("buildSftpHostCredentials omits local key file paths for password auth", () => {
  const credentials = buildSftpHostCredentials({
    host: host({
      authMethod: "password",
      password: "secret",
      identityFilePaths: ["/Users/alice/.ssh/id_ed25519"],
    }),
    hosts: [],
    keys: [],
    identities: [],
  });

  assert.equal(credentials.password, "secret");
  assert.equal(credentials.privateKey, undefined);
  assert.equal(credentials.identityFilePaths, undefined);
});

test("buildSftpHostCredentials rejects undecryptable saved key material without fallback credentials", () => {
  const key: SSHKey = {
    id: "key-1",
    label: "Imported key",
    type: "ED25519",
    privateKey: "enc:v1:djEwAAAA",
    source: "imported",
    category: "key",
    created: 1,
  };

  assert.throws(
    () => buildSftpHostCredentials({
      host: host({ authMethod: "key", identityFileId: "key-1" }),
      hosts: [],
      keys: [key],
      identities: [],
    }),
    /Saved credentials cannot be decrypted/,
  );
});

test("buildSftpHostCredentials does not use stale local key paths when a selected key is unavailable", () => {
  const key: SSHKey = {
    id: "key-1",
    label: "Imported key",
    type: "ED25519",
    privateKey: "enc:v1:djEwAAAA",
    source: "imported",
    category: "key",
    created: 1,
  };

  assert.throws(
    () => buildSftpHostCredentials({
      host: host({
        authMethod: "key",
        identityFileId: "key-1",
        identityFilePaths: ["/Users/alice/.ssh/stale_ed25519"],
      }),
      hosts: [],
      keys: [key],
      identities: [],
    }),
    /Saved credentials cannot be decrypted/,
  );
});
