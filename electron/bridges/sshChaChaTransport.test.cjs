const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Server } = require("ssh2");

const CHACHA = "chacha20-poly1305@openssh.com";
const AES = "aes128-gcm@openssh.com";
const root = path.resolve(__dirname, "../..");
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const hostKey = privateKey.export({ type: "pkcs1", format: "pem" });

async function connect(t, {
  serverCiphers = [CHACHA],
  cipher,
  entrypoint = "netcatty:start",
  withoutNativeChacha = true,
} = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-chacha-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const offered = {};
  let negotiated;
  const connections = new Set();
  // The server uses Node/OpenSSL's ChaCha20; only the child uses the fallback.
  const server = new Server({
    hostKeys: [hostKey],
    algorithms: { cipher: serverCiphers },
    debug(line) {
      const match = /Handshake: \(remote\) (C->S|S->C) cipher: (.*)/.exec(line);
      if (match) offered[match[1]] = match[2].split(",");
    },
  }, (client) => {
    connections.add(client);
    client.on("error", () => {});
    client.on("close", () => connections.delete(client));
    client.on("handshake", (info) => { negotiated = info; });
    client.on("authentication", (ctx) => ctx.accept());
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => acceptPty?.());
        session.on("env", (acceptEnv) => acceptEnv?.());
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          stream.on("data", (data) => stream.write(data));
        });
      });
    });
  });
  t.after(() => {
    for (const client of connections) client.end();
    server.close();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const runtime = process.env.NETCATTY_SSH_TEST_RUNTIME === "electron"
    ? require("electron")
    : path.resolve(process.env.NETCATTY_SSH_TEST_RUNTIME || process.execPath);
  const child = spawn(runtime, ["scripts/fixtures/ssh-chacha-client.cjs"], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  child.stdin.end(JSON.stringify({
    port: server.address().port,
    appRoot: process.env.NETCATTY_SSH_TEST_APP_ROOT,
    homeDir,
    // Cross several SSH packets, exercising both nonce/counter directions.
    input: "synthetic SSH echo\r\n".repeat(4000),
    algorithmOverrides: cipher ? { cipher } : undefined,
    entrypoint,
    withoutNativeChacha,
  }));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, stderr || stdout);
  const resultLine = stdout.split("\n").find((line) => line.startsWith("NETCATTY_TRANSPORT_RESULT="));
  assert.ok(resultLine, stderr || stdout);
  const result = JSON.parse(resultLine.slice("NETCATTY_TRANSPORT_RESULT=".length));
  if (process.env.NETCATTY_SSH_TEST_APP_ROOT && result.connected) {
    assert.equal(result.packagedDependency, "node_modules/@noble/ciphers/chacha.js");
  }
  return { ...result, offered, negotiated };
}

for (const entrypoint of ["netcatty:start", "netcatty:test-connection"]) {
  test(`${entrypoint} advertises and negotiates an explicit ChaCha20-only override without native crypto`, { timeout: 15000 }, async (t) => {
    const result = await connect(t, { cipher: [CHACHA], entrypoint });
    assert.equal(result.connected, true, result.error);
    assert.equal(result.nativeChacha, false);
    assert.deepEqual(result.offered["C->S"], [CHACHA]);
    assert.deepEqual(result.offered["S->C"], [CHACHA]);
    assert.equal(result.negotiated.cs.cipher, CHACHA);
    assert.equal(result.negotiated.sc.cipher, CHACHA);
    if (entrypoint === "netcatty:start") assert.equal(result.echoed, true);
  });
}

test("default ciphers can connect to a ChaCha20-only server", async (t) => {
  const result = await connect(t);
  assert.equal(result.connected, true, result.error);
  assert.equal(result.echoed, true);
  assert.ok(result.offered["C->S"].includes(CHACHA));
  assert.equal(result.negotiated.cs.cipher, CHACHA);
});

test("default and mixed offers retain AES preference and explicit cipher order", async (t) => {
  for (const cipher of [undefined, [AES, CHACHA], [CHACHA, AES]]) {
    const result = await connect(t, { serverCiphers: [AES, CHACHA], cipher });
    assert.equal(result.connected, true, result.error);
    assert.equal(result.echoed, true);
    assert.equal(result.negotiated.cs.cipher, cipher?.[0] || AES);
    if (cipher) assert.deepEqual(result.offered["C->S"], cipher);
  }
});

test("an explicit AES-only choice never falls back to ChaCha20", async (t) => {
  const result = await connect(t, { cipher: [AES] });
  assert.equal(result.connected, false);
  assert.match(result.error, /no matching C->S cipher/);
  assert.deepEqual(result.offered["C->S"], [AES]);
});

test("the runtime's unmodified crypto path still supports ChaCha20", async (t) => {
  const result = await connect(t, { cipher: [CHACHA], withoutNativeChacha: false });
  assert.equal(result.connected, true, result.error);
  assert.equal(result.echoed, true);
});
