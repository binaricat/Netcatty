const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parsePuttyCommandLine,
  redactPuttyCommandLinePasswords,
} = require("./puttyCommandLine.cjs");

test("parsePuttyCommandLine accepts JumpServer PuTTY template", () => {
  assert.deepEqual(
    parsePuttyCommandLine([
      String.raw`C:\Program Files\Netcatty\Netcatty.exe`,
      "-ssh",
      "alice@10.0.0.8",
      "-P",
      "2222",
      "-pw",
      "s3cret",
    ]),
    {
      protocol: "ssh",
      url: "ssh://alice:s3cret@10.0.0.8:2222",
      hostname: "10.0.0.8",
      username: "alice",
      password: "s3cret",
      port: 2222,
    },
  );
});

test("parsePuttyCommandLine accepts -l username and mixed flag order", () => {
  const parsed = parsePuttyCommandLine([
    "Netcatty.exe",
    "bastion.example.com",
    "-P",
    "22",
    "-l",
    "ops",
    "-pw",
    "hunter2",
    "-ssh",
  ]);
  assert.equal(parsed?.url, "ssh://ops:hunter2@bastion.example.com:22");
  assert.equal(parsed?.username, "ops");
});

test("parsePuttyCommandLine prefers user@host over -newtab session names", () => {
  const parsed = parsePuttyCommandLine([
    "Netcatty.exe",
    "-newtab",
    "Production",
    "-ssh",
    "root@192.168.10.2",
    "-P",
    "22",
    "-pw",
    "one-time",
  ]);
  assert.equal(parsed?.hostname, "192.168.10.2");
  assert.equal(parsed?.username, "root");
  assert.equal(parsed?.url, "ssh://root:one-time@192.168.10.2:22");
});

test("parsePuttyCommandLine percent-encodes passwords for ssh:// round-trip", () => {
  const parsed = parsePuttyCommandLine([
    "Netcatty.exe",
    "-ssh",
    "alice@example.com",
    "-pw",
    "p@ss:w/rd",
  ]);
  assert.equal(parsed?.url, "ssh://alice:p%40ss%3Aw%2Frd@example.com");
  assert.equal(parsed?.password, "p@ss:w/rd");
});

test("parsePuttyCommandLine accepts IPv6 hosts and optional positional port", () => {
  const parsed = parsePuttyCommandLine([
    "electron",
    ".",
    "-ssh",
    "bob@[2001:db8::10]",
    "2200",
  ]);
  assert.equal(parsed?.hostname, "2001:db8::10");
  assert.equal(parsed?.port, 2200);
  assert.equal(parsed?.url, "ssh://bob@[2001:db8::10]:2200");
});

test("parsePuttyCommandLine accepts user@host:port without -P", () => {
  const parsed = parsePuttyCommandLine([
    "Netcatty.exe",
    "-ssh",
    "alice@bastion.example.com:2222",
    "-pw",
    "token",
  ]);
  assert.equal(parsed?.url, "ssh://alice:token@bastion.example.com:2222");
});

test("parsePuttyCommandLine accepts telnet launches", () => {
  const parsed = parsePuttyCommandLine([
    "Netcatty.exe",
    "-telnet",
    "router.lab",
    "-P",
    "23",
  ]);
  assert.equal(parsed?.protocol, "telnet");
  assert.equal(parsed?.url, "telnet://router.lab:23");
});

test("parsePuttyCommandLine ignores Chromium flags and missing hosts", () => {
  assert.equal(parsePuttyCommandLine(["Netcatty.exe", "--enable-logging", "-ssh"]), null);
  assert.equal(parsePuttyCommandLine(["Netcatty.exe", "just-a-file.txt"]), null);
  assert.equal(parsePuttyCommandLine(["Netcatty.exe", "-P", "22"]), null);
});

test("parsePuttyCommandLine rejects invalid ports", () => {
  assert.equal(parsePuttyCommandLine(["Netcatty.exe", "-ssh", "host.example", "-P", "99999"]), null);
});

test("parsePuttyCommandLine does not treat -m operands as the destination host", () => {
  const parsed = parsePuttyCommandLine([
    "Netcatty.exe",
    "-ssh",
    "-l",
    "alice",
    "server.example",
    "-m",
    "commands.txt",
    "-pw",
    "secret",
  ]);
  assert.equal(parsed?.hostname, "server.example");
  assert.equal(parsed?.username, "alice");
  assert.equal(parsed?.url, "ssh://alice:secret@server.example");
});

test("parsePuttyCommandLine does not treat -D operands as the destination port", () => {
  const parsed = parsePuttyCommandLine([
    "Netcatty.exe",
    "-ssh",
    "alice@server.example",
    "-D",
    "1080",
    "-pw",
    "secret",
  ]);
  assert.equal(parsed?.hostname, "server.example");
  assert.equal(parsed?.port, undefined);
  assert.equal(parsed?.url, "ssh://alice:secret@server.example");
});

test("parsePuttyCommandLine consumes operands of known value-taking flags such as -cmd", () => {
  const parsed = parsePuttyCommandLine([
    "Netcatty.exe",
    "-ssh",
    "alice@server.example",
    "-cmd",
    "whoami",
    "-pw",
    "secret",
  ]);
  assert.equal(parsed?.hostname, "server.example");
  assert.equal(parsed?.url, "ssh://alice:secret@server.example");
});

test("parsePuttyCommandLine rejects unsupported PuTTY protocol selectors", () => {
  assert.equal(parsePuttyCommandLine([
    "Netcatty.exe",
    "server.example",
    "-raw",
    "-P",
    "8000",
    "-pw",
    "secret",
  ]), null);
  assert.equal(parsePuttyCommandLine([
    "Netcatty.exe",
    "-serial",
    "COM1",
    "-P",
    "22",
  ]), null);
});

test("parsePuttyCommandLine keeps the host after valueless options such as -batch", () => {
  const parsed = parsePuttyCommandLine([
    "Netcatty.exe",
    "-ssh",
    "-batch",
    "alice@server.example",
    "-pw",
    "secret",
  ]);
  assert.equal(parsed?.url, "ssh://alice:secret@server.example");
});

test("parsePuttyCommandLine rejects unknown dash flags", () => {
  assert.equal(parsePuttyCommandLine([
    "Netcatty.exe",
    "-ssh",
    "-not-a-putty-flag",
    "alice@server.example",
  ]), null);
});

test("parsePuttyCommandLine rejects missing or empty option operands", () => {
  assert.equal(parsePuttyCommandLine([
    "Netcatty.exe",
    "-ssh",
    "alice@server.example",
    "-pw",
  ]), null);
  assert.equal(parsePuttyCommandLine([
    "Netcatty.exe",
    "-ssh",
    "alice@server.example",
    "-pw",
    "",
  ]), null);
  assert.equal(parsePuttyCommandLine([
    "Netcatty.exe",
    "-ssh",
    "alice@server.example",
    "-P",
  ]), null);
  assert.equal(parsePuttyCommandLine([
    "Netcatty.exe",
    "-ssh",
    "server.example",
    "-l",
    "",
    "-pw",
    "secret",
  ]), null);
});

test("parsePuttyCommandLine rejects unsupported authentication and host-key overrides", () => {
  assert.equal(parsePuttyCommandLine([
    "Netcatty.exe",
    "-ssh",
    "alice@server.example",
    "-pwfile",
    "secret.txt",
  ]), null);
  assert.equal(parsePuttyCommandLine([
    "Netcatty.exe",
    "-ssh",
    "alice@server.example",
    "-i",
    "id_rsa.ppk",
    "-pw",
    "secret",
  ]), null);
  assert.equal(parsePuttyCommandLine([
    "Netcatty.exe",
    "-ssh",
    "alice@server.example",
    "-hostkey",
    "aa:bb:cc:dd",
    "-pw",
    "secret",
  ]), null);
  assert.equal(parsePuttyCommandLine([
    "Netcatty.exe",
    "-ssh",
    "alice@server.example",
    "-loghost",
    "logical.example",
    "-pw",
    "secret",
  ]), null);
});

test("parsePuttyCommandLine accepts destinations with executable-like suffixes", () => {
  const parsed = parsePuttyCommandLine([
    "Netcatty.exe",
    "-ssh",
    "alice@prod.app",
    "-pw",
    "secret",
  ]);
  assert.equal(parsed?.hostname, "prod.app");
  assert.equal(parsed?.url, "ssh://alice:secret@prod.app");

  const positional = parsePuttyCommandLine([
    "Netcatty.exe",
    "gateway.exe",
    "-ssh",
    "-l",
    "alice",
    "-pw",
    "secret",
  ]);
  assert.equal(positional?.hostname, "gateway.exe");
  assert.equal(positional?.url, "ssh://alice:secret@gateway.exe");

  const scriptLikeHost = parsePuttyCommandLine([
    "Netcatty.exe",
    "prod.js",
    "-ssh",
    "-l",
    "alice",
    "-pw",
    "secret",
  ]);
  assert.equal(scriptLikeHost?.hostname, "prod.js");
  assert.equal(scriptLikeHost?.url, "ssh://alice:secret@prod.js");

  const fromElectron = parsePuttyCommandLine([
    "electron",
    "main.cjs",
    "-ssh",
    "alice@host.example",
    "-pw",
    "secret",
  ]);
  assert.equal(fromElectron?.hostname, "host.example");
  assert.equal(fromElectron?.url, "ssh://alice:secret@host.example");
});

test("redactPuttyCommandLinePasswords masks -pw values in argv", () => {
  const argv = ["Netcatty.exe", "-ssh", "alice@host", "-pw", "s3cret!!"];
  redactPuttyCommandLinePasswords(argv);
  assert.equal(argv[4], "********");
});
