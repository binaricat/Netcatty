const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { createEtSessionApi } = require("./etSession.cjs");

// Valid OpenSSH wire-format ssh-ed25519 public key blob (base64) for vault tests.
const VALID_ED25519_BLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";
const VALID_ED25519_PUB = `ssh-ed25519 ${VALID_ED25519_BLOB}`;

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

test("startEtSession passes the selected forwarding socket to the bundled ET client", async (t) => {
  const forwardingAgent = "/Users/alice/.bitwarden-ssh-agent.sock";
  let spawnArgs = null;
  const proc = {
    onData() {},
    onExit() {},
    write() {},
  };
  const { api } = makeApi(t, {
    bundledEtClient: () => "/fake/et",
    getAvailableForwardingAgentSocket: async () => forwardingAgent,
    pty: {
      spawn: (_command, args) => {
        spawnArgs = args;
        return proc;
      },
    },
    electronModule: { webContents: { fromId: () => null } },
    openTerminalOutputSession: () => {},
    selectZmodemUploadFiles: null,
    selectZmodemDownloadDirectory: null,
  });

  await api.startEtSession({ sender: { id: 7 } }, {
    sessionId: "sess-forwarding-socket",
    hostname: "host.example",
    username: "alice",
    useSshAgent: false,
    agentForwarding: true,
  });

  const forwardingFlag = spawnArgs.indexOf("-f");
  assert.notEqual(forwardingFlag, -1);
  assert.deepEqual(spawnArgs.slice(forwardingFlag, forwardingFlag + 3), [
    "-f",
    "--ssh-socket",
    forwardingAgent,
  ]);
});

test("ET PTY explicitly enables bundled ConPTY clear support only on Windows", async (t) => {
  const spawnForPlatform = async (platform) => {
    let spawnOptions = null;
    const processMock = Object.create(process);
    Object.defineProperty(processMock, "platform", { value: platform });
    const proc = {
      onData() {},
      onExit() {},
      write() {},
    };
    const { api } = makeApi(t, {
      process: processMock,
      bundledEtClient: () => "/fake/et",
      pty: {
        spawn: (_command, _args, options) => {
          spawnOptions = options;
          return proc;
        },
      },
      electronModule: { webContents: { fromId: () => null } },
      openTerminalOutputSession: () => {},
      selectZmodemUploadFiles: null,
      selectZmodemDownloadDirectory: null,
    });

    await api.startEtSession({ sender: { id: 7 } }, {
      sessionId: `sess-conpty-clear-${platform}`,
      hostname: "host.example",
      username: "alice",
    });
    return spawnOptions;
  };

  assert.equal((await spawnForPlatform("win32")).useConptyDll, true);
  assert.equal((await spawnForPlatform("linux")).useConptyDll, false);
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
  assert.doesNotMatch(forwardingConfig, /ForwardAgent/);
  assert.equal(forwardingEnv.SSH_AUTH_SOCK, undefined);

  const automaticJumpEnv = api.applyEtSshAgentEnvironment(
    { SSH_AUTH_SOCK: "/tmp/jump-agent.sock" },
    {
      authMethod: "password",
      useSshAgent: false,
      jumpHosts: [{ authMethod: "auto" }],
    },
  );
  assert.equal(automaticJumpEnv.SSH_AUTH_SOCK, process.env.SSH_AUTH_SOCK);
});

test("ET keeps its login agent separate from the discovered forwarding agent", async (t) => {
  const localAgent = "/private/tmp/com.apple.launchd.test/Listeners";
  const forwardingAgent = "/Users/alice/.bitwarden-ssh-agent.sock";
  const { api } = makeApi(t, {
    prepareSystemSshAgentForAuth: async () => {},
    getAvailableAgentSocket: async () => localAgent,
    getAvailableForwardingAgentSocket: async () => forwardingAgent,
    process: { ...process, env: { SSH_AUTH_SOCK: localAgent } },
  });

  for (const useSshAgent of [false, undefined, true]) {
    const prepared = await api.prepareEtSshAgentOptions({
      hostname: `host-${String(useSshAgent)}.example`,
      username: "alice",
      useSshAgent,
      agentForwarding: true,
    });
    const env = api.applyEtSshAgentEnvironment(
      { SSH_AUTH_SOCK: "/tmp/remote-agent.sock" },
      prepared,
    );
    assert.equal(prepared._resolvedSshAgentSocket, useSshAgent === true ? localAgent : undefined);
    assert.equal(prepared._resolvedForwardingAgentSocket, forwardingAgent);
    assert.equal(env.SSH_AUTH_SOCK, useSshAgent === false ? undefined : localAgent);
  }
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

test("prepareEtSshAgentOptions releases earlier FIDO leases when a later hop fails", async (t) => {
  let releaseCount = 0;
  const { api } = makeApi(t, {
    prepareSystemSshAgentForAuth: async (options) => {
      if (options.hostname === "jump.example") {
        const error = new Error("Identity selector unavailable");
        error.code = "ERR_SSH_AGENT_IDENTITY_SELECTOR_UNAVAILABLE";
        throw error;
      }
      return {
        _releaseNetcattyFidoAgent: () => { releaseCount += 1; },
      };
    },
    getAvailableAgentSocket: async (identityAgent) => identityAgent,
  });

  await assert.rejects(
    () => api.prepareEtSshAgentOptions({
      hostname: "dest.example",
      username: "alice",
      useSshAgent: true,
      identityAgent: "/tmp/target.sock",
      jumpHosts: [{
        hostname: "jump.example",
        username: "ops",
        useSshAgent: true,
        identityAgent: "/tmp/jump.sock",
        identitiesOnly: true,
        agentPublicKeys: ["ssh-ed25519 AAAAJUMPSELECTED"],
      }],
    }),
    (error) => error?.code === "ERR_SSH_AGENT_IDENTITY_SELECTOR_UNAVAILABLE",
  );
  assert.equal(releaseCount, 1);
});

test("prepareEtSshAgentOptions releases the current hop FIDO agent when forwarding setup fails", async (t) => {
  let releaseCount = 0;
  const { api } = makeApi(t, {
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
    () => api.prepareEtSshAgentOptions({
      hostname: "dest.example",
      username: "alice",
      useSshAgent: true,
      agentForwarding: true,
    }),
    (error) => error?.code === "ERR_SSH_AGENT_NATIVE_UNSUPPORTED",
  );
  assert.equal(releaseCount, 1);
});

test("startEtSession exposes a one-shot FIDO release that survives map deletion", async (t) => {
  let releaseCount = 0;
  let onExitHandler = null;
  const flushCallbacks = [];
  const proc = {
    onData() {},
    onExit(handler) { onExitHandler = handler; },
    write() {},
    kill() {},
  };
  const { api, sessions } = makeApi(t, {
    bundledEtClient: () => "/fake/et",
    prepareSystemSshAgentForAuth: async () => ({
      _releaseNetcattyFidoAgent: () => { releaseCount += 1; },
    }),
    getAvailableAgentSocket: async () => "/tmp/login-agent.sock",
    createPtyOutputBuffer: () => ({
      bufferData() {},
      flush() {},
      flushPaced(cb) { flushCallbacks.push(cb); },
      discard() {},
    }),
    pty: { spawn: () => proc },
    electronModule: { webContents: { fromId: () => null } },
    openTerminalOutputSession: () => {},
    closeTerminalOutputSession: () => {},
    selectZmodemUploadFiles: null,
    selectZmodemDownloadDirectory: null,
  });

  await api.startEtSession({ sender: { id: 7 } }, {
    sessionId: "sess-fido-close",
    hostname: "host.example",
    username: "alice",
    useSshAgent: true,
  });

  const session = sessions.get("sess-fido-close");
  assert.equal(typeof session.releaseNetcattyFidoAgents, "function");

  // Explicit close deletes the session before PTY onExit runs.
  sessions.delete("sess-fido-close");
  assert.ok(onExitHandler);
  onExitHandler({ exitCode: 0 });
  for (const cb of flushCallbacks) cb();
  assert.equal(releaseCount, 1);

  // closeSession / quit may also invoke the session-stored one-shot release.
  session.releaseNetcattyFidoAgents();
  assert.equal(releaseCount, 1);
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
  // Host-key policy is enforced via --ssh-option (not Host config blocks).
  assert.ok(env.sshOptions.includes("StrictHostKeyChecking=accept-new"));
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
  // Host-key paths ride --ssh-option; IdentityFile with spaces is still quoted in config.
  assert.ok(env.sshOptions.some((option) => option.startsWith("UserKnownHostsFile=")));
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

test("prepareEtSshEnvironment injects vault known_hosts for key-change checks", (t) => {
  const { api, base } = makeApi(t);
  // Seed a conflicting system pin so we can assert vault wins.
  const systemKh = path.join(base, "home", ".ssh", "known_hosts");
  fs.mkdirSync(path.dirname(systemKh), { recursive: true });
  fs.writeFileSync(systemKh, "host.example ssh-ed25519 AAASYSTEM\n");

  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "host.example",
    username: "alice",
    knownHosts: [{
      hostname: "host.example",
      port: 22,
      keyType: "ssh-ed25519",
      publicKey: VALID_ED25519_PUB,
    }],
  });

  const userOption = env.sshOptions.find((option) => option.startsWith("UserKnownHostsFile="));
  const globalOption = env.sshOptions.find((option) => option.startsWith("GlobalKnownHostsFile="));
  assert.ok(userOption, "expected UserKnownHostsFile for vault keys");
  assert.ok(globalOption, "expected GlobalKnownHostsFile for vault keys");
  const trustPath = userOption.slice("UserKnownHostsFile=".length);
  assert.equal(trustPath, globalOption.slice("GlobalKnownHostsFile=".length));
  assert.ok(fs.existsSync(trustPath));
  const trustContent = fs.readFileSync(trustPath, "utf8");
  assert.match(trustContent, new RegExp(`host\\.example ssh-ed25519 ${VALID_ED25519_BLOB}`));
  // System pin for the same host must not remain (would override vault).
  assert.doesNotMatch(trustContent, /AAASYSTEM/);
  assert.ok(env.sshOptions.includes("StrictHostKeyChecking=accept-new"));
  assert.ok(trustPath.startsWith(path.join(base, "et-ssh-home-sess1")));
});

test("prepareEtSshEnvironment keeps persistent known_hosts when vault does not pin target", (t) => {
  const { api, base } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "target.example",
    username: "alice",
    knownHosts: [{
      hostname: "unrelated.example",
      keyType: "ssh-ed25519",
      publicKey: VALID_ED25519_PUB,
    }],
  });

  const userOption = env.sshOptions.find((option) => option.startsWith("UserKnownHostsFile="));
  assert.ok(userOption);
  assert.equal(
    userOption,
    `UserKnownHostsFile=${path.join(base, "home", ".ssh", "known_hosts").replace(/\\/g, "/")}`,
  );
  // Must not force a session-local UserKnownHostsFile for unrelated vault pins.
  assert.equal(
    env.sshOptions.some((option) => option.startsWith("GlobalKnownHostsFile=")),
    false,
  );
});

test("prepareEtSshEnvironment disables host-key checks when verifyHostKeys is false", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "host.example",
    username: "alice",
    verifyHostKeys: false,
    knownHosts: [{
      hostname: "host.example",
      keyType: "ssh-ed25519",
      publicKey: VALID_ED25519_PUB,
    }],
  });

  assert.ok(env.sshOptions.includes("StrictHostKeyChecking=no"));
  assert.equal(
    env.sshOptions.filter((option) => option.startsWith("StrictHostKeyChecking=")).length,
    1,
  );
  assert.doesNotMatch(env.sshOptions.join("\n"), /StrictHostKeyChecking=accept-new/);

  const userKh = env.sshOptions.find((option) => option.startsWith("UserKnownHostsFile="));
  const globalKh = env.sshOptions.find((option) => option.startsWith("GlobalKnownHostsFile="));
  assert.ok(userKh, "expected neutralized UserKnownHostsFile");
  assert.ok(globalKh, "expected neutralized GlobalKnownHostsFile");
  assert.equal(userKh.slice("UserKnownHostsFile=".length), globalKh.slice("GlobalKnownHostsFile=".length));
  const emptyPath = userKh.slice("UserKnownHostsFile=".length);
  assert.ok(fs.existsSync(emptyPath));
  assert.equal(fs.readFileSync(emptyPath, "utf8").trim(), "");
  // Must not keep loading the stale vault pin when verification is off.
  assert.equal(fs.readFileSync(emptyPath, "utf8").trim(), "");
});

test("prepareEtSshEnvironment applies vault host-key policy via ssh-option for jump hosts", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "target.example",
    username: "alice",
    knownHosts: [{
      hostname: "jump.example",
      keyType: "ssh-ed25519",
      publicKey: VALID_ED25519_PUB,
    }],
    jumpHosts: [{
      hostname: "jump.example",
      username: "jumpuser",
      authMethod: "password",
      password: "secret",
    }],
  });

  // Destination is not vault-pinned: keep persistent known_hosts via --ssh-option.
  assert.ok(env.sshOptions.includes("StrictHostKeyChecking=accept-new"));
  assert.ok(env.sshOptions.some((option) => option.startsWith("UserKnownHostsFile=")));
  assert.equal(
    env.sshOptions.some((option) => option.startsWith("GlobalKnownHostsFile=")),
    false,
  );
  // Jump hop: Host block carries the vault-authoritative snapshot.
  const config = fs.readFileSync(path.join(env.env.HOME, ".ssh", "config"), "utf8");
  const jumpBlock = config.slice(config.indexOf("Host jump.example"));
  assert.match(jumpBlock, /UserKnownHostsFile /);
  assert.match(jumpBlock, /GlobalKnownHostsFile /);
  assert.match(jumpBlock, /StrictHostKeyChecking /);
  assert.match(jumpBlock, /KnownHostsCommand /);
  const jumpTrustMatch = jumpBlock.match(/UserKnownHostsFile "?([^"\n]+)"?/);
  assert.ok(jumpTrustMatch);
  const jumpTrustPath = jumpTrustMatch[1].trim();
  assert.match(
    fs.readFileSync(jumpTrustPath, "utf8"),
    new RegExp(`jump\\.example ssh-ed25519 ${VALID_ED25519_BLOB}`),
  );
});

test("prepareEtSshEnvironment merges vault pins for target hop with jump present", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "target.example",
    username: "alice",
    knownHosts: [{
      hostname: "target.example",
      keyType: "ssh-ed25519",
      publicKey: VALID_ED25519_PUB,
    }],
    jumpHosts: [{
      hostname: "jump.example",
      username: "jumpuser",
      authMethod: "password",
      password: "secret",
    }],
  });

  assert.ok(env.sshOptions.some((option) => option.startsWith("GlobalKnownHostsFile=")));
  const trustPath = env.sshOptions
    .find((option) => option.startsWith("UserKnownHostsFile="))
    .slice("UserKnownHostsFile=".length);
  assert.match(
    fs.readFileSync(trustPath, "utf8"),
    new RegExp(`target\\.example ssh-ed25519 ${VALID_ED25519_BLOB}`),
  );
});

test("execOnEtSession honors session StrictHostKeyChecking=no over accept-new default", async (t) => {
  let capturedArgs = null;
  const { api } = makeApi(t, {
    execFile: (_cmd, args, _opts, cb) => {
      capturedArgs = args;
      process.nextTick(() => cb(null, "", ""));
    },
  });
  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "host.example",
    username: "alice",
    verifyHostKeys: false,
  });
  const session = {
    sshUserHost: env.userHost,
    sshOptions: env.sshOptions,
    sshEnv: env.env,
    externalAuthArtifacts: env.artifacts,
    externalAuthArtifactsCleaned: false,
  };

  await api.execOnEtSession(session, "echo ok", 1000);

  const joined = capturedArgs.join(" ");
  assert.match(joined, /StrictHostKeyChecking=no/);
  // OpenSSH keeps the first value; accept-new must not precede =no.
  const firstStrict = capturedArgs.findIndex(
    (arg, index) => arg === "-o" && String(capturedArgs[index + 1] || "").startsWith("StrictHostKeyChecking="),
  );
  assert.ok(firstStrict >= 0);
  assert.equal(capturedArgs[firstStrict + 1], "StrictHostKeyChecking=no");
  assert.doesNotMatch(joined, /StrictHostKeyChecking=accept-new/);
});

test("execOnEtSession forces the session-generated SSH config with -F", async (t) => {
  let capturedArgs = null;
  const { api } = makeApi(t, {
    execFile: (_cmd, args, _opts, cb) => {
      capturedArgs = args;
      process.nextTick(() => cb(null, "", ""));
    },
  });
  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "target.example",
    username: "alice",
    jumpHosts: [{
      hostname: "jump.example",
      username: "ops",
      authMethod: "password",
      password: "secret",
    }],
  });
  const session = {
    sshUserHost: env.userHost,
    sshOptions: env.sshOptions,
    sshEnv: env.env,
    externalAuthArtifacts: env.artifacts,
    externalAuthArtifactsCleaned: false,
  };

  await api.execOnEtSession(session, "echo ok", 1000);

  const fIdx = capturedArgs.indexOf("-F");
  assert.ok(fIdx >= 0, "expected -F session config");
  assert.match(capturedArgs[fIdx + 1], /[\\/]\.ssh[\\/]config$/);
});

test("prepareEtSshEnvironment injects a PATH ssh wrapper that forces -F", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "target.example",
    username: "alice",
    jumpHosts: [{
      hostname: "jump.example",
      username: "ops",
      authMethod: "password",
      password: "secret",
    }],
  });

  const pathKey = Object.keys(env.env).find((k) => k.toLowerCase() === "path");
  assert.ok(pathKey, "expected PATH override for ssh wrapper");
  const wrapperDir = env.env[pathKey].split(path.delimiter)[0];
  const wrapperName = process.platform === "win32" ? "ssh.cmd" : "ssh";
  const wrapperPath = path.join(wrapperDir, wrapperName);
  assert.ok(fs.existsSync(wrapperPath), "expected ssh wrapper on PATH");
  const wrapperBody = fs.readFileSync(wrapperPath, "utf8");
  assert.match(wrapperBody, /-F/);
  assert.match(wrapperBody, /\.ssh[\\/]config/);
  // Must invoke an absolute OpenSSH binary, not a bare `ssh` that would
  // recurse into this wrapper via PATH.
  if (process.platform !== "win32") {
    assert.match(wrapperBody, /exec '\/[^']+\/ssh'/);
  }
});

test("prepareEtSshEnvironment includes the real user SSH config under -F", (t) => {
  const { api, base } = makeApi(t);
  const realUserConfig = path.join(base, "home", ".ssh", "config");
  fs.mkdirSync(path.dirname(realUserConfig), { recursive: true });
  fs.writeFileSync(
    realUserConfig,
    "Host work\n  HostName server.example\n  User deploy\n",
  );

  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "target.example",
    username: "alice",
    // Force a generated session config (jump host writes Host blocks).
    jumpHosts: [{
      hostname: "jump.example",
      username: "ops",
      authMethod: "password",
      password: "secret",
    }],
  });

  const sessionConfigPath = path.join(env.env.HOME, ".ssh", "config");
  assert.ok(fs.existsSync(sessionConfigPath));
  const sessionConfig = fs.readFileSync(sessionConfigPath, "utf8");
  // Session Host blocks come first (first-obtained-value keeps overrides).
  const hostIdx = sessionConfig.indexOf("Host target.example");
  const matchAllIdx = sessionConfig.indexOf("Match all");
  const includeIdx = sessionConfig.indexOf("Include ");
  assert.ok(hostIdx >= 0, "expected session Host block");
  assert.ok(matchAllIdx > hostIdx, "Match all must reset Host context after session blocks");
  assert.ok(includeIdx > matchAllIdx, "Include must follow Match all");
  // Real user config is preserved so HostName aliases still resolve.
  const normalizedUserConfig = realUserConfig.replace(/\\/g, "/");
  assert.match(
    sessionConfig,
    new RegExp(`Include ["']?${normalizedUserConfig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
});

test("prepareEtSshEnvironment does not freeze jump HostName to the alias token", (t) => {
  const { api, base } = makeApi(t);
  const realUserConfig = path.join(base, "home", ".ssh", "config");
  fs.mkdirSync(path.dirname(realUserConfig), { recursive: true });
  fs.writeFileSync(
    realUserConfig,
    "Host bastion\n  HostName 10.0.0.5\n  User jumpuser\n",
  );

  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "target.example",
    username: "alice",
    jumpHosts: [{
      hostname: "bastion",
      username: "ops",
      authMethod: "password",
      password: "secret",
    }],
  });

  const sessionConfig = fs.readFileSync(path.join(env.env.HOME, ".ssh", "config"), "utf8");
  const jumpBlockStart = sessionConfig.indexOf("Host bastion");
  assert.ok(jumpBlockStart >= 0, "expected Host bastion block");
  const afterJump = sessionConfig.slice(jumpBlockStart);
  const nextSection = afterJump.search(/\n(?:Host |Match )/);
  const jumpBlock = nextSection >= 0 ? afterJump.slice(0, nextSection) : afterJump;

  // Freezing HostName bastion would win over Include's HostName 10.0.0.5.
  assert.doesNotMatch(jumpBlock, /^\s*HostName\s+/m);
  assert.match(jumpBlock, /^\s*User ops\s*$/m);
  assert.match(sessionConfig, /Include /);
  assert.match(sessionConfig, /Match all/);
});

test("prepareEtSshEnvironment prepends ssh wrapper onto session PATH", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "target.example",
    username: "alice",
    env: { PATH: "/custom/bin:/usr/bin" },
    jumpHosts: [{
      hostname: "jump.example",
      username: "ops",
      authMethod: "password",
      password: "secret",
    }],
  });
  const pathKey = Object.keys(env.env).find((k) => k.toLowerCase() === "path");
  assert.ok(pathKey);
  assert.match(env.env[pathKey], /^[^:]+\/bin:\/custom\/bin:\/usr\/bin$/);
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
      hostname: "host.example",
      port: 22,
      username: "alice",
      knownHosts: [{
        hostname: "host.example",
        port: 22,
        keyType: "ssh-ed25519",
        publicKey: VALID_ED25519_PUB,
      }],
    },
  };

  await api.execOnEtSession(session, "echo ok", 1000, { requireTrustedHost: true });

  const joined = capturedArgs.join(" ");
  assert.match(joined, /StrictHostKeyChecking=yes/);
  assert.doesNotMatch(joined, /StrictHostKeyChecking=accept-new/);
  assert.ok(session.etStrictExecKnownHostsPath);
  const strictContent = fs.readFileSync(session.etStrictExecKnownHostsPath, "utf8");
  assert.match(strictContent, new RegExp(`host\\.example ssh-ed25519 ${VALID_ED25519_BLOB}`));
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
