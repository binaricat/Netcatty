import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSftpHostCredentials,
} from "./useSftpHostCredentials.ts";
import type { Host, Identity, KnownHost, SSHKey } from "../../../domain/models.ts";
import { resolvePasswordAuthSftpHost } from "../../../domain/authIdentityPicker.ts";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  username: "root",
  tags: [],
  os: "linux",
  ...overrides,
});

test("SFTP credentials follow the temporary deploy identity on a root profile", () => {
  const identities = [
    { id: "root-id", label: "root", username: "root", authMethod: "password", password: "bad-root", created: 0 },
    { id: "deploy-id", label: "deploy", username: "deploy", authMethod: "password", password: "good-deploy", created: 0 },
  ] as Identity[];
  const savedHost = host({ identityId: "root-id" });
  const sftpHost = resolvePasswordAuthSftpHost(savedHost, identities, {
    authMethod: "password", username: "deploy", password: "good-deploy", savedToHost: false,
  });
  const credentials = buildSftpHostCredentials({ host: sftpHost, hosts: [savedHost], keys: [], identities });
  assert.equal(credentials.username, "deploy");
  assert.equal(credentials.password, "good-deploy");
  assert.equal(credentials.hostId, savedHost.id);
  assert.equal(savedHost.identityId, "root-id");
});

test("buildSftpHostCredentials forwards system agent settings for target and jump hosts", () => {
  const jump = host({
    id: "jump-1",
    hostname: "jump.example.com",
    useSshAgent: true,
    identityFilePaths: ["~/.ssh/jump"],
    identitiesOnly: true,
  });
  const credentials = buildSftpHostCredentials({
    host: host({
      hostChain: { hostIds: ["jump-1"] },
      useSshAgent: true,
      identityAgent: "$SSH_AUTH_SOCK",
      identityFilePaths: ["~/.ssh/aws_root"],
      identitiesOnly: true,
      addKeysToAgent: "yes",
      useKeychain: true,
    }),
    hosts: [jump],
    keys: [],
    identities: [],
  });

  assert.deepEqual(
    {
      useSshAgent: credentials.useSshAgent,
      identityAgent: credentials.identityAgent,
      identityFilePaths: credentials.identityFilePaths,
      identitiesOnly: credentials.identitiesOnly,
      addKeysToAgent: credentials.addKeysToAgent,
      useKeychain: credentials.useKeychain,
    },
    {
      useSshAgent: true,
      identityAgent: "$SSH_AUTH_SOCK",
      identityFilePaths: ["~/.ssh/aws_root"],
      identitiesOnly: true,
      addKeysToAgent: "yes",
      useKeychain: true,
    },
  );
  assert.equal(credentials.jumpHosts?.[0]?.useSshAgent, true);
  assert.deepEqual(credentials.jumpHosts?.[0]?.identityFilePaths, ["~/.ssh/jump"]);
  assert.equal(credentials.jumpHosts?.[0]?.identitiesOnly, true);
});

test("buildSftpHostCredentials forwards target and jump-host timeouts", () => {
  const jumpHost = host({
    id: "jump-1",
    sshTcpConnectTimeoutSeconds: 75,
    sshAuthReadyTimeoutSeconds: 360,
  });
  const credentials = buildSftpHostCredentials({
    host: host({
      hostChain: { hostIds: ["jump-1"] },
      sshTcpConnectTimeoutSeconds: 45,
      sshAuthReadyTimeoutSeconds: 300,
    }),
    hosts: [jumpHost],
    keys: [],
    identities: [],
  });

  assert.equal(credentials.sshTcpConnectTimeoutMs, 45_000);
  assert.equal(credentials.sshAuthReadyTimeoutMs, 300_000);
  assert.equal(credentials.jumpHosts?.[0]?.sshTcpConnectTimeoutMs, 75_000);
  assert.equal(credentials.jumpHosts?.[0]?.sshAuthReadyTimeoutMs, 360_000);
});

test("buildSftpHostCredentials keeps automatic auth per target and jump host", () => {
  const jumpHost = host({ id: "jump-1", authMethod: "auto", password: "jump-secret", requiresMfa: true });
  const credentials = buildSftpHostCredentials({
    host: host({
      authMethod: "auto",
      password: "target-secret",
      requiresMfa: true,
      hostChain: { hostIds: ["jump-1"] },
    }),
    hosts: [jumpHost],
    keys: [],
    identities: [],
  });

  assert.equal(credentials.authMethod, "auto");
  assert.equal(credentials.requiresMfa, true);
  assert.equal(credentials.jumpHosts?.[0]?.authMethod, "auto");
  assert.equal(credentials.jumpHosts?.[0]?.requiresMfa, true);
});

test("buildSftpHostCredentials drops stale identity paths for password-only hosts", () => {
  const jumpHost = host({
    id: "jump-1",
    authMethod: "password",
    password: "jump-secret",
    useSshAgent: true,
    identityFilePaths: ["~/.ssh/stale-jump"],
  });
  const credentials = buildSftpHostCredentials({
    host: host({
      authMethod: "password",
      password: "target-secret",
      useSshAgent: true,
      identityFilePaths: ["~/.ssh/stale-target"],
      hostChain: { hostIds: ["jump-1"] },
    }),
    hosts: [jumpHost],
    keys: [],
    identities: [],
  });

  assert.equal(credentials.identityFilePaths, undefined);
  assert.equal(credentials.useSshAgent, false);
  assert.equal(credentials.jumpHosts?.[0]?.identityFilePaths, undefined);
  assert.equal(credentials.jumpHosts?.[0]?.useSshAgent, false);
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

test("buildSftpHostCredentials rejects missing proxy identities", () => {
  assert.throws(
    () => buildSftpHostCredentials({
      host: host({
        proxyConfig: {
          type: "http",
          host: "proxy.example.com",
          port: 3128,
          identityId: "missing-identity",
        },
      }),
      hosts: [],
      keys: [],
      identities: [],
    }),
    /Proxy identity for "Host" is missing/,
  );
});

test("buildSftpHostCredentials rejects incomplete proxy identities", () => {
  assert.throws(
    () => buildSftpHostCredentials({
      host: host({
        proxyConfig: {
          type: "http",
          host: "proxy.example.com",
          port: 3128,
          identityId: "identity-1",
        },
      }),
      hosts: [],
      keys: [],
      identities: [{
        id: "identity-1",
        label: "Proxy login",
        username: "proxy-user",
        authMethod: "password",
        created: 1,
      }],
    }),
    /Proxy identity for "Host" is incomplete/,
  );
});

test("buildSftpHostCredentials rejects proxy identities with blank usernames even when passwords are encrypted", () => {
  assert.throws(
    () => buildSftpHostCredentials({
      host: host({
        proxyConfig: {
          type: "http",
          host: "proxy.example.com",
          port: 3128,
          identityId: "identity-1",
        },
      }),
      hosts: [],
      keys: [],
      identities: [{
        id: "identity-1",
        label: "Proxy login",
        username: " ",
        authMethod: "password",
        password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
        created: 1,
      }],
    }),
    /Proxy identity for "Host" is incomplete/,
  );
});

test("buildSftpHostCredentials rejects missing proxy identities on jump hosts", () => {
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyConfig: {
      type: "http",
      host: "proxy.example.com",
      port: 3128,
      identityId: "missing-identity",
    },
  });

  assert.throws(
    () => buildSftpHostCredentials({
      host: host({ hostChain: { hostIds: ["jump-1"] } }),
      hosts: [jumpHost],
      keys: [],
      identities: [],
    }),
    /Proxy identity for "Jump" is missing/,
  );
});

test("buildSftpHostCredentials rejects incomplete proxy identities on jump hosts", () => {
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyConfig: {
      type: "http",
      host: "proxy.example.com",
      port: 3128,
      identityId: "identity-1",
    },
  });

  assert.throws(
    () => buildSftpHostCredentials({
      host: host({ hostChain: { hostIds: ["jump-1"] } }),
      hosts: [jumpHost],
      keys: [],
      identities: [{
        id: "identity-1",
        label: "Proxy login",
        username: "",
        authMethod: "password",
        password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
        created: 1,
      }],
    }),
    /Proxy identity for "Jump" is incomplete/,
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

test("buildSftpHostCredentials resolves proxy credentials from a selected identity", () => {
  const identity: Identity = {
    id: "identity-1",
    label: "Proxy login",
    username: "proxy-user",
    authMethod: "password",
    password: "proxy-secret",
    created: 1,
  };
  const credentials = buildSftpHostCredentials({
    host: host({
      proxyConfig: {
        type: "socks5",
        host: "proxy.example.com",
        port: 1080,
        identityId: identity.id,
      },
    }),
    hosts: [],
    keys: [],
    identities: [identity],
  });

  assert.deepEqual(credentials.proxy, {
    type: "socks5",
    host: "proxy.example.com",
    port: 1080,
    username: "proxy-user",
    password: "proxy-secret",
  });
});

test("buildSftpHostCredentials rejects undecryptable proxy identity passwords", () => {
  assert.throws(
    () => buildSftpHostCredentials({
      host: host({
        proxyConfig: {
          type: "http",
          host: "proxy.example.com",
          port: 3128,
          identityId: "identity-1",
        },
      }),
      hosts: [],
      keys: [],
      identities: [{
        id: "identity-1",
        label: "Proxy login",
        username: "proxy-user",
        authMethod: "password",
        password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
        created: 1,
      }],
    }),
    /Proxy credentials cannot be decrypted/,
  );
});

test("buildSftpHostCredentials resolves jump host proxy credentials from a selected identity", () => {
  const identity: Identity = {
    id: "identity-1",
    label: "Proxy login",
    username: "proxy-user",
    authMethod: "password",
    password: "proxy-secret",
    created: 1,
  };
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyConfig: {
      type: "socks5",
      host: "jump-proxy.example.com",
      port: 1080,
      identityId: identity.id,
    },
  });

  const credentials = buildSftpHostCredentials({
    host: host({ hostChain: { hostIds: ["jump-1"] } }),
    hosts: [jumpHost],
    keys: [],
    identities: [identity],
  });

  assert.deepEqual(credentials.jumpHosts?.[0]?.proxy, {
    type: "socks5",
    host: "jump-proxy.example.com",
    port: 1080,
    username: "proxy-user",
    password: "proxy-secret",
  });
});

test("buildSftpHostCredentials rejects undecryptable jump host proxy identity passwords", () => {
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyConfig: {
      type: "http",
      host: "proxy.example.com",
      port: 3128,
      identityId: "identity-1",
    },
  });

  assert.throws(
    () => buildSftpHostCredentials({
      host: host({ hostChain: { hostIds: ["jump-1"] } }),
      hosts: [jumpHost],
      keys: [],
      identities: [{
        id: "identity-1",
        label: "Proxy login",
        username: "proxy-user",
        authMethod: "password",
        password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
        created: 1,
      }],
    }),
    /Proxy credentials for jump host "Jump" cannot be decrypted/,
  );
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

test("buildSftpHostCredentials forwards the host-key verification setting", () => {
  const credentials = buildSftpHostCredentials({
    host: host(),
    hosts: [],
    keys: [],
    identities: [],
    terminalSettings: {
      verifyHostKeys: false,
      keepaliveInterval: 30,
      keepaliveCountMax: 10,
    },
  });

  assert.equal(credentials.verifyHostKeys, false);
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
        password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
      }),
      hosts: [],
      keys: [],
      identities: [],
    }),
    /Saved credentials cannot be decrypted/,
  );
});

test("buildSftpHostCredentials keeps automatic target discovery available with an unreadable saved password", () => {
  const credentials = buildSftpHostCredentials({
    host: host({
      authMethod: "auto",
      password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
    }),
    hosts: [],
    keys: [],
    identities: [],
  });

  assert.equal(credentials.authMethod, "auto");
  assert.equal(credentials.password, undefined);
});

test("buildSftpHostCredentials keeps automatic jump discovery available with an unreadable saved password", () => {
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    authMethod: "auto",
    password: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
  });
  const credentials = buildSftpHostCredentials({
    host: host({ hostChain: { hostIds: ["jump-1"] } }),
    hosts: [jumpHost],
    keys: [],
    identities: [],
  });

  assert.equal(credentials.jumpHosts?.[0]?.authMethod, "auto");
  assert.equal(credentials.jumpHosts?.[0]?.password, undefined);
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
    privateKey: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
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
    privateKey: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
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

test("buildSftpHostCredentials uses the system agent when a synced key cannot be decrypted", () => {
  const key: SSHKey = {
    id: "key-1",
    label: "Synced key",
    type: "ED25519",
    publicKey: "ssh-ed25519 AAAASELECTED",
    privateKey: "enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==",
    source: "imported",
    category: "key",
    created: 1,
  };

  const credentials = buildSftpHostCredentials({
    host: host({
      authMethod: "key",
      identityFileId: "key-1",
      useSshAgent: true,
    }),
    hosts: [],
    keys: [key],
    identities: [],
  });

  assert.equal(credentials.useSshAgent, true);
  assert.deepEqual(credentials.agentPublicKeys, ["ssh-ed25519 AAAASELECTED"]);
  assert.equal(credentials.privateKey, undefined);
});

test("imported IdentityFile paths remain usable when agent login is disabled", () => {
  const credentials = buildSftpHostCredentials({
    host: host({
      identityFilePaths: ["~/.ssh/id_work"],
      useSshAgent: false,
      identityAgent: "none",
    }),
    hosts: [],
    keys: [],
    identities: [],
  });

  assert.equal(credentials.useSshAgent, false);
  assert.deepEqual(credentials.identityFilePaths, ["~/.ssh/id_work"]);
});
