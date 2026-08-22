const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const {
  addBundledMoshRuntimeEnv,
  resolveBareMoshClient,
} = require("./terminalBridge.cjs");
const { createMoshSessionApi } = require("./terminalBridge/moshSession.cjs");

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mosh-resolve-"));
}

function writeExecutable(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(filePath, 0o755);
}

test("resolveBareMoshClient ignores explicit local mosh-client paths", () => {
  const tmp = makeTmp();
  const p = path.join(tmp, "mosh-client");
  writeExecutable(p);
  assert.equal(resolveBareMoshClient({ moshClientPath: p }, { projectRoot: tmp, resourcesPath: path.join(tmp, "missing") }), null);
});

test("resolveBareMoshClient resolves only the bundled client", () => {
  const tmp = makeTmp();
  const bundled = path.join(tmp, "resources", "mosh", "linux-x64", "mosh-client");
  writeExecutable(bundled);

  assert.equal(
    resolveBareMoshClient({}, {
      platform: "linux",
      arch: "x64",
      projectRoot: tmp,
      resourcesPath: path.join(tmp, "missing"),
    }),
    bundled,
  );
});

test("resolveBareMoshClient rejects relative explicit paths", () => {
  const tmp = makeTmp();
  const got = resolveBareMoshClient({ moshClientPath: "./mosh-client" }, {
    projectRoot: tmp,
    resourcesPath: path.join(tmp, "missing"),
  });
  assert.equal(got, null);
});

test("resolveBareMoshClient ignores a non-executable explicit path", () => {
  const tmp = makeTmp();
  const p = path.join(tmp, "mosh-client");
  fs.writeFileSync(p, "");
  fs.chmodSync(p, 0o644);
  const got = resolveBareMoshClient({ moshClientPath: p }, {
    projectRoot: tmp,
    resourcesPath: path.join(tmp, "missing"),
  });
  assert.equal(got, null);
});

test("resolveBareMoshClient ignores mosh-client on PATH", () => {
  const tmp = makeTmp();
  const p = path.join(tmp, "mosh-client");
  writeExecutable(p);

  assert.equal(resolveBareMoshClient({}, {
    pathOverride: tmp,
    projectRoot: tmp,
    resourcesPath: path.join(tmp, "missing"),
  }), null);
});

test("mosh fallback messages do not point users to the removed Mosh settings field", () => {
  const source = fs.readFileSync(path.join(__dirname, "terminalBridge.cjs"), "utf8");

  assert.equal(source.includes("Settings → Terminal → Mosh"), false);
});

test("mosh runtime does not fall back to system mosh or mosh-client", () => {
  const source = fs.readFileSync(path.join(__dirname, "terminalBridge.cjs"), "utf8");

  assert.equal(source.includes('resolvePosixExecutable("mosh-client"'), false);
  assert.equal(source.includes('findExecutable("mosh-client"'), false);
  assert.equal(source.includes('resolvePosixExecutable("mosh"'), false);
  assert.equal(source.includes('findExecutable("mosh"'), false);
  assert.equal(source.includes("brew install mosh"), false);
});

test("MoshCatty runtime env is a no-op (no DLL bag / terminfo)", () => {
  const env = { Path: "C:\\Windows\\System32", TERM: "xterm-256color" };
  const out = addBundledMoshRuntimeEnv(env, "C:\\app\\mosh-client.exe", { platform: "win32" });
  assert.equal(out, env);
  assert.equal(env.TERMINFO, undefined);
  assert.equal(env.TERMINFO_DIRS, undefined);
  assert.equal(env.Path, "C:\\Windows\\System32");
});

test("mosh UTF-8 decoder preserves fragmented Chinese output", () => {
  const { createMoshUtf8Decoder } = createMoshSessionApi({
    StringDecoder,
    Buffer,
  });
  const decode = createMoshUtf8Decoder();
  const fixture = Buffer.from("mosh: 连接恢复，终端输出正常\n", "utf8");
  const chunks = [
    fixture.subarray(0, 9),
    fixture.subarray(9, 11),
    fixture.subarray(11, 17),
    fixture.subarray(17),
  ];

  const decoded = chunks.map((chunk) => decode(chunk)).join("");

  assert.equal(decoded, "mosh: 连接恢复，终端输出正常\n");
  assert.equal(decoded.includes("\uFFFD"), false);
});

test("Mosh prepares the configured system agent before building native ssh options", async (t) => {
  const calls = [];
  const tempBase = makeTmp();
  t.after(() => fs.rmSync(tempBase, { recursive: true, force: true }));
  const api = createMoshSessionApi({
    os,
    path,
    fs,
    process,
    randomUUID: () => "fixed",
    tempDirBridge: { getTempFilePath: (fileName) => path.join(tempBase, fileName) },
    prepareSystemSshAgentForAuth: async (options) => {
      calls.push(["prepare", options.identityAgent, options.useKeychain]);
    },
    getAvailableAgentSocket: async (identityAgent) => {
      calls.push(["resolve", identityAgent]);
      return "/tmp/custom-agent.sock";
    },
  });

  const prepared = await api.prepareMoshSshAgentOptions({
    hostname: "host.example",
    username: "alice",
    useSshAgent: true,
    identityAgent: "/tmp/custom-agent.sock",
    useKeychain: true,
    addKeysToAgent: "yes",
    identityFilePaths: ["~/.ssh/id_work"],
  });
  const auth = await api.buildMoshSshAuthArgs({
    ...prepared,
    identitiesOnly: true,
    identityFilePaths: ["~/.ssh/id_work"],
  }, "session-1");
  const env = api.applyMoshSshAgentEnvironment({}, prepared);

  assert.deepEqual(calls, [
    ["prepare", "/tmp/custom-agent.sock", true],
    ["resolve", "/tmp/custom-agent.sock"],
  ]);
  assert.deepEqual(auth.sshArgs, [
    "-i", path.join(os.homedir(), ".ssh", "id_work.pub"),
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=/tmp/custom-agent.sock",
    "-o", "StrictHostKeyChecking=ask",
  ]);
  assert.equal(env.SSH_AUTH_SOCK, "/tmp/custom-agent.sock");

  const selected = await api.buildMoshSshAuthArgs({
    ...prepared,
    identitiesOnly: true,
    keyId: "vault-key",
    agentPublicKeys: ["ssh-ed25519 AAAASELECTED"],
  }, "session-selected");
  const selectedPath = selected.sshArgs[1];
  assert.deepEqual(selected.sshArgs.slice(0, 2), ["-i", selectedPath]);
  assert.equal(fs.readFileSync(selectedPath, "utf8"), "ssh-ed25519 AAAASELECTED\n");
  assert.ok(selected.sshArgs.includes("IdentitiesOnly=yes"));
  api.cleanupMoshAuthTempFiles(selected.tempFiles);
});

test("Mosh injects vault known_hosts into the SSH bootstrap for key-change checks", async (t) => {
  const tempBase = makeTmp();
  t.after(() => fs.rmSync(tempBase, { recursive: true, force: true }));
  const api = createMoshSessionApi({
    os,
    path,
    fs,
    process,
    randomUUID: () => "fixed",
    tempDirBridge: { getTempFilePath: (fileName) => path.join(tempBase, fileName) },
  });

  const auth = await api.buildMoshSshAuthArgs({
    useSshAgent: false,
    hostname: "host.example",
    port: 22,
    knownHosts: [{
      hostname: "host.example",
      port: 22,
      keyType: "ssh-ed25519",
      publicKey: "ssh-ed25519 AAAAMOSHVAULT",
    }],
  }, "session-vault-kh");

  let trustPath = null;
  for (let i = 0; i < auth.sshArgs.length - 1; i += 1) {
    if (auth.sshArgs[i] === "-o" && String(auth.sshArgs[i + 1]).startsWith("UserKnownHostsFile=")) {
      trustPath = auth.sshArgs[i + 1].slice("UserKnownHostsFile=".length);
      break;
    }
  }
  assert.ok(trustPath, "expected UserKnownHostsFile ssh option");
  assert.ok(auth.sshArgs.includes(`GlobalKnownHostsFile=${trustPath}`));
  assert.ok(fs.existsSync(trustPath));
  assert.match(fs.readFileSync(trustPath, "utf8"), /host\.example ssh-ed25519 AAAAMOSHVAULT/);
  // Force ask so a permissive user ssh_config cannot disable verification.
  assert.ok(auth.sshArgs.includes("StrictHostKeyChecking=ask"));
  api.cleanupMoshAuthTempFiles(auth.tempFiles);
});

test("Mosh disables host-key checks when verifyHostKeys is false", async (t) => {
  const tempBase = makeTmp();
  t.after(() => fs.rmSync(tempBase, { recursive: true, force: true }));
  const api = createMoshSessionApi({
    os,
    path,
    fs,
    process,
    randomUUID: () => "fixed",
    tempDirBridge: { getTempFilePath: (fileName) => path.join(tempBase, fileName) },
  });

  const auth = await api.buildMoshSshAuthArgs({
    useSshAgent: false,
    verifyHostKeys: false,
    knownHosts: [{
      hostname: "host.example",
      keyType: "ssh-ed25519",
      publicKey: "ssh-ed25519 AAASTALE",
    }],
  }, "session-no-verify");

  assert.equal(auth.sshArgs[0], "-o");
  assert.equal(auth.sshArgs[1], "IdentityAgent=none");
  let emptyPath = null;
  for (let i = 0; i < auth.sshArgs.length - 1; i += 1) {
    if (auth.sshArgs[i] === "-o" && String(auth.sshArgs[i + 1]).startsWith("UserKnownHostsFile=")) {
      emptyPath = auth.sshArgs[i + 1].slice("UserKnownHostsFile=".length);
      break;
    }
  }
  assert.ok(emptyPath);
  assert.ok(auth.sshArgs.includes(`GlobalKnownHostsFile=${emptyPath}`));
  assert.ok(auth.sshArgs.includes("StrictHostKeyChecking=no"));
  assert.equal(fs.readFileSync(emptyPath, "utf8").trim(), "");
  assert.equal(auth.sshArgs.some((arg) => String(arg).includes("AAASTALE")), false);
  api.cleanupMoshAuthTempFiles(auth.tempFiles);
});

test("Mosh explicitly disables native agent login after an opt-out", async () => {
  const api = createMoshSessionApi({
    os,
    path,
    fs,
    process,
    randomUUID: () => "fixed",
  });
  const auth = await api.buildMoshSshAuthArgs({ useSshAgent: false }, "session-disabled");
  const env = api.applyMoshSshAgentEnvironment(
    { SSH_AUTH_SOCK: "/tmp/inherited-agent.sock" },
    { useSshAgent: false },
  );

  assert.deepEqual(auth.sshArgs, [
    "-o", "IdentityAgent=none",
    "-o", "StrictHostKeyChecking=ask",
  ]);
  assert.equal(env.SSH_AUTH_SOCK, undefined);

  const forwardingAuth = await api.buildMoshSshAuthArgs({
    useSshAgent: false,
    agentForwarding: true,
  }, "session-forwarding");
  const forwardingEnv = api.applyMoshSshAgentEnvironment(
    { SSH_AUTH_SOCK: "/tmp/forwarded-agent.sock" },
    { useSshAgent: false, agentForwarding: true },
  );
  assert.deepEqual(forwardingAuth.sshArgs, [
    "-o", "IdentityAgent=none",
    "-o", "StrictHostKeyChecking=ask",
  ]);
  assert.equal(forwardingEnv.SSH_AUTH_SOCK, undefined);
});

test("Mosh releases prepared FIDO agent when forwarding-agent resolution fails", async () => {
  let releaseCount = 0;
  const api = createMoshSessionApi({
    os,
    path,
    fs,
    process,
    randomUUID: () => "fixed",
    prepareSystemSshAgentForAuth: async () => ({
      _releaseNetcattyFidoAgent: () => { releaseCount += 1; },
    }),
    getAvailableAgentSocket: async () => "/tmp/login-agent.sock",
    getAvailableForwardingAgentSocket: async () => {
      const error = new Error(
        "This SSH agent is available only to Netcatty's built-in SSH client.",
      );
      error.code = "ERR_SSH_AGENT_NATIVE_UNSUPPORTED";
      throw error;
    },
  });

  await assert.rejects(
    () => api.prepareMoshSshAgentOptions({
      useSshAgent: true,
      agentForwarding: true,
    }),
    (error) => error?.code === "ERR_SSH_AGENT_NATIVE_UNSUPPORTED",
  );
  assert.equal(releaseCount, 1);
});

test("Mosh keeps its login agent separate from the discovered forwarding agent", async () => {
  const localAgent = "/private/tmp/com.apple.launchd.test/Listeners";
  const forwardingAgent = "/Users/alice/.bitwarden-ssh-agent.sock";
  const api = createMoshSessionApi({
    os,
    path,
    fs,
    process: { ...process, env: { SSH_AUTH_SOCK: localAgent } },
    randomUUID: () => "fixed",
    prepareSystemSshAgentForAuth: async () => {},
    getAvailableAgentSocket: async () => localAgent,
    getAvailableForwardingAgentSocket: async () => forwardingAgent,
  });

  for (const useSshAgent of [false, undefined, true]) {
    const prepared = await api.prepareMoshSshAgentOptions({
      useSshAgent,
      agentForwarding: true,
    });
    const env = api.applyMoshSshAgentEnvironment(
      { SSH_AUTH_SOCK: "/tmp/remote-agent.sock" },
      prepared,
    );
    const auth = await api.buildMoshSshAuthArgs(prepared, `session-forwarding-${String(useSshAgent)}`);

    assert.equal(prepared._resolvedSshAgentSocket, useSshAgent === true ? localAgent : undefined);
    assert.equal(prepared._resolvedForwardingAgentSocket, forwardingAgent);
    assert.equal(env.SSH_AUTH_SOCK, useSshAgent === false ? undefined : localAgent);
    assert.ok(auth.sshArgs.includes(`ForwardAgent=${forwardingAgent}`));
  }
});

test("Mosh forwards a Windows named-pipe agent through SSH_AUTH_SOCK", async () => {
  const forwardingAgent = "\\\\.\\pipe\\openssh-ssh-agent";
  const processMock = Object.create(process);
  Object.defineProperty(processMock, "platform", { value: "win32" });
  processMock.env = {};
  const api = createMoshSessionApi({
    os,
    path,
    fs,
    process: processMock,
    randomUUID: () => "fixed",
  });
  const prepared = {
    useSshAgent: false,
    agentForwarding: true,
    _resolvedForwardingAgentSocket: forwardingAgent,
  };

  const env = api.applyMoshSshAgentEnvironment({}, prepared);
  const auth = await api.buildMoshSshAuthArgs(prepared, "session-windows-forwarding");

  assert.equal(env.SSH_AUTH_SOCK, forwardingAgent);
  assert.ok(auth.sshArgs.includes("ForwardAgent=${SSH_AUTH_SOCK}"));
  assert.equal(auth.sshArgs.some((arg) => arg.includes(forwardingAgent)), false);
});

test("Mosh automatic mode discovers custom local keys in preferred order", async (t) => {
  const tempBase = makeTmp();
  const fakeHome = path.join(tempBase, "home");
  const sshDir = path.join(fakeHome, ".ssh");
  fs.mkdirSync(sshDir, { recursive: true });
  fs.writeFileSync(path.join(sshDir, "id_work"), "PRIVATE KEY");
  fs.writeFileSync(path.join(sshDir, "id_ed25519"), "PRIVATE KEY");
  fs.writeFileSync(path.join(sshDir, "id_rsa.pub"), "PUBLIC KEY");
  t.after(() => fs.rmSync(tempBase, { recursive: true, force: true }));

  const api = createMoshSessionApi({
    os: { ...os, homedir: () => fakeHome },
    path,
    fs,
    process,
    randomUUID: () => "fixed",
  });
  const auth = await api.buildMoshSshAuthArgs({ authMethod: "auto" }, "session-auto");

  assert.deepEqual(auth.sshArgs, [
    "-i", path.join(sshDir, "id_ed25519"),
    "-i", path.join(sshDir, "id_work"),
    "-o", "StrictHostKeyChecking=ask",
  ]);
  assert.deepEqual(auth.identityFilePaths, [
    path.join(sshDir, "id_ed25519"),
    path.join(sshDir, "id_work"),
  ]);

  const agentFallback = await api.buildMoshSshAuthArgs({
    authMethod: "auto",
    useSshAgent: true,
    identitiesOnly: false,
  }, "session-auto-agent");
  assert.deepEqual(agentFallback.sshArgs, [
    "-i", path.join(sshDir, "id_ed25519"),
    "-i", path.join(sshDir, "id_work"),
    "-o", "StrictHostKeyChecking=ask",
  ]);
  assert.deepEqual(agentFallback.identityFilePaths, [
    path.join(sshDir, "id_ed25519"),
    path.join(sshDir, "id_work"),
  ]);
});

test("startMoshSessionViaHandshake releases FIDO lease when auth setup fails", async () => {
  let releaseCount = 0;
  const moshHandshake = require("./moshHandshake.cjs");
  const api = createMoshSessionApi({
    os,
    path,
    fs,
    process,
    randomUUID: () => "fixed",
    moshHandshake,
    pty: {
      spawn() {
        throw new Error("pty.spawn should not run after auth setup failure");
      },
    },
    tempDirBridge: {
      getTempFilePath() {
        throw new Error("temp unavailable");
      },
    },
  });

  await assert.rejects(
    () => api.startMoshSessionViaHandshake(
      { sender: { id: 1 } },
      {
        hostname: "host.example",
        username: "alice",
        privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----",
        _releaseNetcattyFidoAgent: () => { releaseCount += 1; },
      },
      { bareClient: "/tmp/mosh-client", sshExe: "/usr/bin/ssh" },
    ),
    /temp unavailable/,
  );
  assert.equal(releaseCount, 1);
});

test("removed Mosh client detection APIs are not exposed to the renderer", () => {
  const bridgeSource = fs.readFileSync(path.join(__dirname, "terminalBridge.cjs"), "utf8");
  const preloadSource = fs.readFileSync(path.join(__dirname, "..", "preload.cjs"), "utf8");
  const globalTypes = fs.readFileSync(path.join(__dirname, "..", "..", "global.d.ts"), "utf8");

  for (const source of [bridgeSource, preloadSource, globalTypes]) {
    assert.equal(source.includes("detectMoshClient"), false);
    assert.equal(source.includes("pickMoshClient"), false);
    assert.equal(source.includes("netcatty:mosh:detectClient"), false);
    assert.equal(source.includes("netcatty:mosh:pickClient"), false);
  }
});

test("Cygwin / terminfo helpers are gone from the mosh session module", () => {
  const source = fs.readFileSync(path.join(__dirname, "terminalBridge", "moshSession.cjs"), "utf8");
  assert.equal(source.includes("toCygwinPath"), false);
  assert.equal(source.includes("findBundledMoshDllDir"), false);
  assert.equal(source.includes("findBundledMoshTerminfoDir"), false);
  assert.equal(source.includes("cygwin1"), false);
});
