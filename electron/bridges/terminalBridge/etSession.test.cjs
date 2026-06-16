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
    sessions: new Map(),
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
    pty: {},
    sessionLogStreamManager: {},
    tempDirBridge,
    createZmodemSentry: () => ({}),
    trackSessionIdlePrompt: () => {},
    createPtyOutputBuffer: () => ({ bufferData() {}, flush() {} }),
    findExecutable: () => "ssh",
    bundledEtClient: () => null,
  });
  return { api, base };
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
  assert.match(config, new RegExp(`IdentityFile "${keyPath.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}"`));
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
