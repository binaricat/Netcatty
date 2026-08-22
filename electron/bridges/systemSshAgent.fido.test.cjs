"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldLoadIdentityFileIntoAgent,
  publicKeyBlob,
} = require("./systemSshAgent.cjs");
const { parseKey } = require("ssh2/lib/protocol/keyParser.js");

const SK_SSH_ED25519 = "sk-ssh-ed25519@openssh.com";

function makeSkPrivatePem() {
  const body = Buffer.from(`openssh-key-v1\0\0\0\0\0none\0\0\0\0\0\0\0\0\0\x01${SK_SSH_ED25519}`).toString("base64");
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;
  assert.equal(pem.includes("@openssh.com"), false);
  return pem;
}

test("shouldLoadIdentityFileIntoAgent loads sk public keys", async () => {
  const type = Buffer.from("sk-ssh-ed25519@openssh.com");
  const pub = Buffer.alloc(32, 3);
  const app = Buffer.from("ssh:");
  const parts = [type, pub, app];
  let len = 0;
  for (const part of parts) len += 4 + part.length;
  const buf = Buffer.alloc(len);
  let offset = 0;
  for (const part of parts) {
    buf.writeUInt32BE(part.length, offset);
    offset += 4;
    part.copy(buf, offset);
    offset += part.length;
  }
  const pubLine = `sk-ssh-ed25519@openssh.com ${buf.toString("base64")} test`;

  const files = {
    "/tmp/id_ed25519_sk.pub": pubLine,
  };
  const deps = {
    readFile: async (p) => {
      if (files[p] !== undefined) return files[p];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };

  assert.equal(
    await shouldLoadIdentityFileIntoAgent("/tmp/id_ed25519_sk", {}, deps),
    true,
  );
  assert.equal(
    await shouldLoadIdentityFileIntoAgent("/tmp/id_ed25519_sk", { addKeysToAgent: "yes" }, deps),
    true,
  );
  assert.equal(
    await shouldLoadIdentityFileIntoAgent(
      "/tmp/soft",
      {},
      {
        readFile: async () => "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJust soft",
      },
    ),
    false,
  );

  const parsed = parseKey(pubLine);
  assert.equal(parsed instanceof Error, false);
  assert.ok(publicKeyBlob(parsed));
});

test("shouldLoadIdentityFileIntoAgent detects base64-only sk private PEMs", async () => {
  const pem = makeSkPrivatePem();
  const deps = {
    readFile: async (p) => {
      if (p === "/tmp/id_ed25519_sk" || p.endsWith("/id_ed25519_sk")) return pem;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };
  assert.equal(
    await shouldLoadIdentityFileIntoAgent("/tmp/id_ed25519_sk", {}, deps),
    true,
  );
});

test("prepareSystemSshAgent tracks newly loaded identities for shared-agent cleanup", async () => {
  const { prepareSystemSshAgent } = require("./systemSshAgent.cjs");
  const type = Buffer.from("sk-ssh-ed25519@openssh.com");
  const pub = Buffer.alloc(32, 3);
  const app = Buffer.from("ssh:");
  const parts = [type, pub, app];
  let len = 0;
  for (const part of parts) len += 4 + part.length;
  const buf = Buffer.alloc(len);
  let offset = 0;
  for (const part of parts) {
    buf.writeUInt32BE(part.length, offset);
    offset += 4;
    part.copy(buf, offset);
    offset += part.length;
  }
  const pubLine = `sk-ssh-ed25519@openssh.com ${buf.toString("base64")} test`;
  const identityPath = "/tmp/id_ed25519_sk_new";
  const sshAddCalls = [];

  const fakeAgent = {
    getIdentities: (cb) => cb(null, []),
    sign: (_key, _data, _opts, cb) => cb(new Error("unused")),
  };

  const prepared = await prepareSystemSshAgent({
    socketPath: "/tmp/fake-agent.sock",
    identityFilePaths: [identityPath],
    loadIdentityFilesIntoAgent: true,
  }, {
    createAgent: () => fakeAgent,
    readFile: async (p) => {
      if (p === `${identityPath}.pub`) return pubLine;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    runSshAdd: async (args) => { sshAddCalls.push(args); },
    platform: "win32",
  });

  assert.deepEqual(sshAddCalls, [[identityPath]]);
  assert.deepEqual(prepared._netcattyNewlyLoadedIdentityPaths, [identityPath]);
  assert.deepEqual(prepared._netcattySharedAgentIdentities, [
    { key: publicKeyBlob(pubLine), identityPath },
  ]);
});

test("prepareSystemSshAgent does not adopt pre-existing agent identities for cleanup", async () => {
  const {
    prepareSystemSshAgent,
    publicKeyBlob,
    resetSharedAgentIdentityRefsForTests,
  } = require("./systemSshAgent.cjs");
  resetSharedAgentIdentityRefsForTests();
  const type = Buffer.from("sk-ssh-ed25519@openssh.com");
  const pub = Buffer.alloc(32, 7);
  const app = Buffer.from("ssh:");
  const parts = [type, pub, app];
  let len = 0;
  for (const part of parts) len += 4 + part.length;
  const buf = Buffer.alloc(len);
  let offset = 0;
  for (const part of parts) {
    buf.writeUInt32BE(part.length, offset);
    offset += 4;
    part.copy(buf, offset);
    offset += part.length;
  }
  const pubLine = `sk-ssh-ed25519@openssh.com ${buf.toString("base64")} test`;
  const identityPath = "/tmp/id_ed25519_sk_existing";
  const blob = publicKeyBlob(pubLine);
  const sshAddCalls = [];

  const fakeKey = {
    getPublicSSH: () => Buffer.from(blob, "base64"),
  };
  const fakeAgent = {
    getIdentities: (cb) => cb(null, [fakeKey]),
    sign: (_key, _data, _opts, cb) => cb(new Error("unused")),
  };

  try {
    const prepared = await prepareSystemSshAgent({
      socketPath: "/tmp/fake-agent.sock",
      identityFilePaths: [identityPath],
      loadIdentityFilesIntoAgent: true,
    }, {
      createAgent: () => fakeAgent,
      readFile: async (p) => {
        if (p === `${identityPath}.pub`) return pubLine;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      runSshAdd: async (args) => { sshAddCalls.push(args); },
      platform: "win32",
    });

    assert.deepEqual(sshAddCalls, []);
    assert.equal(prepared._netcattyNewlyLoadedIdentityPaths, undefined);
    assert.equal(prepared._netcattySharedAgentIdentities, undefined);
  } finally {
    resetSharedAgentIdentityRefsForTests();
  }
});

test("prepareSystemSshAgent ssh-adds when bare identity is loaded but companion certificate is missing", async () => {
  const {
    prepareSystemSshAgent,
    publicKeyBlob,
    retainSharedAgentIdentity,
    resetSharedAgentIdentityRefsForTests,
  } = require("./systemSshAgent.cjs");
  resetSharedAgentIdentityRefsForTests();

  const type = Buffer.from("sk-ssh-ed25519@openssh.com");
  const pub = Buffer.alloc(32, 11);
  const app = Buffer.from("ssh:");
  const parts = [type, pub, app];
  let len = 0;
  for (const part of parts) len += 4 + part.length;
  const buf = Buffer.alloc(len);
  let offset = 0;
  for (const part of parts) {
    buf.writeUInt32BE(part.length, offset);
    offset += 4;
    part.copy(buf, offset);
    offset += part.length;
  }
  const pubLine = `sk-ssh-ed25519@openssh.com ${buf.toString("base64")} test`;

  const certType = Buffer.from("sk-ssh-ed25519-cert-v01@openssh.com");
  const nonce = Buffer.alloc(16, 3);
  const certParts = [certType, nonce, pub, app];
  let certLen = 0;
  for (const part of certParts) certLen += 4 + part.length;
  const certBuf = Buffer.alloc(certLen);
  let certOffset = 0;
  for (const part of certParts) {
    certBuf.writeUInt32BE(part.length, certOffset);
    certOffset += 4;
    part.copy(certBuf, certOffset);
    certOffset += part.length;
  }
  const certLine = `sk-ssh-ed25519-cert-v01@openssh.com ${certBuf.toString("base64")} cert`;

  const identityPath = "/tmp/id_ed25519_sk_cert_reload";
  const certPath = `${identityPath}-cert.pub`;
  const blob = publicKeyBlob(pubLine);
  const certBlob = publicKeyBlob(certLine);
  assert.ok(blob);
  assert.ok(certBlob);
  assert.notEqual(blob, certBlob);

  const sshAddCalls = [];
  const fakeKey = {
    getPublicSSH: () => Buffer.from(blob, "base64"),
  };
  const fakeAgent = {
    getIdentities: (cb) => cb(null, [fakeKey]),
    sign: (_key, _data, _opts, cb) => cb(new Error("unused")),
  };

  try {
    retainSharedAgentIdentity(blob, "/tmp/id_ed25519_sk_first");
    const prepared = await prepareSystemSshAgent({
      socketPath: "/tmp/fake-agent.sock",
      identityFilePaths: [identityPath],
      loadIdentityFilesIntoAgent: true,
    }, {
      createAgent: () => fakeAgent,
      readFile: async (p) => {
        if (p === `${identityPath}.pub`) return pubLine;
        if (p === certPath) return certLine;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      runSshAdd: async (args) => { sshAddCalls.push(args); },
      platform: "win32",
    });

    assert.deepEqual(sshAddCalls, [[identityPath]]);
    // Bare key was already Netcatty-owned; join that refcount (do not treat
    // the cert-only reload as a newly loaded private identity).
    assert.equal(prepared._netcattyNewlyLoadedIdentityPaths, undefined);
    assert.deepEqual(prepared._netcattySharedAgentIdentities, [
      { key: blob, identityPath },
    ]);
  } finally {
    resetSharedAgentIdentityRefsForTests();
  }
});

test("prepareSystemSshAgent tracks companion cert added beside a pre-existing user bare key", async () => {
  const {
    prepareSystemSshAgent,
    publicKeyBlob,
    resetSharedAgentIdentityRefsForTests,
  } = require("./systemSshAgent.cjs");
  resetSharedAgentIdentityRefsForTests();

  const type = Buffer.from("sk-ssh-ed25519@openssh.com");
  const pub = Buffer.alloc(32, 13);
  const app = Buffer.from("ssh:");
  const parts = [type, pub, app];
  let len = 0;
  for (const part of parts) len += 4 + part.length;
  const buf = Buffer.alloc(len);
  let offset = 0;
  for (const part of parts) {
    buf.writeUInt32BE(part.length, offset);
    offset += 4;
    part.copy(buf, offset);
    offset += part.length;
  }
  const pubLine = `sk-ssh-ed25519@openssh.com ${buf.toString("base64")} test`;

  const certType = Buffer.from("sk-ssh-ed25519-cert-v01@openssh.com");
  const nonce = Buffer.alloc(16, 5);
  const certParts = [certType, nonce, pub, app];
  let certLen = 0;
  for (const part of certParts) certLen += 4 + part.length;
  const certBuf = Buffer.alloc(certLen);
  let certOffset = 0;
  for (const part of certParts) {
    certBuf.writeUInt32BE(part.length, certOffset);
    certOffset += 4;
    part.copy(certBuf, certOffset);
    certOffset += part.length;
  }
  const certLine = `sk-ssh-ed25519-cert-v01@openssh.com ${certBuf.toString("base64")} cert`;

  const identityPath = "/tmp/id_ed25519_sk_user_bare";
  const certPath = `${identityPath}-cert.pub`;
  const blob = publicKeyBlob(pubLine);
  const certBlob = publicKeyBlob(certLine);
  assert.ok(blob);
  assert.ok(certBlob);

  const sshAddCalls = [];
  const fakeKey = {
    getPublicSSH: () => Buffer.from(blob, "base64"),
  };
  const fakeAgent = {
    getIdentities: (cb) => cb(null, [fakeKey]),
    sign: (_key, _data, _opts, cb) => cb(new Error("unused")),
  };

  try {
    const prepared = await prepareSystemSshAgent({
      socketPath: "/tmp/fake-agent.sock",
      identityFilePaths: [identityPath],
      loadIdentityFilesIntoAgent: true,
    }, {
      createAgent: () => fakeAgent,
      readFile: async (p) => {
        if (p === `${identityPath}.pub`) return pubLine;
        if (p === certPath) return certLine;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      runSshAdd: async (args) => { sshAddCalls.push(args); },
      platform: "win32",
    });

    assert.deepEqual(sshAddCalls, [[identityPath]]);
    // Do not adopt the user's bare identity; track only the certificate we added.
    assert.deepEqual(prepared._netcattyNewlyLoadedIdentityPaths, [certPath]);
    assert.deepEqual(prepared._netcattySharedAgentIdentities, [
      { key: certBlob, identityPath: certPath },
    ]);
  } finally {
    resetSharedAgentIdentityRefsForTests();
  }
});

test("prepareSystemSshAgent joins Netcatty-owned already-loaded identities for shared cleanup", async () => {
  const {
    prepareSystemSshAgent,
    publicKeyBlob,
    retainSharedAgentIdentity,
    resetSharedAgentIdentityRefsForTests,
  } = require("./systemSshAgent.cjs");
  resetSharedAgentIdentityRefsForTests();
  const type = Buffer.from("sk-ssh-ed25519@openssh.com");
  const pub = Buffer.alloc(32, 9);
  const app = Buffer.from("ssh:");
  const parts = [type, pub, app];
  let len = 0;
  for (const part of parts) len += 4 + part.length;
  const buf = Buffer.alloc(len);
  let offset = 0;
  for (const part of parts) {
    buf.writeUInt32BE(part.length, offset);
    offset += 4;
    part.copy(buf, offset);
    offset += part.length;
  }
  const pubLine = `sk-ssh-ed25519@openssh.com ${buf.toString("base64")} test`;
  const identityPath = "/tmp/id_ed25519_sk_owned";
  const blob = publicKeyBlob(pubLine);
  const fakeKey = {
    getPublicSSH: () => Buffer.from(blob, "base64"),
  };
  const fakeAgent = {
    getIdentities: (cb) => cb(null, [fakeKey]),
    sign: (_key, _data, _opts, cb) => cb(new Error("unused")),
  };

  try {
    retainSharedAgentIdentity(blob, "/tmp/id_ed25519_sk_first");
    const prepared = await prepareSystemSshAgent({
      socketPath: "/tmp/fake-agent.sock",
      identityFilePaths: [identityPath],
      loadIdentityFilesIntoAgent: true,
    }, {
      createAgent: () => fakeAgent,
      readFile: async (p) => {
        if (p === `${identityPath}.pub`) return pubLine;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      runSshAdd: async () => {
        throw new Error("ssh-add must not run for already-loaded owned identity");
      },
      platform: "win32",
    });

    assert.equal(prepared._netcattyNewlyLoadedIdentityPaths, undefined);
    assert.deepEqual(prepared._netcattySharedAgentIdentities, [
      { key: blob, identityPath },
    ]);
  } finally {
    resetSharedAgentIdentityRefsForTests();
  }
});

test("retainSharedAgentIdentity reference-counts identical public identities", () => {
  const {
    retainSharedAgentIdentity,
    releaseSharedAgentIdentity,
    resetSharedAgentIdentityRefsForTests,
  } = require("./systemSshAgent.cjs");
  resetSharedAgentIdentityRefsForTests();
  try {
    const first = retainSharedAgentIdentity("blob-1", "/tmp/a");
    const second = retainSharedAgentIdentity("blob-1", "/tmp/b");
    assert.equal(first?.acceptedCleanup, false);
    assert.equal(second?.acceptedCleanup, false);
    assert.deepEqual(releaseSharedAgentIdentity("blob-1"), {
      shouldRemove: false,
      identityPath: "/tmp/a",
      cleanupDir: null,
    });
    assert.deepEqual(releaseSharedAgentIdentity("blob-1"), {
      shouldRemove: true,
      identityPath: "/tmp/a",
      cleanupDir: null,
    });
  } finally {
    resetSharedAgentIdentityRefsForTests();
  }
});

test("retainSharedAgentIdentity adopts cleanupDir only on the first retainer", () => {
  const {
    retainSharedAgentIdentity,
    releaseSharedAgentIdentity,
    resetSharedAgentIdentityRefsForTests,
  } = require("./systemSshAgent.cjs");
  resetSharedAgentIdentityRefsForTests();
  try {
    const first = retainSharedAgentIdentity("blob-1", "/tmp/a/key", "/tmp/a");
    const second = retainSharedAgentIdentity("blob-1", "/tmp/b/key", "/tmp/b");
    assert.equal(first?.acceptedCleanup, true);
    assert.equal(first?.entry.cleanupDir, "/tmp/a");
    assert.equal(second?.acceptedCleanup, false);
    assert.equal(second?.entry.cleanupDir, "/tmp/a");
    assert.deepEqual(releaseSharedAgentIdentity("blob-1"), {
      shouldRemove: false,
      identityPath: "/tmp/a/key",
      cleanupDir: "/tmp/a",
    });
    assert.deepEqual(releaseSharedAgentIdentity("blob-1"), {
      shouldRemove: true,
      identityPath: "/tmp/a/key",
      cleanupDir: "/tmp/a",
    });
  } finally {
    resetSharedAgentIdentityRefsForTests();
  }
});
