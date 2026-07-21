const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { createEtSessionApi } = require("./etSession.cjs");

// Build an et session API wired to a hermetic temp HOME so prepareEtSshEnvironment
// is deterministic regardless of the developer's real ~/.ssh contents.
function makeApi(t, overrides = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-et-prep-"));
  const fakeHome = path.join(base, "home");
  const sessions = overrides.sessions || new Map();
  const pty = overrides.pty || {};
  const bundledEtClient = overrides.bundledEtClient || (() => null);
  fs.mkdirSync(fakeHome, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const tempDirBridge = {
    getTempFilePath: (name) => path.join(base, name),
    getTempDir: () => base,
  };
  const osMock = {
    homedir: () => fakeHome,
    userInfo: () => ({ username: "tester" }),
    tmpdir: () => base,
  };

  const api = createEtSessionApi({
    sessions,
    electronModule: {},
    os: osMock,
    fs,
    path,
    process,
    console,
    // no-op execFileSync so writeSecureFile's Windows icacls hardening doesn't spawn
    execFileSync: () => {},
    execFile: () => {},
    ...overrides,
    StringDecoder: require("node:string_decoder").StringDecoder,
    randomUUID: require("node:crypto").randomUUID,
    pty,
    sessionLogStreamManager: overrides.sessionLogStreamManager || {},
    tempDirBridge,
    createZmodemSentry: () => ({}),
    trackSessionIdlePrompt: () => {},
    createPtyOutputBuffer: overrides.createPtyOutputBuffer
      || (() => ({ bufferData() {}, flush() {}, flushPaced() {} })),
    findExecutable: () => "ssh",
    bundledEtClient,
  });
  return { api, base, sessions };
}

test("prepareEtSshEnvironment builds userHost and base ssh options", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", { hostname: "host.example", username: "alice" });

  assert.equal(env.userHost, "alice@host.example");
  assert.ok(env.sshOptions.includes("KbdInteractiveAuthentication=yes"));
  assert.ok(env.sshOptions.includes("NumberOfPasswordPrompts=1"));
  // Non-interactive host-key handling: et's SSH_ASKPASS can't answer a yes/no
  // prompt, so a first-time host must auto-accept instead of stalling on a
  // prompt whose leaked text would prematurely flip the tab to "connected".
  assert.ok(env.sshOptions.includes("StrictHostKeyChecking=accept-new"));
  assert.ok(env.sshOptions.includes("LogLevel=ERROR"));
  assert.ok(env.sshOptions.some((o) => o.startsWith("UserKnownHostsFile=")));
  assert.ok(Array.isArray(env.artifacts) && env.artifacts.length >= 1);
});

test("prepareEtSshEnvironment defaults the user to the local username", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", { hostname: "host.example" });
  assert.equal(env.userHost, "tester@host.example");
});

test("startEtSession preserves discovered automatic identities for host information", async (t) => {
  const proc = {
    onData() {},
    onExit() {},
    write() {},
  };
  const { api, base, sessions } = makeApi(t, {
    bundledEtClient: () => "/fake/et",
    pty: { spawn: () => proc },
    electronModule: { webContents: { fromId: () => null } },
    openTerminalOutputSession: () => {},
    selectZmodemUploadFiles: null,
    selectZmodemDownloadDirectory: null,
  });
  const keyPath = path.join(base, "home", ".ssh", "id_ed25519_sk");
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, "PRIVATE KEY");

  await api.startEtSession({ sender: { id: 7 } }, {
    sessionId: "sess-auto-stats",
    hostname: "host.example",
    username: "alice",
    authMethod: "auto",
    useSshAgent: false,
  });

  assert.deepEqual(
    sessions.get("sess-auto-stats").etStatsAuth.identityFilePaths,
    [keyPath],
  );
  assert.equal(sessions.get("sess-auto-stats").etStatsAuth.authMethod, "auto");
});

test("explicitly closed ET sessions do not emit a second exit event", async (t) => {
  let onExit = null;
  const sent = [];
  const proc = {
    onData() {},
    onExit(callback) { onExit = callback; },
    write() {},
  };
  const { api, sessions } = makeApi(t, {
    bundledEtClient: () => "/fake/et",
    pty: { spawn: () => proc },
    electronModule: {
      webContents: {
        fromId: () => ({ id: 7, send: (channel, payload) => sent.push({ channel, payload }) }),
      },
    },
    openTerminalOutputSession: () => {},
    closeTerminalOutputSession: () => {},
    sessionLogStreamManager: { stopStream() {} },
    createPtyOutputBuffer: () => ({
      bufferData() {},
      flush() {},
      flushPaced(callback) { callback(); },
    }),
    selectZmodemUploadFiles: null,
    selectZmodemDownloadDirectory: null,
  });

  await api.startEtSession({ sender: { id: 7 } }, {
    sessionId: "sess-explicit-close",
    hostname: "host.example",
    username: "alice",
  });
  sessions.get("sess-explicit-close").closed = true;
  onExit({ exitCode: 0 });

  assert.deepEqual(sent, []);
  assert.equal(sessions.has("sess-explicit-close"), false);
});

test("prepareEtSshEnvironment passes a non-default port via --ssh-option", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", { hostname: "h", username: "u", port: 2222 });
  assert.ok(env.sshOptions.includes("Port=2222"));
});

test("prepareEtSshEnvironment does not set Port for the default 22", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", { hostname: "h", username: "u", port: 22 });
  assert.ok(!env.sshOptions.some((o) => o.startsWith("Port=")));
});

test("prepareEtSshEnvironment writes an askpass map + sets SSH_ASKPASS for password auth", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", { hostname: "h", username: "u", password: "s3cret" });

  assert.ok(env.env.SSH_ASKPASS, "SSH_ASKPASS should be set when a password is provided");
  assert.equal(env.env.SSH_ASKPASS_REQUIRE, "force");
  assert.ok(env.env.NETCATTY_ET_ASKPASS_MAP, "askpass map path should be exported");
  const map = JSON.parse(fs.readFileSync(env.env.NETCATTY_ET_ASKPASS_MAP, "utf8"));
  assert.equal(map.length, 1);
  assert.equal(map[0].type, "password");
  // The secret is written to its own file referenced by the map entry.
  assert.equal(fs.readFileSync(map[0].secretFile, "utf8").trim(), "s3cret");
});

test("prepareEtSshEnvironment password mode overrides a stale agent toggle", (t) => {
  const { api, base } = makeApi(t);
  const defaultKeyPath = path.join(base, "home", ".ssh", "id_work");
  fs.mkdirSync(path.dirname(defaultKeyPath), { recursive: true });
  fs.writeFileSync(defaultKeyPath, "PRIVATE KEY");

  const env = api.prepareEtSshEnvironment("sess-password", {
    hostname: "h",
    username: "u",
    authMethod: "password",
    password: "saved-secret",
    useSshAgent: true,
  });

  assert.ok(env.sshOptions.includes("PubkeyAuthentication=no"));
  assert.equal(env.sshOptions.some((option) => option.startsWith("IdentityFile=")), false);
  const config = fs.readFileSync(path.join(env.env.HOME, ".ssh", "config"), "utf8");
  assert.match(config, /PreferredAuthentications password,keyboard-interactive/);
});

test("prepareEtSshEnvironment keeps password before keyboard-interactive for MFA password mode", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess-mfa-password", {
    hostname: "h",
    username: "u",
    authMethod: "password",
    password: "saved-secret",
    requiresMfa: true,
  });

  assert.ok(env.sshOptions.includes("PubkeyAuthentication=no"));
  const config = fs.readFileSync(path.join(env.env.HOME, ".ssh", "config"), "utf8");
  assert.match(config, /PreferredAuthentications password,keyboard-interactive/);
});

test("prepareEtSshEnvironment automatic mode tries real local keys before a saved password", (t) => {
  const { api, base } = makeApi(t);
  const defaultKeyPath = path.join(base, "home", ".ssh", "id_ed25519_sk");
  fs.mkdirSync(path.dirname(defaultKeyPath), { recursive: true });
  fs.writeFileSync(defaultKeyPath, "PRIVATE KEY");

  const env = api.prepareEtSshEnvironment("sess-auto", {
    hostname: "h",
    username: "u",
    authMethod: "auto",
    password: "saved-secret",
  });

  assert.ok(env.sshOptions.includes(`IdentityFile=${defaultKeyPath.replace(/\\/g, "/")}`));
  assert.equal(env.sshOptions.includes("PubkeyAuthentication=no"), false);
  const config = fs.readFileSync(path.join(env.env.HOME, ".ssh", "config"), "utf8");
  assert.match(config, /PreferredAuthentications publickey,password,keyboard-interactive/);
});

test("prepareEtSshEnvironment keeps password before keyboard-interactive for MFA auto mode", (t) => {
  const { api, base } = makeApi(t);
  const defaultKeyPath = path.join(base, "home", ".ssh", "id_ed25519_sk");
  fs.mkdirSync(path.dirname(defaultKeyPath), { recursive: true });
  fs.writeFileSync(defaultKeyPath, "PRIVATE KEY");

  const env = api.prepareEtSshEnvironment("sess-auto-mfa", {
    hostname: "h",
    username: "u",
    authMethod: "auto",
    password: "saved-secret",
    requiresMfa: true,
  });

  assert.ok(env.sshOptions.includes(`IdentityFile=${defaultKeyPath.replace(/\\/g, "/")}`));
  const config = fs.readFileSync(path.join(env.env.HOME, ".ssh", "config"), "utf8");
  assert.match(config, /PreferredAuthentications publickey,password,keyboard-interactive/);
});

test("prepareEtSshEnvironment automatic mode tries standard keys before custom keys", (t) => {
  const { api, base } = makeApi(t);
  const sshDir = path.join(base, "home", ".ssh");
  fs.mkdirSync(sshDir, { recursive: true });
  fs.writeFileSync(path.join(sshDir, "id_work"), "PRIVATE KEY");
  fs.writeFileSync(path.join(sshDir, "id_rsa"), "PRIVATE KEY");
  fs.writeFileSync(path.join(sshDir, "id_ed25519"), "PRIVATE KEY");

  const env = api.prepareEtSshEnvironment("sess-auto-order", {
    hostname: "h",
    username: "u",
    authMethod: "auto",
  });
  const identities = env.sshOptions.filter((option) => option.startsWith("IdentityFile="));

  assert.deepEqual(identities, [
    `IdentityFile=${path.join(sshDir, "id_ed25519").replace(/\\/g, "/")}`,
    `IdentityFile=${path.join(sshDir, "id_rsa").replace(/\\/g, "/")}`,
    `IdentityFile=${path.join(sshDir, "id_work").replace(/\\/g, "/")}`,
  ]);
});

test("prepareEtSshEnvironment automatic mode keeps interactive authentication without a saved password", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess-auto-interactive", {
    hostname: "h",
    username: "u",
    authMethod: "auto",
  });

  const config = fs.readFileSync(path.join(env.env.HOME, ".ssh", "config"), "utf8");
  assert.match(config, /PreferredAuthentications publickey,password,keyboard-interactive/);
});

test("prepareEtSshEnvironment tolerates an unreadable local SSH directory", (t) => {
  const unreadableFs = {
    ...fs,
    readdirSync(targetPath, options) {
      if (String(targetPath).endsWith(`${path.sep}home${path.sep}.ssh`)) {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      }
      return fs.readdirSync(targetPath, options);
    },
  };
  const { api } = makeApi(t, { fs: unreadableFs });

  assert.doesNotThrow(() => api.prepareEtSshEnvironment("sess-unreadable-ssh", {
    hostname: "h",
    username: "u",
    authMethod: "password",
    password: "saved-secret",
  }));
});

test("prepareEtSshEnvironment askpass prefers the most specific matching password prompt", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "app",
    username: "alice",
    password: "target-secret",
    jumpHosts: [{
      hostname: "app-bastion",
      username: "ops",
      password: "jump-secret",
    }],
  });

  const output = execFileSync(env.env.SSH_ASKPASS, ["ops@app-bastion's password:"], {
    env: { ...process.env, ...env.env },
    encoding: "utf8",
  });

  assert.equal(output.trim(), "jump-secret");
});

test("prepareEtSshEnvironment never sends one key passphrase to an unrelated automatic key", (t) => {
  const { api, base } = makeApi(t);
  const automaticKeyPath = path.join(base, "home", ".ssh", "id_automatic");
  fs.mkdirSync(path.dirname(automaticKeyPath), { recursive: true });
  fs.writeFileSync(automaticKeyPath, "ENCRYPTED PRIVATE KEY");

  const env = api.prepareEtSshEnvironment("sess-passphrase-scope", {
    hostname: "target.example",
    username: "alice",
    authMethod: "auto",
    jumpHosts: [{
      hostname: "jump.example",
      username: "ops",
      authMethod: "key",
      privateKey: "-----BEGIN KEY-----\njump\n-----END KEY-----",
      passphrase: "jump-key-passphrase",
    }],
  });

  const output = execFileSync(env.env.SSH_ASKPASS, [`Enter passphrase for key '${automaticKeyPath}':`], {
    env: { ...process.env, ...env.env },
    encoding: "utf8",
  });
  assert.equal(output, "");
});

test("prepareEtSshEnvironment never sends a saved password to a PIN or MFA prompt", (t) => {
  const { api, base } = makeApi(t);
  const hardwareKeyPath = path.join(base, "home", ".ssh", "id_ed25519_sk");
  fs.mkdirSync(path.dirname(hardwareKeyPath), { recursive: true });
  fs.writeFileSync(hardwareKeyPath, "HARDWARE KEY HANDLE");

  const env = api.prepareEtSshEnvironment("sess-hardware-pin", {
    hostname: "target.example",
    username: "alice",
    authMethod: "auto",
    password: "saved-login-password",
  });

  for (const prompt of [
    "Enter PIN for authenticator:",
    "One-time password:",
    "OTP password:",
    "Token password:",
    "alice@target.example's token password:",
  ]) {
    const output = execFileSync(env.env.SSH_ASKPASS, [prompt], {
      env: { ...process.env, ...env.env },
      encoding: "utf8",
    });
    assert.equal(output, "", prompt);
  }
});

test("prepareEtSshEnvironment ignores MFA words inside the matched login identity", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess-mfa-hostname", {
    hostname: "token.duo.example",
    username: "verification-user",
    authMethod: "password",
    password: "saved-login-password",
  });

  const output = execFileSync(
    env.env.SSH_ASKPASS,
    ["verification-user@token.duo.example's password:"],
    {
      env: { ...process.env, ...env.env },
      encoding: "utf8",
    },
  );

  assert.equal(output.trim(), "saved-login-password");
});

test(
  "prepareEtSshEnvironment points SSH_ASKPASS at an Electron wrapper on Unix",
  { skip: process.platform === "win32" ? "Unix-only askpass wrapper" : false },
  (t) => {
    const { api } = makeApi(t);
    const env = api.prepareEtSshEnvironment("sess1", { hostname: "h", username: "u", password: "s3cret" });

    // In a packaged build there is no `node` on PATH, so the helper must run
    // through Electron's own binary (process.execPath) with ELECTRON_RUN_AS_NODE
    // rather than relying on the .cjs `#!/usr/bin/env node` shebang.
    assert.match(env.env.SSH_ASKPASS, /\.sh$/);
    const wrapper = fs.readFileSync(env.env.SSH_ASKPASS, "utf8");
    assert.match(wrapper, /^#!\/bin\/sh/);
    assert.match(wrapper, /ELECTRON_RUN_AS_NODE=1/);
    assert.ok(
      wrapper.includes(process.execPath),
      "wrapper should exec the current Electron/node executable verbatim",
    );
    assert.match(wrapper, /netcatty-et-askpass\.cjs/);
    // The wrapper must be executable so ssh can exec it directly.
    const mode = fs.statSync(env.env.SSH_ASKPASS).mode;
    assert.ok(mode & 0o100, "wrapper should be owner-executable");
  },
);

test("prepareEtSshEnvironment writes a private key + IdentityFile option and a passphrase askpass entry", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "h",
    username: "u",
    privateKey: "-----BEGIN KEY-----\nabc\n-----END KEY-----",
    passphrase: "pp",
  });

  assert.ok(env.sshOptions.some((o) => o.startsWith("IdentityFile=")));
  assert.ok(env.sshOptions.includes("IdentitiesOnly=yes"));
  const map = JSON.parse(fs.readFileSync(env.env.NETCATTY_ET_ASKPASS_MAP, "utf8"));
  assert.ok(map.some((e) => e.type === "passphrase"));
});

test("prepareEtSshEnvironment enables selected agent-backed key auth", (t) => {
  const { api, base } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess-agent", {
    hostname: "host.example",
    username: "alice",
    authMethod: "key",
    useSshAgent: true,
    _resolvedSshAgentSocket: "/tmp/custom agent.sock",
    identityFilePaths: ["~/.ssh/id_work"],
    agentPublicKeys: ["ssh-ed25519 AAAASELECTED"],
    identitiesOnly: true,
  });

  assert.ok(env.sshOptions.includes("IdentitiesOnly=yes"));
  assert.ok(env.sshOptions.includes("PreferredAuthentications=publickey"));
  assert.equal(env.sshOptions.includes("PubkeyAuthentication=no"), false);
  const config = fs.readFileSync(path.join(env.env.HOME, ".ssh", "config"), "utf8");
  assert.match(config, /IdentityAgent "\/tmp\/custom agent\.sock"/);
  assert.ok(
    env.sshOptions.includes(`IdentityFile=${path.join(base, "home", ".ssh", "id_work.pub").replace(/\\/g, "/")}`),
    "agent-only mode should use only the public file as its identity selector",
  );
  const selectedIdentityOption = env.sshOptions.find((option) => option.includes("-agent-0.pub"));
  assert.ok(selectedIdentityOption);
  const selectedIdentityPath = selectedIdentityOption.split("=")[1];
  assert.equal(fs.readFileSync(selectedIdentityPath, "utf8"), "ssh-ed25519 AAAASELECTED");
  assert.equal(
    api.applyEtSshAgentEnvironment({}, {
      useSshAgent: true,
      _resolvedSshAgentSocket: "/tmp/custom agent.sock",
    }).SSH_AUTH_SOCK,
    "/tmp/custom agent.sock",
  );
});

test("ET strict key modes do not fall back to unrelated default identities", (t) => {
  const { api, base } = makeApi(t);
  const defaultKeyPath = path.join(base, "home", ".ssh", "id_unrelated");
  fs.mkdirSync(path.dirname(defaultKeyPath), { recursive: true });
  fs.writeFileSync(defaultKeyPath, "UNRELATED PRIVATE KEY");

  const target = api.prepareEtSshEnvironment("sess-missing-target-key", {
    hostname: "target.example",
    username: "alice",
    authMethod: "key",
  });
  assert.ok(target.sshOptions.includes("IdentityFile=none"));
  assert.ok(target.sshOptions.includes("IdentitiesOnly=yes"));
  assert.equal(target.sshOptions.includes(`IdentityFile=${defaultKeyPath}`), false);

  const jump = api.prepareEtSshEnvironment("sess-missing-jump-key", {
    hostname: "target.example",
    username: "alice",
    authMethod: "password",
    password: "target-secret",
    jumpHosts: [{
      hostname: "jump.example",
      username: "ops",
      authMethod: "certificate",
    }],
  });
  const config = fs.readFileSync(path.join(jump.env.HOME, ".ssh", "config"), "utf8");
  assert.match(config, /Host jump\.example[\s\S]*IdentityFile none/);
  assert.match(config, /Host jump\.example[\s\S]*IdentitiesOnly yes/);
  assert.doesNotMatch(config, new RegExp(defaultKeyPath.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
});

test("ET explicitly disables native agent login for target and jump hosts", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess-agent-disabled", {
    hostname: "host.example",
    username: "alice",
    useSshAgent: false,
    jumpHosts: [{
      hostname: "jump.example",
      username: "ops",
      useSshAgent: false,
    }],
  });
  const config = fs.readFileSync(path.join(env.env.HOME, ".ssh", "config"), "utf8");
  const processEnv = api.applyEtSshAgentEnvironment(
    { SSH_AUTH_SOCK: "/tmp/inherited-agent.sock" },
    { useSshAgent: false },
  );

  assert.match(config, /Host host\.example[\s\S]*IdentityAgent none/);
  assert.match(config, /Host jump\.example[\s\S]*IdentityAgent none/);
  assert.equal(processEnv.SSH_AUTH_SOCK, undefined);

  const forwarding = api.prepareEtSshEnvironment("sess-agent-forwarding", {
    hostname: "forward.example",
    username: "alice",
    useSshAgent: false,
    agentForwarding: true,
  });
  const forwardingConfig = fs.readFileSync(path.join(forwarding.env.HOME, ".ssh", "config"), "utf8");
  const forwardingEnv = api.applyEtSshAgentEnvironment(
    { SSH_AUTH_SOCK: "/tmp/forwarded-agent.sock" },
    { useSshAgent: false, agentForwarding: true },
  );
  assert.match(forwardingConfig, /IdentityAgent none/);
  assert.match(forwardingConfig, /ForwardAgent \$\{SSH_AUTH_SOCK\}/);
  assert.equal(forwardingEnv.SSH_AUTH_SOCK, "/tmp/forwarded-agent.sock");

  const automaticJumpEnv = api.applyEtSshAgentEnvironment(
    { SSH_AUTH_SOCK: "/tmp/jump-agent.sock" },
    {
      authMethod: "password",
      useSshAgent: false,
      jumpHosts: [{ authMethod: "auto" }],
    },
  );
  assert.equal(automaticJumpEnv.SSH_AUTH_SOCK, "/tmp/jump-agent.sock");
});

test("ET prepares target and jump agents before generating their host config", async (t) => {
  const calls = [];
  const { api } = makeApi(t, {
    prepareSystemSshAgentForAuth: async (options, prefix) => {
      calls.push(["prepare", options.hostname, prefix, options.useKeychain]);
    },
    getAvailableAgentSocket: async (identityAgent) => {
      calls.push(["resolve", identityAgent]);
      return identityAgent;
    },
  });
  const prepared = await api.prepareEtSshAgentOptions({
    hostname: "dest.example",
    username: "alice",
    useSshAgent: true,
    identityAgent: "/tmp/target.sock",
    useKeychain: true,
    identityFilePaths: ["~/.ssh/id_target"],
    jumpHosts: [{
      hostname: "jump.example",
      username: "ops",
      useSshAgent: true,
      identityAgent: "/tmp/jump.sock",
      identitiesOnly: true,
      agentPublicKeys: ["ssh-ed25519 AAAAJUMPSELECTED"],
    }],
  });
  const env = api.prepareEtSshEnvironment("sess-chain-agent", prepared);
  const config = fs.readFileSync(path.join(env.env.HOME, ".ssh", "config"), "utf8");

  assert.deepEqual(calls, [
    ["prepare", "dest.example", "[ET]", true],
    ["resolve", "/tmp/target.sock"],
    ["prepare", "jump.example", "[ET Chain] Hop 1:", undefined],
    ["resolve", "/tmp/jump.sock"],
  ]);
  assert.match(config, /Host dest\.example[\s\S]*IdentityAgent "\/tmp\/target\.sock"/);
  assert.match(config, /Host jump\.example[\s\S]*IdentityAgent "\/tmp\/jump\.sock"/);
  assert.match(config, /Host jump\.example[\s\S]*IdentitiesOnly yes/);
  const jumpSelectorMatch = config.match(/Host jump\.example[\s\S]*?IdentityFile "?([^"\n]*jump-agent-0\.pub)"?/);
  assert.ok(jumpSelectorMatch);
  assert.equal(fs.readFileSync(jumpSelectorMatch[1], "utf8"), "ssh-ed25519 AAAAJUMPSELECTED");
});

test("prepareEtSshEnvironment writes legacy algorithms to the ssh config file", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "h",
    username: "u",
    legacyAlgorithms: true,
  });

  // configLines were written → HOME/USERPROFILE point at the temp home.
  assert.ok(env.env.HOME, "HOME should be set when a config file is written");
  const configPath = path.join(env.env.HOME, ".ssh", "config");
  const config = fs.readFileSync(configPath, "utf8");
  assert.match(config, /KexAlgorithms \+diffie-hellman-group14-sha1/);
  assert.match(config, /Ciphers \+aes128-cbc/);
});

test("prepareEtSshEnvironment routes a single jump host through ET --jumphost/--jport", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "h",
    username: "u",
    jumpHosts: [{ hostname: "jump.example", username: "ops", port: 2200 }],
  });

  // ET drives the jump itself: socket connects to the jumphost's etserver,
  // destination is reached over the SSH tunnel. --jport defaults to 2022.
  assert.deepEqual(env.etJumpArgs, [
    "--jumphost",
    "ops@jump.example",
    "--jport",
    "2022",
  ]);

  // Per-hop jump settings live in a `Host <jumphost>` block (SSH port = 2200),
  // and the destination block adds a ProxyJump so a standalone ssh (distro
  // detection) also tunnels through the jump.
  const config = fs.readFileSync(path.join(env.env.HOME, ".ssh", "config"), "utf8");
  assert.match(config, /Host jump\.example/);
  assert.match(config, /\n {2}User ops/);
  assert.match(config, /\n {2}Port 2200/);
  assert.match(config, /Host h\n {2}ProxyJump jump\.example/);
  assert.match(config, /StrictHostKeyChecking accept-new/);
  // No ProxyCommand anymore — ET owns the jump routing.
  assert.doesNotMatch(config, /ProxyCommand/);
});

test("prepareEtSshEnvironment applies automatic authentication to a jump host", (t) => {
  const { api, base } = makeApi(t);
  const defaultKeyPath = path.join(base, "home", ".ssh", "id_work");
  fs.mkdirSync(path.dirname(defaultKeyPath), { recursive: true });
  fs.writeFileSync(defaultKeyPath, "PRIVATE KEY");

  const env = api.prepareEtSshEnvironment("sess-auto-jump", {
    hostname: "target.example",
    username: "alice",
    authMethod: "password",
    password: "target-secret",
    jumpHosts: [{
      hostname: "jump.example",
      username: "ops",
      authMethod: "auto",
      password: "jump-secret",
    }],
  });

  const config = fs.readFileSync(path.join(env.env.HOME, ".ssh", "config"), "utf8");
  assert.match(config, /Host jump\.example[\s\S]*IdentityFile "/);
  assert.ok(config.includes(defaultKeyPath.replace(/\\/g, "/")));
  assert.match(config, /Host jump\.example[\s\S]*PreferredAuthentications publickey,password,keyboard-interactive/);
});

test("prepareEtSshEnvironment keeps password before keyboard-interactive for MFA jump hosts", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess-mfa-jump", {
    hostname: "target.example",
    username: "alice",
    authMethod: "password",
    password: "target-secret",
    jumpHosts: [{
      hostname: "jump.example",
      username: "ops",
      authMethod: "password",
      password: "jump-secret",
      requiresMfa: true,
    }],
  });

  const config = fs.readFileSync(path.join(env.env.HOME, ".ssh", "config"), "utf8");
  assert.match(config, /Host jump\.example[\s\S]*PreferredAuthentications password,keyboard-interactive/);
});

test("prepareEtSshEnvironment keeps interactive authentication for an automatic jump host", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess-auto-interactive-jump", {
    hostname: "target.example",
    username: "alice",
    authMethod: "password",
    password: "target-secret",
    jumpHosts: [{
      hostname: "jump.example",
      username: "ops",
      authMethod: "auto",
    }],
  });

  const config = fs.readFileSync(path.join(env.env.HOME, ".ssh", "config"), "utf8");
  assert.match(config, /Host jump\.example[\s\S]*PreferredAuthentications publickey,password,keyboard-interactive/);
});

test("prepareEtSshEnvironment honors an explicit jump host etPort for --jport", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "h",
    username: "u",
    jumpHosts: [{ hostname: "jump.example", username: "ops", port: 2200, etPort: 9999 }],
  });
  assert.deepEqual(env.etJumpArgs, [
    "--jumphost",
    "ops@jump.example",
    "--jport",
    "9999",
  ]);
});

test("prepareEtSshEnvironment writes jump-host key + passphrase askpass into the Host block", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "h",
    username: "u",
    jumpHosts: [{
      hostname: "jump.example",
      username: "ops",
      privateKey: "-----BEGIN KEY-----\njump\n-----END KEY-----",
      passphrase: "jpp",
    }],
  });

  const config = fs.readFileSync(path.join(env.env.HOME, ".ssh", "config"), "utf8");
  // IdentityFile/IdentitiesOnly belong to the jump Host block only.
  assert.match(config, /Host jump\.example[\s\S]*\n {2}IdentityFile /);
  assert.match(config, /\n {2}IdentitiesOnly yes/);
  // The jump passphrase is answerable via the shared SSH_ASKPASS map.
  const map = JSON.parse(fs.readFileSync(env.env.NETCATTY_ET_ASKPASS_MAP, "utf8"));
  assert.ok(map.some((e) => e.type === "passphrase"));
});

test("prepareEtSshEnvironment quotes ssh config paths that contain spaces", (t) => {
  const { api, base } = makeApi(t);
  const keyPath = path.join(base, "My Keys", "jump key");
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, "key");

  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "dest.example",
    username: "u",
    jumpHosts: [{
      hostname: "jump.example",
      username: "ops",
      identityFilePaths: [keyPath],
    }],
  });

  const config = fs.readFileSync(path.join(env.env.HOME, ".ssh", "config"), "utf8");
  const configKeyPath = keyPath.replace(/\\/g, "/");
  assert.match(config, new RegExp(`IdentityFile "${configKeyPath.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}"`));
  assert.match(config, /UserKnownHostsFile ".*known_hosts"/);
});

test("prepareEtSshEnvironment scopes destination config under Host <dest> when a jump host is present", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "dest.example",
    username: "u",
    legacyAlgorithms: true,
    jumpHosts: [{ hostname: "jump.example", username: "ops" }],
  });

  const config = fs.readFileSync(path.join(env.env.HOME, ".ssh", "config"), "utf8");
  // The destination's legacy-algorithm lines must sit inside the `Host dest`
  // stanza (indented) so they don't leak onto the jump hop.
  assert.match(config, /Host dest\.example\n(?: {2}.*\n)*? {2}KexAlgorithms \+diffie-hellman-group14-sha1/);
});

test("prepareEtSshEnvironment returns no etJumpArgs without a jump host", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", { hostname: "h", username: "u" });
  assert.deepEqual(env.etJumpArgs, []);
});

test("prepareEtSshEnvironment rejects more than one jump host", (t) => {
  const { api } = makeApi(t);
  assert.throws(
    () => api.prepareEtSshEnvironment("sess1", {
      hostname: "h",
      username: "u",
      jumpHosts: [{ hostname: "j1" }, { hostname: "j2" }],
    }),
    /at most one jump host/,
  );
});

test("prepareEtSshEnvironment leaves no temp credential files when validation fails", (t) => {
  const { api, base } = makeApi(t);

  assert.throws(
    () => api.prepareEtSshEnvironment("sess1", {
      hostname: "h",
      username: "u",
      password: "target-secret",
      jumpHosts: [{ hostname: "j1" }, { hostname: "j2" }],
    }),
    /at most one jump host/,
  );

  assert.equal(fs.existsSync(path.join(base, "et-ssh-home-sess1")), false);
});

test("prepareEtSshEnvironment uses a persistent user known_hosts file", (t) => {
  const { api, base } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", { hostname: "host.example", username: "alice" });

  const knownHostsOption = env.sshOptions.find((option) => option.startsWith("UserKnownHostsFile="));
  assert.equal(
    knownHostsOption,
    `UserKnownHostsFile=${path.join(base, "home", ".ssh", "known_hosts").replace(/\\/g, "/")}`,
  );
  assert.equal(fs.existsSync(path.join(base, "et-ssh-home-sess1", ".ssh", "known_hosts")), false);
});

test("execOnEtSession requireTrustedHost uses strict host-key checking", async (t) => {
  let capturedArgs = null;
  const { api } = makeApi(t, {
    execFile: (_cmd, args, _opts, cb) => {
      capturedArgs = args;
      process.nextTick(() => cb(null, "", ""));
    },
  });
  const env = api.prepareEtSshEnvironment("sess1", { hostname: "host.example", username: "alice" });
  const session = {
    sshUserHost: env.userHost,
    sshOptions: env.sshOptions,
    sshEnv: env.env,
    externalAuthArtifacts: env.artifacts,
    externalAuthArtifactsCleaned: false,
    etStatsAuth: {
      knownHosts: [{
        hostname: "host.example",
        port: 22,
        keyType: "ssh-ed25519",
        publicKey: "vaultblob",
      }],
    },
  };

  await api.execOnEtSession(session, "echo ok", 1000, { requireTrustedHost: true });

  const joined = capturedArgs.join(" ");
  assert.match(joined, /StrictHostKeyChecking=yes/);
  assert.doesNotMatch(joined, /StrictHostKeyChecking=accept-new/);
  assert.ok(session.etStrictExecKnownHostsPath);
  const strictContent = fs.readFileSync(session.etStrictExecKnownHostsPath, "utf8");
  assert.match(strictContent, /host\.example ssh-ed25519 vaultblob/);
});

test("execOnEtSession forwards maxBuffer to the ssh execFile call", async (t) => {
  let capturedOptions = null;
  const { api } = makeApi(t, {
    execFile: (_cmd, _args, opts, cb) => {
      capturedOptions = opts;
      process.nextTick(() => cb(null, "", ""));
    },
  });
  const env = api.prepareEtSshEnvironment("sess1", { hostname: "host.example", username: "alice" });
  const session = {
    sshUserHost: env.userHost,
    sshOptions: env.sshOptions,
    sshEnv: env.env,
    externalAuthArtifacts: env.artifacts,
    externalAuthArtifactsCleaned: false,
  };

  await api.execOnEtSession(session, "echo ok", 1000, { maxBuffer: 64 * 1024 * 1024 });

  assert.equal(capturedOptions.maxBuffer, 64 * 1024 * 1024);
});

test("execOnEtSession keeps the default execFile maxBuffer when no override is provided", async (t) => {
  let capturedOptions = null;
  const { api } = makeApi(t, {
    execFile: (_cmd, _args, opts, cb) => {
      capturedOptions = opts;
      process.nextTick(() => cb(null, "", ""));
    },
  });
  const env = api.prepareEtSshEnvironment("sess1", { hostname: "host.example", username: "alice" });
  const session = {
    sshUserHost: env.userHost,
    sshOptions: env.sshOptions,
    sshEnv: env.env,
    externalAuthArtifacts: env.artifacts,
    externalAuthArtifactsCleaned: false,
  };

  await api.execOnEtSession(session, "echo ok", 1000);

  assert.equal(Object.hasOwn(capturedOptions, "maxBuffer"), false);
});

test("cleanupStaleEtTempDirs only removes Netcatty ET temp directories by prefix", (t) => {
  const { api, base } = makeApi(t);
  const staleEtDir = path.join(base, "et-ssh-home-old-session");
  const unrelatedDir = path.join(base, "cache-et-ssh-home-keep");
  fs.mkdirSync(staleEtDir, { recursive: true });
  fs.mkdirSync(unrelatedDir, { recursive: true });

  api.cleanupStaleEtTempDirs();

  assert.equal(fs.existsSync(staleEtDir), false);
  assert.equal(fs.existsSync(unrelatedDir), true);
});
