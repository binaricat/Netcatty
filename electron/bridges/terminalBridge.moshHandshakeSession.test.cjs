const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

class FakePty {
  constructor(command, args, opts) {
    this.command = command;
    this.args = args;
    this.opts = opts;
    this.pid = FakePty.nextPid += 1;
    this.dataHandlers = [];
    this.exitHandlers = [];
    this.writes = [];
    this.resizes = [];
    this.killed = false;
  }

  onData(handler) {
    this.dataHandlers.push(handler);
  }

  onExit(handler) {
    this.exitHandlers.push(handler);
  }

  write(data) {
    this.writes.push(data);
  }

  resize(cols, rows) {
    this.resizes.push({ cols, rows });
  }

  kill() {
    this.killed = true;
  }

  emitData(data) {
    for (const handler of this.dataHandlers) handler(data);
  }

  emitExit(evt) {
    for (const handler of this.exitHandlers) handler(evt);
  }
}
FakePty.nextPid = 1000;

function writeExecutable(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(filePath, 0o755);
}

function loadBridgeWithFakePty(spawns) {
  const bridgePath = require.resolve("./terminalBridge.cjs");
  delete require.cache[bridgePath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "node-pty") {
      return {
        spawn(command, args, opts) {
          const pty = new FakePty(command, args, opts);
          spawns.push(pty);
          return pty;
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("./terminalBridge.cjs");
  } finally {
    Module._load = originalLoad;
  }
}

function makeHarness(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mosh-session-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const binDir = path.join(tmp, "bin");
  const sshPath = path.join(binDir, "ssh");
  const moshClientPath = path.join(tmp, "resources", "mosh", "linux-x64", "mosh-client");
  writeExecutable(sshPath);
  writeExecutable(moshClientPath);

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;
  t.after(() => { process.env.PATH = oldPath; });

  const spawns = [];
  const bridge = loadBridgeWithFakePty(spawns);
  const sessions = new Map();
  const sent = [];
  bridge.init({
    sessions,
    electronModule: {
      webContents: {
        fromId() {
          return { send: (channel, payload) => sent.push({ channel, payload }) };
        },
      },
    },
  });

  return {
    bridge,
    tmp,
    sshPath,
    sessions,
    sent,
    spawns,
    options: {
      sessionId: "mosh-test-session",
      hostname: "example.com",
      username: "alice",
      cols: 80,
      rows: 24,
    },
    event: { sender: { id: 42 } },
    lookupOpts: {
      platform: "linux",
      arch: "x64",
      projectRoot: tmp,
      resourcesPath: path.join(tmp, "missing"),
    },
  };
}

test("startMoshSession handshake path returns the same shape as the legacy path", async (t) => {
  const h = makeHarness(t);
  const result = await h.bridge.startMoshSession(h.event, h.options, { moshClientLookup: h.lookupOpts });
  assert.deepEqual(result, { sessionId: "mosh-test-session" });
});

test("Mosh PTYs explicitly enable bundled ConPTY clear support only on Windows", async (t) => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  const startAndSwap = async (platform) => {
    const h = makeHarness(t);
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });

    await h.bridge.startMoshSession(h.event, h.options, {
      moshClientLookup: h.lookupOpts,
      findExecutable: () => h.sshPath,
    });
    h.spawns[0].emitData(
      "MOSH IP 203.0.113.8\r\nMOSH CONNECT 60002 ABCDEFGHIJKLMNOPQRSTUV==\r\n",
    );
    h.spawns[0].emitExit({ exitCode: 0, signal: 0 });
    return h.spawns;
  };

  try {
    const windowsSpawns = await startAndSwap("win32");
    assert.equal(windowsSpawns.length, 2);
    assert.equal(windowsSpawns[0].opts.useConptyDll, true);
    assert.equal(windowsSpawns[1].opts.useConptyDll, true);

    const linuxSpawns = await startAndSwap("linux");
    assert.equal(linuxSpawns.length, 2);
    assert.equal(linuxSpawns[0].opts.useConptyDll, false);
    assert.equal(linuxSpawns[1].opts.useConptyDll, false);
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
});

test("startMoshSession offers all locale settings to mosh-server without exporting them through SSH", async (t) => {
  const h = makeHarness(t);
  h.options.env = {
    LANG: "C",
    LANGUAGE: "zh_CN:zh",
    LC_CTYPE: "ja_JP.UTF-8",
    LC_ALL: "zh_CN.UTF-8",
  };

  await h.bridge.startMoshSession(h.event, h.options, { moshClientLookup: h.lookupOpts });

  assert.equal(h.spawns[0].opts.env.LANG, undefined);
  assert.equal(h.spawns[0].opts.env.LANGUAGE, undefined);
  assert.equal(h.spawns[0].opts.env.LC_CTYPE, undefined);
  assert.equal(h.spawns[0].opts.env.LC_ALL, undefined);
  const remote = h.spawns[0].args.at(-1);
  assert.ok(remote.indexOf("LANG=C") < remote.indexOf("LANGUAGE=zh_CN:zh"));
  assert.ok(remote.indexOf("LANGUAGE=zh_CN:zh") < remote.indexOf("LC_CTYPE=ja_JP.UTF-8"));
  assert.ok(remote.indexOf("LC_CTYPE=ja_JP.UTF-8") < remote.indexOf("LC_ALL=zh_CN.UTF-8"));
  assert.equal((remote.match(/ -l /g) || []).length, 4);
});

test("startMoshSession keeps the original hostname as a UDP fallback", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(h.event, h.options, { moshClientLookup: h.lookupOpts });

  h.spawns[0].emitData(
    "MOSH IP 203.0.113.8\r\nMOSH CONNECT 60002 ABCDEFGHIJKLMNOPQRSTUV==\r\n",
  );
  h.spawns[0].emitExit({ exitCode: 0, signal: 0 });

  assert.equal(h.spawns[1].args[0], "203.0.113.8");
  assert.equal(h.spawns[1].opts.env.MOSH_FALLBACK_HOST, "example.com");
});

test("startMoshSession uses bundled mosh-client even when PATH contains another client", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mosh-session-path-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const binDir = path.join(tmp, "bin");
  const sshPath = path.join(binDir, "ssh");
  const pathMoshClient = path.join(binDir, "mosh-client");
  const bundledMoshClient = path.join(tmp, "resources", "mosh", "linux-x64", "mosh-client");
  writeExecutable(sshPath);
  writeExecutable(pathMoshClient);
  writeExecutable(bundledMoshClient);

  const oldPath = process.env.PATH;
  process.env.PATH = "";
  t.after(() => { process.env.PATH = oldPath; });

  const spawns = [];
  const bridge = loadBridgeWithFakePty(spawns);
  const sessions = new Map();
  const sent = [];
  bridge.init({
    sessions,
    electronModule: {
      webContents: {
        fromId() {
          return { send: (channel, payload) => sent.push({ channel, payload }) };
        },
      },
    },
  });

  const result = await bridge.startMoshSession(
    { sender: { id: 42 } },
    {
      sessionId: "mosh-path-session",
      hostname: "example.com",
      username: "alice",
      cols: 80,
      rows: 24,
      env: { PATH: binDir },
    },
    {
      moshClientLookup: {
        platform: "linux",
        arch: "x64",
        projectRoot: tmp,
        resourcesPath: path.join(tmp, "missing"),
      },
    },
  );

  assert.deepEqual(result, { sessionId: "mosh-path-session" });
  assert.equal(spawns[0].command, sshPath);

  spawns[0].emitData("MOSH CONNECT 60002 ABCDEFGHIJKLMNOPQRSTUV==\r\n");
  spawns[0].emitExit({ exitCode: 0, signal: 0 });

  assert.equal(spawns[1].command, bundledMoshClient);
});

test("startMoshSession handshake path sends the existing exit event on failure", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(h.event, h.options, { moshClientLookup: h.lookupOpts });

  h.spawns[0].emitExit({ exitCode: 255, signal: 0 });

  const exit = h.sent.find((evt) => evt.channel === "netcatty:exit");
  assert.ok(exit);
  assert.equal(exit.payload.sessionId, "mosh-test-session");
  assert.equal(exit.payload.reason, "error");
  assert.match(
    String(exit.payload.error || ""),
    /no MOSH CONNECT/i,
    "exit payload should name the handshake failure",
  );
  const dataChunks = h.sent
    .filter((evt) => evt.channel === "netcatty:data" || evt.channel === "netcatty:session-data")
    .map((evt) => String(evt.payload?.data ?? evt.payload ?? ""));
  assert.ok(
    dataChunks.some((chunk) => /Mosh handshake failed/i.test(chunk)),
    "renderer should receive an explicit handshake-failure hint",
  );
  const handshakeHint = dataChunks.find((chunk) => /Mosh handshake failed/i.test(chunk));
  assert.match(
    handshakeHint,
    /UDP client was not started/i,
    "the hint should explain that UDP has not started yet",
  );
  assert.doesNotMatch(
    handshakeHint,
    /UDP ports.*reachable/i,
    "an SSH bootstrap failure must not send users to UDP diagnostics",
  );
});

test("startMoshSession writes the saved password when ssh prompts for one", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(
    h.event,
    { ...h.options, password: "saved-secret" },
    { moshClientLookup: h.lookupOpts },
  );

  h.spawns[0].emitData("(alice@example.com) Password:");

  assert.deepEqual(h.spawns[0].writes, ["saved-secret\r"]);
});

test("startMoshSession password-only mode disables public-key authentication", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(
    h.event,
    { ...h.options, authMethod: "password", password: "saved-secret", useSshAgent: false },
    { moshClientLookup: h.lookupOpts },
  );

  assert.ok(h.spawns[0].args.includes("PubkeyAuthentication=no"));
  assert.ok(h.spawns[0].args.includes("PreferredAuthentications=password,keyboard-interactive"));
});

test("startMoshSession MFA password mode prefers keyboard-interactive", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(
    h.event,
    {
      ...h.options,
      authMethod: "password",
      password: "saved-secret",
      requiresMfa: true,
      useSshAgent: false,
    },
    { moshClientLookup: h.lookupOpts },
  );

  assert.ok(h.spawns[0].args.includes("PubkeyAuthentication=no"));
  assert.ok(h.spawns[0].args.includes("PreferredAuthentications=keyboard-interactive,password"));
});

test("startMoshSession MFA auto mode keeps publickey first and prefers keyboard-interactive", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(
    h.event,
    {
      ...h.options,
      authMethod: "auto",
      password: "saved-secret",
      requiresMfa: true,
      identityFilePaths: [path.join(os.tmpdir(), "netcatty-mosh-mfa-id_ed25519")],
      useSshAgent: false,
    },
    { moshClientLookup: h.lookupOpts },
  );

  assert.ok(h.spawns[0].args.includes("PreferredAuthentications=publickey,keyboard-interactive,password"));
});

test("startMoshSession key mode never probes unrelated default identities", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(
    h.event,
    {
      ...h.options,
      authMethod: "key",
      password: "fallback-secret",
      useSshAgent: false,
    },
    { moshClientLookup: h.lookupOpts },
  );

  assert.ok(h.spawns[0].args.includes("IdentityFile=none"));
  assert.ok(h.spawns[0].args.includes("IdentitiesOnly=yes"));
  assert.equal(h.spawns[0].args.includes("PubkeyAuthentication=no"), false);
});

test("startMoshSession writes the saved password when ConPTY appends cursor controls to the prompt", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(
    h.event,
    { ...h.options, password: "saved-secret" },
    { moshClientLookup: h.lookupOpts },
  );

  h.spawns[0].emitData("alice@example.com's password: \x1b[?25h");

  assert.deepEqual(h.spawns[0].writes, ["saved-secret\r"]);
});

test("startMoshSession passes vault private keys to ssh via a temp identity file", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(
    h.event,
    {
      ...h.options,
      keyId: "key-1",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----",
      password: "wrong-password",
    },
    { moshClientLookup: h.lookupOpts },
  );

  const keyFlagIndex = h.spawns[0].args.indexOf("-i");
  assert.notEqual(keyFlagIndex, -1);
  const keyPath = h.spawns[0].args[keyFlagIndex + 1];
  assert.equal(fs.existsSync(keyPath), true);
  assert.equal(h.spawns[0].args.includes("IdentitiesOnly=yes"), true);
  assert.equal(h.spawns[0].args.includes("alice@example.com"), true);

  h.spawns[0].emitExit({ exitCode: 255, signal: 0 });
  assert.equal(fs.existsSync(keyPath), false);
});

test("startMoshSession passes certificates with reference identity files", async (t) => {
  const h = makeHarness(t);
  const referenceKeyPath = path.join(os.tmpdir(), "netcatty-reference-id_ed25519");
  await h.bridge.startMoshSession(
    h.event,
    {
      ...h.options,
      keyId: "reference-key-1",
      identityFilePaths: [referenceKeyPath],
      certificate: "ssh-ed25519-cert-v01@openssh.com AAAATEST netcatty-cert",
    },
    { moshClientLookup: h.lookupOpts },
  );

  const keyFlagIndex = h.spawns[0].args.indexOf("-i");
  assert.notEqual(keyFlagIndex, -1);
  assert.equal(h.spawns[0].args[keyFlagIndex + 1], referenceKeyPath);
  assert.equal(h.spawns[0].args.includes("IdentitiesOnly=yes"), true);

  const certFlagIndex = h.spawns[0].args.findIndex((arg) =>
    typeof arg === "string" && arg.startsWith("CertificateFile=")
  );
  assert.notEqual(certFlagIndex, -1);
  const certPath = h.spawns[0].args[certFlagIndex].slice("CertificateFile=".length);
  assert.equal(fs.existsSync(certPath), true);
  assert.match(fs.readFileSync(certPath, "utf8"), /netcatty-cert/);

  h.spawns[0].emitExit({ exitCode: 255, signal: 0 });
  assert.equal(fs.existsSync(certPath), false);
});

test("startMoshSession uses unique temp identity files for concurrent sessions with the same key", async (t) => {
  const h = makeHarness(t);
  const authOptions = {
    keyId: "key-1",
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----",
  };

  await h.bridge.startMoshSession(
    h.event,
    { ...h.options, ...authOptions },
    { moshClientLookup: h.lookupOpts },
  );
  await h.bridge.startMoshSession(
    h.event,
    { ...h.options, ...authOptions, sessionId: "mosh-test-session-2" },
    { moshClientLookup: h.lookupOpts },
  );

  const firstKeyPath = h.spawns[0].args[h.spawns[0].args.indexOf("-i") + 1];
  const secondKeyPath = h.spawns[1].args[h.spawns[1].args.indexOf("-i") + 1];
  assert.notEqual(firstKeyPath, secondKeyPath);
  assert.equal(fs.existsSync(firstKeyPath), true);
  assert.equal(fs.existsSync(secondKeyPath), true);

  h.spawns[0].emitExit({ exitCode: 255, signal: 0 });
  assert.equal(fs.existsSync(firstKeyPath), false);
  assert.equal(fs.existsSync(secondKeyPath), true);

  h.spawns[1].emitExit({ exitCode: 255, signal: 0 });
  assert.equal(fs.existsSync(secondKeyPath), false);
});

test("closeSession removes Mosh temp identity files even before ssh exits", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(
    h.event,
    {
      ...h.options,
      keyId: "key-1",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----",
    },
    { moshClientLookup: h.lookupOpts },
  );

  const keyPath = h.spawns[0].args[h.spawns[0].args.indexOf("-i") + 1];
  assert.equal(fs.existsSync(keyPath), true);

  h.bridge.closeSession(h.event, { sessionId: "mosh-test-session" });
  assert.equal(fs.existsSync(keyPath), false);
});

test("startMoshSession writes the saved passphrase when ssh prompts for the temp key", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(
    h.event,
    {
      ...h.options,
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----",
      passphrase: "key-passphrase",
    },
    { moshClientLookup: h.lookupOpts },
  );

  h.spawns[0].emitData("Enter passphrase for key 'mosh-auth-key-1.pem':");

  assert.deepEqual(h.spawns[0].writes, ["key-passphrase\r"]);
});

test("startMoshSession swaps to mosh-client when MOSH CONNECT has no trailing newline", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(h.event, h.options, { moshClientLookup: h.lookupOpts });
  // ConPTY / OpenSSH often exit immediately after printing the magic line
  // with no final newline. The sniffer must flush on ssh exit (issue #2025).
  h.spawns[0].emitData("MOSH CONNECT 60002 ABCDEFGHIJKLMNOPQRSTUV==");
  h.spawns[0].emitExit({ exitCode: 0, signal: 0 });
  assert.equal(h.spawns.length, 2);
  assert.deepEqual(h.spawns[1].args.slice(-2), [h.options.hostname, "60002"]);
});

test("startMoshSession handshake path sends the existing exit event after mosh-client exits", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(h.event, h.options, { moshClientLookup: h.lookupOpts });

  h.spawns[0].emitData("MOSH CONNECT 60002 ABCDEFGHIJKLMNOPQRSTUV==\r\n");
  h.spawns[0].emitExit({ exitCode: 0, signal: 0 });

  assert.equal(h.spawns.length, 2);
  h.spawns[1].emitExit({ exitCode: 0, signal: 0 });

  const exit = h.sent.find((evt) => evt.channel === "netcatty:exit");
  assert.ok(exit);
  assert.equal(exit.payload.sessionId, "mosh-test-session");
  assert.equal(exit.payload.reason, "exited");
});

test("startMoshSession keeps MoshCatty on Netcatty's primary terminal screen", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(h.event, h.options, { moshClientLookup: h.lookupOpts });

  h.spawns[0].emitData("MOSH CONNECT 60002 ABCDEFGHIJKLMNOPQRSTUV==\r\n");
  h.spawns[0].emitExit({ exitCode: 0, signal: 0 });

  assert.equal(h.spawns.length, 2);
  assert.equal(h.spawns[1].opts.env.MOSH_NO_TERM_INIT, "1");
});

test("startMoshSession restores terminal modes on exit without leaving the primary screen", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(h.event, h.options, { moshClientLookup: h.lookupOpts });

  h.spawns[0].emitData("MOSH CONNECT 60002 ABCDEFGHIJKLMNOPQRSTUV==\r\n");
  h.spawns[0].emitExit({ exitCode: 0, signal: 0 });
  h.spawns[1].emitData("\x1b[?25l\x1b[?1000h");
  h.spawns[1].emitExit({ exitCode: 1, signal: 0 });

  const terminalData = h.sent
    .filter((evt) => evt.channel === "netcatty:data")
    .map((evt) => evt.payload.data)
    .join("");
  const exitIndex = h.sent.findIndex((evt) => evt.channel === "netcatty:exit");
  const cleanupIndex = h.sent.findIndex(
    (evt) => evt.channel === "netcatty:data" && evt.payload.data.includes("\x1b[?25h"),
  );

  assert.match(terminalData, /\x1b\[\?25h/);
  assert.match(terminalData, /\x1b\[\?1000l/);
  assert.doesNotMatch(terminalData, /\x1b\[\?1049l/);
  assert.ok(cleanupIndex >= 0 && cleanupIndex < exitIndex);
});

test("startMoshSession forwards terminal shortcut escape sequences after the client swap", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(h.event, h.options, { moshClientLookup: h.lookupOpts });

  h.spawns[0].emitData("MOSH CONNECT 60002 ABCDEFGHIJKLMNOPQRSTUV==\r\n");
  h.spawns[0].emitExit({ exitCode: 0, signal: 0 });

  const shortcuts = [
    "\x1b[A",
    "\x1b[B",
    "\x1b[C",
    "\x1b[D",
    "\x1b[1;5A",
    "\x1b[1;5B",
    "\x1b[1;5C",
    "\x1b[1;5D",
    "\x1b.",
  ];
  for (const data of shortcuts) {
    h.bridge.writeToSession(h.event, { sessionId: h.options.sessionId, data });
  }

  assert.deepEqual(h.spawns[1].writes, shortcuts);
  assert.deepEqual(h.spawns[0].writes, []);
});

test("startMoshSession tags handshake output and emits ready after mosh-client swap", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(h.event, h.options, { moshClientLookup: h.lookupOpts });

  h.spawns[0].emitData("login banner\r\n");
  // Pty output is coalesced and flushed on the next turn.
  await new Promise((resolve) => setImmediate(resolve));
  const handshakeData = h.sent.find((evt) =>
    evt.channel === "netcatty:data" && evt.payload?.data?.includes("login banner"),
  );
  assert.ok(handshakeData, "expected handshake data on netcatty:data");
  assert.equal(handshakeData.payload.meta?.moshHandshake, true);

  assert.equal(
    h.sent.some((evt) => evt.channel === "netcatty:mosh:ready"),
    false,
    "ready must not fire before the mosh-client swap",
  );

  h.spawns[0].emitData("MOSH CONNECT 60002 ABCDEFGHIJKLMNOPQRSTUV==\r\n");
  h.spawns[0].emitExit({ exitCode: 0, signal: 0 });

  const ready = h.sent.find((evt) => evt.channel === "netcatty:mosh:ready");
  assert.ok(ready, "expected netcatty:mosh:ready after client swap");
  assert.equal(ready.payload.sessionId, "mosh-test-session");
  assert.equal(h.sessions.get("mosh-test-session")?.moshHandshakePhase, "mosh-client");
});

test("startMoshSession clears successful SSH bootstrap output before the Mosh screen", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(h.event, h.options, { moshClientLookup: h.lookupOpts });

  h.spawns[0].emitData(
    "Welcome to Ubuntu\r\nmosh-server (mosh 1.4.0)\r\nLicense GPLv3+\r\n",
  );
  await new Promise((resolve) => setImmediate(resolve));
  h.spawns[0].emitData("MOSH CONNECT 60002 ABCDEFGHIJKLMNOPQRSTUV==\r\n");
  h.spawns[0].emitExit({ exitCode: 0, signal: 0 });
  h.spawns[1].emitData(Buffer.from("root@example:~# "));
  await new Promise((resolve) => h.sessions.get("mosh-test-session").flushPendingData(resolve));

  const terminalData = h.sent
    .filter((evt) => evt.channel === "netcatty:data")
    .map((evt) => evt.payload.data)
    .join("");
  const bootstrapIndex = terminalData.indexOf("Welcome to Ubuntu");
  const clearIndex = terminalData.indexOf("\x1b[2J\x1b[H");
  const promptIndex = terminalData.indexOf("root@example:~# ");

  assert.ok(bootstrapIndex >= 0, "the interactive SSH bootstrap should remain visible while connecting");
  assert.ok(clearIndex > bootstrapIndex, "the successful handoff should clear bootstrap cells");
  assert.ok(promptIndex > clearIndex, "the Mosh screen should render onto the cleared viewport");
});

test("startMoshSession stashes stats-companion auth after a successful handshake", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(
    h.event,
    {
      ...h.options,
      port: 2200,
      authMethod: "auto",
      password: "secret",
      keyId: "key-1",
      identityFilePaths: ["~/.ssh/id_work"],
      agentPublicKeys: ["ssh-ed25519 AAAASELECTED"],
      legacyAlgorithms: true,
      skipEcdsaHostKey: true,
      algorithmOverrides: { cipher: ["aes128-cbc"] },
    },
    { moshClientLookup: h.lookupOpts },
  );

  // No stats auth before the handshake completes — a failed handshake must
  // not leave usable credentials lying around for the companion connection.
  const before = h.sessions.get("mosh-test-session");
  assert.equal(before.moshStatsAuth, undefined);

  h.spawns[0].emitData("MOSH CONNECT 60002 ABCDEFGHIJKLMNOPQRSTUV==\r\n");
  h.spawns[0].emitExit({ exitCode: 0, signal: 0 });

  const session = h.sessions.get("mosh-test-session");
  assert.ok(session.moshStatsAuth, "expected moshStatsAuth to be set after swap");
  assert.equal(session.moshStatsAuth.hostname, "example.com");
  assert.equal(session.moshStatsAuth.port, 2200);
  assert.equal(session.moshStatsAuth.username, "alice");
  assert.equal(session.moshStatsAuth.authMethod, "auto");
  assert.equal(session.moshStatsAuth.password, "secret");
  assert.equal(session.moshStatsAuth.identityFilePaths[0], path.join(os.homedir(), ".ssh", "id_work"));
  assert.deepEqual(session.moshStatsAuth.agentPublicKeys, ["ssh-ed25519 AAAASELECTED"]);
  assert.equal(session.moshStatsAuth.legacyAlgorithms, true);
  assert.equal(session.moshStatsAuth.skipEcdsaHostKey, true);
  assert.deepEqual(session.moshStatsAuth.algorithmOverrides, { cipher: ["aes128-cbc"] });
});

test("closeSession ends a Mosh stats companion connection", async (t) => {
  const h = makeHarness(t);
  await h.bridge.startMoshSession(h.event, h.options, { moshClientLookup: h.lookupOpts });

  h.spawns[0].emitData("MOSH CONNECT 60002 ABCDEFGHIJKLMNOPQRSTUV==\r\n");
  h.spawns[0].emitExit({ exitCode: 0, signal: 0 });

  // Simulate a lazily-opened companion ssh2 connection on the live session.
  // It lives on moshStatsConn (separate from session.conn) per #1198.
  const session = h.sessions.get("mosh-test-session");
  let ended = false;
  session.moshStatsConn = { end() { ended = true; } };

  h.bridge.closeSession(h.event, { sessionId: "mosh-test-session" });
  assert.equal(ended, true);
});

test("startMoshSession fails when bundled mosh-client is missing even if PATH has mosh-client", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mosh-session-missing-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const binDir = path.join(tmp, "bin");
  writeExecutable(path.join(binDir, "ssh"));
  writeExecutable(path.join(binDir, "mosh-client"));

  const spawns = [];
  const bridge = loadBridgeWithFakePty(spawns);
  bridge.init({
    sessions: new Map(),
    electronModule: {
      webContents: {
        fromId() {
          return { send() {} };
        },
      },
    },
  });

  await assert.rejects(
    bridge.startMoshSession(
      { sender: { id: 42 } },
      {
        sessionId: "mosh-missing-bundled",
        hostname: "example.com",
        username: "alice",
        env: { PATH: binDir },
      },
      {
        moshClientLookup: {
          platform: "linux",
          arch: "x64",
          projectRoot: tmp,
          resourcesPath: path.join(tmp, "missing"),
        },
      },
    ),
    /Bundled mosh-client not found/,
  );
  assert.equal(spawns.length, 0);
});
