const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createEtSessionApi } = require("./etSession.cjs");

// Build an et session API wired to a hermetic temp HOME so prepareEtSshEnvironment
// is deterministic regardless of the developer's real ~/.ssh contents.
function makeApi(t) {
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

test("prepareEtSshEnvironment writes a ProxyCommand for a single jump host", (t) => {
  const { api } = makeApi(t);
  const env = api.prepareEtSshEnvironment("sess1", {
    hostname: "h",
    username: "u",
    jumpHosts: [{ hostname: "jump.example", username: "ops", port: 2200 }],
  });

  const config = fs.readFileSync(path.join(env.env.HOME, ".ssh", "config"), "utf8");
  assert.match(config, /ProxyCommand ssh /);
  assert.match(config, /ops@jump\.example/);
  assert.match(config, /StrictHostKeyChecking=accept-new/);
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
