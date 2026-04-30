const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseMoshConnect,
  buildSshHandshakeCommand,
  buildMoshServerCommand,
  buildMoshClientCommand,
  createMoshConnectSniffer,
  buildMoshClientEnv,
  resolveSshExecutable,
} = require("./moshHandshake.cjs");

test("parseMoshConnect captures port and key from a typical mosh-server line", () => {
  const line = "Welcome\r\nMOSH CONNECT 60001 ABCDEFGHIJKLMNOPQRSTUV==\r\n";
  const got = parseMoshConnect(line);
  assert.deepEqual(got && { port: got.port, key: got.key }, {
    port: 60001,
    key: "ABCDEFGHIJKLMNOPQRSTUV==",
  });
});

test("parseMoshConnect accepts unpadded base64 keys (length 22)", () => {
  const line = "MOSH CONNECT 60005 abcdefghijklmnopqrstuv\n";
  const got = parseMoshConnect(line);
  assert.equal(got && got.port, 60005);
  assert.equal(got && got.key.length, 22);
});

test("parseMoshConnect rejects out-of-range ports", () => {
  assert.equal(parseMoshConnect("MOSH CONNECT 99999 ABCDEFGHIJKLMNOPQRSTUV==\n"), null);
  assert.equal(parseMoshConnect("MOSH CONNECT 0 ABCDEFGHIJKLMNOPQRSTUV==\n"), null);
});

test("parseMoshConnect rejects implausibly short keys (substring noise)", () => {
  assert.equal(parseMoshConnect("MOSH CONNECT 60000 abc\n"), null);
});

test("parseMoshConnect handles a Buffer chunk", () => {
  const buf = Buffer.from("garbage MOSH CONNECT 60010 ABCDEFGHIJKLMNOPQRSTUV==\n");
  const got = parseMoshConnect(buf);
  assert.equal(got && got.port, 60010);
});

test("buildSshHandshakeCommand omits -t and uses default port", () => {
  const got = buildSshHandshakeCommand({ host: "example.com", username: "alice" });
  assert.equal(got.command, "ssh");
  assert.deepEqual(got.args, [
    "alice@example.com",
    "--",
    "LC_ALL='en_US.UTF-8' mosh-server new -s",
  ]);
});

test("buildSshHandshakeCommand passes a non-default port via -p", () => {
  const got = buildSshHandshakeCommand({ host: "example.com", port: 2222 });
  assert.deepEqual(got.args.slice(0, 2), ["-p", "2222"]);
});

test("buildSshHandshakeCommand interpolates lang and moshServer overrides", () => {
  const got = buildSshHandshakeCommand({
    host: "h",
    lang: "zh_CN.UTF-8",
    moshServer: "/opt/mosh/bin/mosh-server new -s -c 256",
  });
  assert.equal(got.args.at(-1), "LC_ALL='zh_CN.UTF-8' /opt/mosh/bin/mosh-server new -s -c 256");
});

test("buildSshHandshakeCommand shell-quotes lang values", () => {
  const got = buildSshHandshakeCommand({
    host: "h",
    lang: "C; touch /tmp/netcatty-owned",
  });
  assert.equal(got.args.at(-1), "LC_ALL='C; touch /tmp/netcatty-owned' mosh-server new -s");
});

test("buildMoshServerCommand treats custom server input as a path", () => {
  assert.equal(
    buildMoshServerCommand("/opt/Mosh Tools/mosh-server; touch /tmp/nope"),
    "'/opt/Mosh Tools/mosh-server; touch /tmp/nope' new -s",
  );
});

test("buildSshHandshakeCommand throws when host is missing", () => {
  assert.throws(() => buildSshHandshakeCommand({}), /host is required/);
});

test("buildMoshClientCommand wires moshClientPath, host, port", () => {
  const got = buildMoshClientCommand({
    moshClientPath: "/usr/local/bin/mosh-client",
    host: "10.0.0.1",
    port: 60001,
  });
  assert.equal(got.command, "/usr/local/bin/mosh-client");
  assert.deepEqual(got.args, ["10.0.0.1", "60001"]);
});

test("buildMoshClientCommand validates inputs", () => {
  assert.throws(() => buildMoshClientCommand({ host: "h", port: 1 }), /moshClientPath/);
  assert.throws(() => buildMoshClientCommand({ moshClientPath: "x", port: 1 }), /host/);
  assert.throws(() => buildMoshClientCommand({ moshClientPath: "x", host: "h", port: 0 }), /port/);
});

test("createMoshConnectSniffer detects MOSH CONNECT split across chunks", () => {
  const sniffer = createMoshConnectSniffer();
  const r1 = sniffer.feed("login as: alice\r\nlast login: yesterday\r\nMOSH CONNE");
  assert.equal(r1.parsed, null);
  assert.ok(!String(r1.visible).includes("MOSH CONNE"));
  const r2 = sniffer.feed("CT 60002 ABCDEFGHIJKLMNOPQRSTUV==\r\n");
  assert.deepEqual(r2.parsed, { port: 60002, key: "ABCDEFGHIJKLMNOPQRSTUV==" });
  assert.ok(!String(r2.visible).includes("MOSH CONNECT"));
  assert.ok(!String(r2.visible).includes("ABCDEFGHIJKLMNOPQRSTUV=="));
});

test("createMoshConnectSniffer does not leak a split MOSH key", () => {
  const sniffer = createMoshConnectSniffer();
  const r1 = sniffer.feed("intro\r\nMOSH CONNECT 60002 ABCDEFGHIJ");
  assert.equal(r1.parsed, null);
  assert.equal(String(r1.visible), "intro\r\n");
  const r2 = sniffer.feed("KLMNOPQRSTUV==\r\n");
  assert.deepEqual(r2.parsed, { port: 60002, key: "ABCDEFGHIJKLMNOPQRSTUV==" });
  assert.equal(String(r2.visible), "");
});

test("createMoshConnectSniffer passes through prompts without waiting for a newline", () => {
  const sniffer = createMoshConnectSniffer();
  const r = sniffer.feed("password:");
  assert.equal(r.parsed, null);
  assert.equal(String(r.visible), "password:");
});

test("createMoshConnectSniffer ignores invalid MOSH CONNECT lines", () => {
  for (const line of [
    "MOSH CONNECT 99999 ABCDEFGHIJKLMNOPQRSTUV==\r\n",
    "MOSH CONNECT 0 ABCDEFGHIJKLMNOPQRSTUV==\r\n",
    "MOSH CONNECT 60000 short\r\n",
    "MOSH CONNECT 60000 ABCDEFGHIJKLMNOPQRSTUVWXYZ\r\n",
    "MOSH CONNECT 60000 ABCDEFGHIJKLMNOPQRSTUV==oops\r\n",
  ]) {
    const sniffer = createMoshConnectSniffer();
    const r = sniffer.feed(line);
    assert.equal(r.parsed, null, line);
  }
});

test("createMoshConnectSniffer captures MOSH IP without showing protocol lines", () => {
  const sniffer = createMoshConnectSniffer();
  const r = sniffer.feed("welcome\r\nMOSH IP 203.0.113.8\r\nMOSH CONNECT 60002 ABCDEFGHIJKLMNOPQRSTUV==\r\n");
  assert.deepEqual(r.parsed, { port: 60002, key: "ABCDEFGHIJKLMNOPQRSTUV==", host: "203.0.113.8" });
  assert.equal(String(r.visible), "welcome\r\n");
});

test("createMoshConnectSniffer ignores unsafe MOSH IP values", () => {
  const sniffer = createMoshConnectSniffer();
  const r = sniffer.feed("MOSH IP --help\r\nMOSH CONNECT 60002 ABCDEFGHIJKLMNOPQRSTUV==\r\n");
  assert.deepEqual(r.parsed, { port: 60002, key: "ABCDEFGHIJKLMNOPQRSTUV==" });
});

test("createMoshConnectSniffer strips the magic line from visible output", () => {
  const sniffer = createMoshConnectSniffer();
  const chunk = "shell prompt $ \r\nMOSH CONNECT 60003 ABCDEFGHIJKLMNOPQRSTUV==\r\nbye\r\n";
  const { visible, parsed } = sniffer.feed(chunk);
  assert.deepEqual(parsed, { port: 60003, key: "ABCDEFGHIJKLMNOPQRSTUV==" });
  assert.ok(!String(visible).includes("MOSH CONNECT"), "visible output should not leak the marker");
});

test("createMoshConnectSniffer is idempotent after a parse", () => {
  const sniffer = createMoshConnectSniffer();
  const r1 = sniffer.feed("MOSH CONNECT 60010 ABCDEFGHIJKLMNOPQRSTUV==\r\n");
  assert.ok(r1.parsed);
  // Second feed should not re-parse / re-strip — it just passes through.
  const r2 = sniffer.feed("trailing bytes after handshake\r\n");
  assert.equal(r2.parsed, null);
  assert.equal(String(r2.visible), "trailing bytes after handshake\r\n");
});

test("createMoshConnectSniffer trims its ring buffer so old data doesn't accumulate", () => {
  const sniffer = createMoshConnectSniffer();
  // Feed >> RING_SIZE (4096) bytes of harmless output.
  for (let i = 0; i < 10; i += 1) {
    const r = sniffer.feed("x".repeat(1024));
    assert.equal(r.parsed, null);
  }
  // Now feed a CONNECT line — ring trimming must not have lost the
  // ability to match a fresh marker.
  const r = sniffer.feed("MOSH CONNECT 60020 ABCDEFGHIJKLMNOPQRSTUV==\r\n");
  assert.equal(r.parsed && r.parsed.port, 60020);
});

test("buildMoshClientEnv injects MOSH_KEY without mutating the input env", () => {
  const base = { LANG: "C", PATH: "/x" };
  const env = buildMoshClientEnv({ baseEnv: base, key: "deadbeef", lang: "C" });
  assert.equal(env.MOSH_KEY, "deadbeef");
  assert.equal(env.PATH, "/x");
  assert.equal(base.MOSH_KEY, undefined, "input env should not be mutated");
});

test("buildMoshClientEnv defaults TERM when missing", () => {
  const env = buildMoshClientEnv({ baseEnv: {}, key: "k", lang: "C" });
  assert.equal(env.TERM, "xterm-256color");
});

test("resolveSshExecutable prefers PATH lookups", () => {
  const resolved = resolveSshExecutable({
    findExecutable: () => "/opt/ssh/bin/ssh",
    fileExists: () => true,
    platform: "linux",
  });
  assert.equal(resolved, "/opt/ssh/bin/ssh");
});

test("resolveSshExecutable falls back to in-box OpenSSH on win32", () => {
  process.env.SystemRoot = "C:\\Windows";
  const resolved = resolveSshExecutable({
    findExecutable: () => "ssh", // fakes "not found, returns the bare name"
    fileExists: (p) => p.endsWith("OpenSSH\\ssh.exe"),
    platform: "win32",
  });
  assert.equal(resolved, "C:\\Windows\\System32\\OpenSSH\\ssh.exe");
});

test("resolveSshExecutable returns null when nothing is found", () => {
  const resolved = resolveSshExecutable({
    findExecutable: () => "ssh",
    fileExists: () => false,
    platform: "linux",
  });
  assert.equal(resolved, null);
});
