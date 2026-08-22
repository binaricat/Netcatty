"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  isFidoSkAuthOptions,
  buildFidoAwareAgentPrepOptions,
  enhanceAuthOptionsForFido,
  shouldUseSoftwareCertificateAgent,
  resolvePreparedAgentSocket,
  looksLikeSkOpenSshMaterial,
  identityFilesLookLikeSk,
  materializeSkPrivateKeyFile,
} = require("./sshAuthHelper.cjs");

const SK_SSH_ED25519 = "sk-ssh-ed25519@openssh.com";
const SK_ECDSA_NISTP256 = "sk-ecdsa-sha2-nistp256@openssh.com";

const skPub =
  "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAABHNzaDo= test";

/** Real OpenSSH shape: algorithm only exists after base64 decode. */
function makeSkPrivatePem(algo) {
  const body = Buffer.from(`openssh-key-v1\0\0\0\0\0none\0\0\0\0\0\0\0\0\0\x01${algo}`).toString("base64");
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;
  assert.equal(pem.includes("@openssh.com"), false, "PEM must not contain plain sk type");
  return pem;
}

test("isFidoSkAuthOptions detects public and private sk material", () => {
  assert.equal(isFidoSkAuthOptions({ agentPublicKeys: [skPub] }), true);
  assert.equal(isFidoSkAuthOptions({
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nsk-ssh-ed25519@openssh.com\n-----END OPENSSH PRIVATE KEY-----",
  }), true);
  assert.equal(isFidoSkAuthOptions({ privateKey: "soft-key", useSshAgent: true }), false);
  assert.equal(looksLikeSkOpenSshMaterial(skPub), true);
});

test("looksLikeSkOpenSshMaterial detects base64-only sk private PEMs", () => {
  const pem = makeSkPrivatePem(SK_SSH_ED25519);
  assert.equal(looksLikeSkOpenSshMaterial(pem), true);
  assert.equal(isFidoSkAuthOptions({ privateKey: pem }), true);
  const soft = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
  assert.equal(looksLikeSkOpenSshMaterial(soft), false);
  assert.equal(isFidoSkAuthOptions({ privateKey: soft }), false);
});

test("materializeSkPrivateKeyFile writes base64-only sk PEM handles", async () => {
  const pem = makeSkPrivatePem(SK_ECDSA_NISTP256);
  const result = await materializeSkPrivateKeyFile(pem, {
    fs,
    os,
    path,
    tempDirBridge: { getTempDir: () => os.tmpdir() },
  });
  assert.ok(result?.keyPath, "expected materialized path for real SK PEM");
  const written = fs.readFileSync(result.keyPath, "utf8");
  assert.equal(written, pem);
  fs.rmSync(result.cleanupDir, { recursive: true, force: true });
});

test("buildFidoAwareAgentPrepOptions forces agent + askpass for base64-only SK PEMs", () => {
  const sender = { id: 1, isDestroyed: () => false };
  const pem = makeSkPrivatePem(SK_SSH_ED25519);
  const prep = buildFidoAwareAgentPrepOptions({
    useSshAgent: false,
    privateKey: pem,
  }, sender);
  assert.equal(prep.useSshAgent, true);
  assert.equal(prep.useFidoAgent, true);
  assert.equal(prep.loadIdentityFilesIntoAgent, true);
  assert.equal(prep.addKeysToAgent, "yes");
  assert.equal(typeof prep.resolveWebContents, "function");
  assert.equal(prep.resolveWebContents(), sender);
});

test("buildFidoAwareAgentPrepOptions leaves soft keys alone", () => {
  const prep = buildFidoAwareAgentPrepOptions({
    useSshAgent: false,
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
  });
  assert.equal(prep.useSshAgent, false);
  assert.equal(prep.useFidoAgent, false);
});

test("resolvePreparedAgentSocket prefers agent annotation", () => {
  assert.equal(
    resolvePreparedAgentSocket({ _netcattyAgentSocket: "/tmp/fido.sock" }),
    "/tmp/fido.sock",
  );
  assert.equal(resolvePreparedAgentSocket(null), null);
});

test("identityFilesLookLikeSk peeks .pub and private handle for path-only SK keys", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-sk-path-"));
  const keyPath = path.join(dir, "id_ed25519_sk");
  const pubPath = `${keyPath}.pub`;
  fs.writeFileSync(pubPath, skPub);
  fs.writeFileSync(keyPath, makeSkPrivatePem(SK_SSH_ED25519));
  try {
    assert.equal(await identityFilesLookLikeSk([keyPath]), true);
    assert.equal(await identityFilesLookLikeSk([pubPath]), true);
    assert.equal(await identityFilesLookLikeSk([path.join(dir, "missing")]), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("looksLikeSkOpenSshMaterial recognizes sk certificate public keys", () => {
  assert.equal(
    looksLikeSkOpenSshMaterial(
      "sk-ssh-ed25519-cert-v01@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAA user",
    ),
    true,
  );
});

test("prepareSystemSshAgentForAuth does not probe IdentityFiles for password auth", async () => {
  const { prepareSystemSshAgentForAuth } = require("./sshAuthHelper.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-sk-pw-"));
  const keyPath = path.join(dir, "id_ed25519_sk");
  fs.writeFileSync(`${keyPath}.pub`, skPub);
  try {
    const agent = await prepareSystemSshAgentForAuth({
      authMethod: "password",
      useSshAgent: false,
      identityFilePaths: [keyPath],
    }, "[test]");
    assert.equal(agent, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("enhanceAuthOptionsForFido forces agent for path-only IdentityFile SK keys", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-sk-enhance-"));
  const keyPath = path.join(dir, "id_ed25519_sk");
  fs.writeFileSync(`${keyPath}.pub`, skPub);
  try {
    const prep = await enhanceAuthOptionsForFido({
      useSshAgent: false,
      identityFilePaths: [keyPath],
    });
    assert.equal(prep.useSshAgent, true);
    assert.equal(prep.useFidoAgent, true);
    assert.equal(prep.loadIdentityFilesIntoAgent, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldUseSoftwareCertificateAgent is false for FIDO SK certificates", () => {
  assert.equal(
    shouldUseSoftwareCertificateAgent({ certificate: "sk-ssh-ed25519-cert-v01@openssh.com AAAA" }, true),
    false,
  );
  assert.equal(
    shouldUseSoftwareCertificateAgent({ certificate: "ssh-ed25519-cert-v01@openssh.com AAAA" }, false),
    true,
  );
});

test("materializeSkPrivateKeyFile stages companion certificate for ssh-add", async () => {
  const pem = makeSkPrivatePem(SK_SSH_ED25519);
  const cert = "sk-ssh-ed25519-cert-v01@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAA user";
  const result = await materializeSkPrivateKeyFile(pem, {
    fs,
    path,
    tempDirBridge: { getTempDir: () => os.tmpdir() },
    certificate: cert,
  });
  assert.ok(result?.keyPath);
  assert.equal(fs.readFileSync(`${result.keyPath}-cert.pub`, "utf8").trim(), cert);
  fs.rmSync(result.cleanupDir, { recursive: true, force: true });
});

test("materializeSkPrivateKeyFile fails closed without managed temp dir", async () => {
  const pem = makeSkPrivatePem(SK_SSH_ED25519);
  await assert.rejects(
    () => materializeSkPrivateKeyFile(pem, {
      fs,
      path,
      tempDirBridge: {},
    }),
    (error) => error?.code === "ERR_FIDO_TEMP_DIR_UNAVAILABLE",
  );
});

test("prepareSystemSshAgentForAuth releases FIDO resources when preparation throws", async () => {
  const fidoAgentManager = require("./fidoAgentManager.cjs");
  const fidoAskpass = require("./fidoAskpass.cjs");
  const originalAcquire = fidoAgentManager.acquireFidoAgent;
  const originalRelease = fidoAgentManager.releaseFidoAgent;
  const originalReleaseLease = fidoAskpass.releaseFidoAskpassLease;
  const leaseId = "test-lease-prep-fail";
  let releasedAgent = 0;
  let releasedLease = 0;

  fidoAgentManager.acquireFidoAgent = async () => ({
    socketPath: "/tmp/netcatty-fake-fido.sock",
    askpassEnv: {
      SSH_ASKPASS: "/bin/true",
      NETCATTY_FIDO_ASKPASS_LEASE: leaseId,
    },
    owned: true,
    generation: 1,
  });
  fidoAgentManager.releaseFidoAgent = () => { releasedAgent += 1; };
  fidoAskpass.releaseFidoAskpassLease = (id) => {
    if (id === leaseId) releasedLease += 1;
  };

  try {
    const { prepareSystemSshAgentForAuth } = require("./sshAuthHelper.cjs");
    await assert.rejects(
      () => prepareSystemSshAgentForAuth({
        useSshAgent: true,
        useFidoAgent: true,
        identitiesOnly: true,
        identityFilePaths: [],
      }, "[test]"),
      (error) => error?.code === "ERR_SSH_AGENT_IDENTITY_SELECTOR_UNAVAILABLE",
    );
    assert.equal(releasedAgent, 1);
    assert.equal(releasedLease, 1);
  } finally {
    fidoAgentManager.acquireFidoAgent = originalAcquire;
    fidoAgentManager.releaseFidoAgent = originalRelease;
    fidoAskpass.releaseFidoAskpassLease = originalReleaseLease;
  }
});

test("prepareSystemSshAgentForAuth removes newly loaded identities from a shared Windows agent on release", async () => {
  const fidoAgentManager = require("./fidoAgentManager.cjs");
  const fidoAskpass = require("./fidoAskpass.cjs");
  const systemSshAgent = require("./systemSshAgent.cjs");
  const childProcess = require("node:child_process");
  const originalAcquire = fidoAgentManager.acquireFidoAgent;
  const originalRelease = fidoAgentManager.releaseFidoAgent;
  const originalReleaseLease = fidoAskpass.releaseFidoAskpassLease;
  const originalPrepare = systemSshAgent.prepareSystemSshAgent;
  const originalExecFile = childProcess.execFile;
  const leaseId = "test-lease-shared-win";
  const identityPath = "/tmp/netcatty-shared-sk";
  const skPub =
    "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAABHNzaDo= test";
  const deleted = [];
  let releasedAgent = 0;

  fidoAgentManager.acquireFidoAgent = async () => ({
    socketPath: "\\\\.\\pipe\\openssh-ssh-agent",
    askpassEnv: {
      SSH_ASKPASS: "/bin/true",
      NETCATTY_FIDO_ASKPASS_LEASE: leaseId,
    },
    owned: false,
    generation: 7,
  });
  fidoAgentManager.releaseFidoAgent = (generation) => {
    assert.equal(generation, 7);
    releasedAgent += 1;
  };
  fidoAskpass.releaseFidoAskpassLease = () => {};
  systemSshAgent.prepareSystemSshAgent = async () => ({
    getIdentities: (cb) => cb(null, []),
    sign: (_k, _d, _o, cb) => cb(new Error("unused")),
    _netcattyNewlyLoadedIdentityPaths: [identityPath],
  });
  childProcess.execFile = (file, args, opts, cb) => {
    if (Array.isArray(args) && args[0] === "-d") {
      deleted.push(args[1]);
      if (typeof cb === "function") cb(null, "", "");
      return { kill() {} };
    }
    return originalExecFile(file, args, opts, cb);
  };

  try {
    systemSshAgent.resetSharedAgentIdentityRefsForTests?.();
    const { prepareSystemSshAgentForAuth } = require("./sshAuthHelper.cjs");
    const agent = await prepareSystemSshAgentForAuth({
      useSshAgent: true,
      useFidoAgent: true,
      agentPublicKeys: [skPub],
      loadIdentityFilesIntoAgent: true,
      identityFilePaths: [identityPath],
    }, "[test]");
    assert.ok(agent);
    assert.equal(typeof agent._releaseNetcattyFidoAgent, "function");
    agent._releaseNetcattyFidoAgent();
    assert.deepEqual(deleted, [identityPath]);
    assert.equal(releasedAgent, 1);
  } finally {
    fidoAgentManager.acquireFidoAgent = originalAcquire;
    fidoAgentManager.releaseFidoAgent = originalRelease;
    fidoAskpass.releaseFidoAskpassLease = originalReleaseLease;
    systemSshAgent.prepareSystemSshAgent = originalPrepare;
    childProcess.execFile = originalExecFile;
    systemSshAgent.resetSharedAgentIdentityRefsForTests?.();
  }
});

test("shared Windows agent defers ssh-add -d until the last identity user releases", async () => {
  const fidoAgentManager = require("./fidoAgentManager.cjs");
  const fidoAskpass = require("./fidoAskpass.cjs");
  const systemSshAgent = require("./systemSshAgent.cjs");
  const childProcess = require("node:child_process");
  const { publicKeyBlob } = systemSshAgent;
  const originalAcquire = fidoAgentManager.acquireFidoAgent;
  const originalRelease = fidoAgentManager.releaseFidoAgent;
  const originalReleaseLease = fidoAskpass.releaseFidoAskpassLease;
  const originalPrepare = systemSshAgent.prepareSystemSshAgent;
  const originalExecFile = childProcess.execFile;
  const skPub =
    "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAABHNzaDo= test";
  const blob = publicKeyBlob(skPub);
  const pathA = "/tmp/netcatty-shared-sk-a";
  const pathB = "/tmp/netcatty-shared-sk-b";
  const deleted = [];
  let generation = 0;

  fidoAgentManager.acquireFidoAgent = async () => {
    generation += 1;
    return {
      socketPath: "\\\\.\\pipe\\openssh-ssh-agent",
      askpassEnv: {
        SSH_ASKPASS: "/bin/true",
        NETCATTY_FIDO_ASKPASS_LEASE: `lease-${generation}`,
      },
      owned: false,
      generation,
    };
  };
  fidoAgentManager.releaseFidoAgent = () => {};
  fidoAskpass.releaseFidoAskpassLease = () => {};
  let prepCount = 0;
  systemSshAgent.prepareSystemSshAgent = async () => {
    prepCount += 1;
    const identityPath = prepCount === 1 ? pathA : pathB;
    return {
      getIdentities: (cb) => cb(null, []),
      sign: (_k, _d, _o, cb) => cb(new Error("unused")),
      _netcattyNewlyLoadedIdentityPaths: [identityPath],
      _netcattySharedAgentIdentities: [{ key: blob, identityPath }],
    };
  };
  childProcess.execFile = (file, args, opts, cb) => {
    if (Array.isArray(args) && args[0] === "-d") {
      deleted.push(args[1]);
      if (typeof cb === "function") cb(null, "", "");
      return { kill() {} };
    }
    return originalExecFile(file, args, opts, cb);
  };

  try {
    systemSshAgent.resetSharedAgentIdentityRefsForTests();
    const { prepareSystemSshAgentForAuth } = require("./sshAuthHelper.cjs");
    const agentA = await prepareSystemSshAgentForAuth({
      useSshAgent: true,
      useFidoAgent: true,
      agentPublicKeys: [skPub],
      loadIdentityFilesIntoAgent: true,
      identityFilePaths: [pathA],
    }, "[test-a]");
    const agentB = await prepareSystemSshAgentForAuth({
      useSshAgent: true,
      useFidoAgent: true,
      agentPublicKeys: [skPub],
      loadIdentityFilesIntoAgent: true,
      identityFilePaths: [pathB],
    }, "[test-b]");

    agentA._releaseNetcattyFidoAgent();
    assert.deepEqual(deleted, [], "first release must keep the shared identity loaded");
    agentB._releaseNetcattyFidoAgent();
    assert.deepEqual(deleted, [pathA], "last release removes the identity via the retained path");
  } finally {
    fidoAgentManager.acquireFidoAgent = originalAcquire;
    fidoAgentManager.releaseFidoAgent = originalRelease;
    fidoAskpass.releaseFidoAskpassLease = originalReleaseLease;
    systemSshAgent.prepareSystemSshAgent = originalPrepare;
    childProcess.execFile = originalExecFile;
    systemSshAgent.resetSharedAgentIdentityRefsForTests();
  }
});

test("shared Windows agent keeps staging dir until ssh-add -d finishes", async () => {
  const fidoAgentManager = require("./fidoAgentManager.cjs");
  const fidoAskpass = require("./fidoAskpass.cjs");
  const systemSshAgent = require("./systemSshAgent.cjs");
  const childProcess = require("node:child_process");
  const originalAcquire = fidoAgentManager.acquireFidoAgent;
  const originalRelease = fidoAgentManager.releaseFidoAgent;
  const originalReleaseLease = fidoAskpass.releaseFidoAskpassLease;
  const originalPrepare = systemSshAgent.prepareSystemSshAgent;
  const originalRetain = systemSshAgent.retainSharedAgentIdentity;
  const originalExecFile = childProcess.execFile;
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-sk-staging-"));
  const identityPath = path.join(stagingDir, "id_sk");
  fs.writeFileSync(identityPath, makeSkPrivatePem(SK_SSH_ED25519), { mode: 0o600 });
  /** @type {null | ((err: Error|null, stdout: string, stderr: string) => void)} */
  let pendingDeleteCb = null;

  fidoAgentManager.acquireFidoAgent = async () => ({
    socketPath: "\\\\.\\pipe\\openssh-ssh-agent",
    askpassEnv: {
      SSH_ASKPASS: "/bin/true",
      NETCATTY_FIDO_ASKPASS_LEASE: "test-lease-staging-cleanup",
    },
    owned: false,
    generation: 9,
  });
  fidoAgentManager.releaseFidoAgent = () => {};
  fidoAskpass.releaseFidoAskpassLease = () => {};
  // Prep is mocked (no real ssh-add); still attach staging cleanup the way
  // materializeSkPrivateKeyFile + retainSharedAgentIdentity would in production.
  systemSshAgent.retainSharedAgentIdentity = (key, idPath, cleanupDir) => (
    originalRetain(key, idPath, cleanupDir || stagingDir)
  );
  systemSshAgent.prepareSystemSshAgent = async () => ({
    getIdentities: (cb) => cb(null, []),
    sign: (_k, _d, _o, cb) => cb(new Error("unused")),
    _netcattyNewlyLoadedIdentityPaths: [identityPath],
  });
  childProcess.execFile = (file, args, opts, cb) => {
    if (Array.isArray(args) && args[0] === "-d") {
      pendingDeleteCb = typeof cb === "function" ? cb : null;
      return { kill() {} };
    }
    return originalExecFile(file, args, opts, cb);
  };

  try {
    systemSshAgent.resetSharedAgentIdentityRefsForTests?.();
    const { prepareSystemSshAgentForAuth } = require("./sshAuthHelper.cjs");
    const agent = await prepareSystemSshAgentForAuth({
      useSshAgent: true,
      useFidoAgent: true,
      agentPublicKeys: [skPub],
      loadIdentityFilesIntoAgent: true,
      identityFilePaths: [identityPath],
    }, "[test-staging-cleanup]");
    assert.ok(agent);
    assert.equal(typeof agent._releaseNetcattyFidoAgent, "function");

    agent._releaseNetcattyFidoAgent();
    assert.ok(pendingDeleteCb, "expected ssh-add -d to start");
    assert.equal(
      fs.existsSync(stagingDir),
      true,
      "staging must survive until ssh-add -d returns",
    );
    assert.equal(fs.existsSync(identityPath), true);
    pendingDeleteCb(null, "", "");
    for (let i = 0; i < 40 && fs.existsSync(stagingDir); i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(
      fs.existsSync(stagingDir),
      false,
      "staging removed after ssh-add -d completes",
    );
  } finally {
    fidoAgentManager.acquireFidoAgent = originalAcquire;
    fidoAgentManager.releaseFidoAgent = originalRelease;
    fidoAskpass.releaseFidoAskpassLease = originalReleaseLease;
    systemSshAgent.prepareSystemSshAgent = originalPrepare;
    systemSshAgent.retainSharedAgentIdentity = originalRetain;
    childProcess.execFile = originalExecFile;
    systemSshAgent.resetSharedAgentIdentityRefsForTests?.();
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
});

test("materializeSkPrivateKeyFile writes companion .pub from publicKey hint", async () => {
  const pem = makeSkPrivatePem(SK_SSH_ED25519);
  const result = await materializeSkPrivateKeyFile(pem, {
    fs,
    path,
    tempDirBridge: { getTempDir: () => os.tmpdir() },
    publicKey: skPub,
  });
  assert.ok(result?.keyPath);
  assert.equal(fs.readFileSync(`${result.keyPath}.pub`, "utf8").trim(), skPub.trim());
  fs.rmSync(result.cleanupDir, { recursive: true, force: true });
});
