const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseSecureCrtCommandLine,
  parseSecureCrtCommandLineTokens,
  redactSecureCrtCommandLinePasswords,
} = require("./secureCrtCommandLine.cjs");

test("parseSecureCrtCommandLine accepts 4A-style /SSH2 launch", () => {
  assert.deepEqual(
    parseSecureCrtCommandLine([
      String.raw`C:\Program Files\Netcatty\Netcatty.exe`,
      "/SSH2",
      "/L",
      "alice",
      "/P",
      "2222",
      "/PASSWORD",
      "s3cret",
      "10.0.0.8",
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

test("parseSecureCrtCommandLine accepts PAM-style /T /N /SSH2 line", () => {
  const parsed = parseSecureCrtCommandLine([
    "Netcatty.exe",
    "/T",
    "/N",
    "Device",
    "/SSH2",
    "/L",
    "root",
    "192.168.10.2",
    "/P",
    "22",
  ]);
  assert.equal(parsed?.url, "ssh://root@192.168.10.2:22");
  assert.equal(parsed?.username, "root");
  assert.equal(parsed?.password, undefined);
  assert.equal(parsed?.port, 22);
  assert.equal(parsed?.tabName, "Device");
});

test("parseSecureCrtCommandLine accepts case-insensitive flags and user@host positional", () => {
  const parsed = parseSecureCrtCommandLine([
    "Netcatty.exe",
    "/ssh2",
    "/password",
    "pw",
    "bob@host.example.com",
  ]);
  assert.equal(parsed?.url, "ssh://bob:pw@host.example.com");
  assert.equal(parsed?.username, "bob");
  assert.equal(parsed?.hostname, "host.example.com");
});

test("parseSecureCrtCommandLine accepts /TELNET", () => {
  const parsed = parseSecureCrtCommandLine([
    "Netcatty.exe",
    "/TELNET",
    "old.example.com",
    "/P",
    "2323",
  ]);
  assert.equal(parsed?.protocol, "telnet");
  assert.equal(parsed?.url, "telnet://old.example.com:2323");
});

test("parseSecureCrtCommandLine consumes and ignores auth, identity and session values", () => {
  const parsed = parseSecureCrtCommandLine([
    "Netcatty.exe",
    "/SSH2",
    "/AUTH",
    "keyboard-interactive",
    "/I",
    String.raw`C:\keys\id_rsa`,
    "/S",
    "Production",
    "/L",
    "ops",
    "/PASSWORD",
    "hunter2",
    "bastion.example.com",
  ]);
  assert.equal(parsed?.url, "ssh://ops:hunter2@bastion.example.com");
});

test("parseSecureCrtCommandLine rejects unsupported protocols and missing values", () => {
  assert.equal(parseSecureCrtCommandLine(["Netcatty.exe", "/SERIAL", "com1"]), null);
  assert.equal(parseSecureCrtCommandLine(["Netcatty.exe", "/SSH2", "/L"]), null);
  assert.equal(parseSecureCrtCommandLine(["Netcatty.exe", "/SSH2", "/P", "99999"]), null);
  assert.equal(parseSecureCrtCommandLine(["Netcatty.exe", "/SSH2", "/PASSWORD", ""]), null);
  assert.equal(parseSecureCrtCommandLine(["Netcatty.exe", "-ssh", "user@host", "-pw", "x"]), null);
});

test("parseSecureCrtCommandLineTokens reports consumed operand indices", () => {
  const { result, consumedIndices } = parseSecureCrtCommandLineTokens([
    "Netcatty.exe",
    "/SSH2",
    "/L",
    "alice",
    "/PASSWORD",
    "ssh://s3cret",
    "10.0.0.8",
  ]);
  assert.equal(result?.url, "ssh://alice:ssh%3A%2F%2Fs3cret@10.0.0.8");
  // Every token is an operand of the command line, including the password
  // value that merely starts with a scheme (#3391).
  assert.deepEqual([...consumedIndices].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
});

test("parseSecureCrtCommandLineTokens returns consumed indices with a null result on failure", () => {
  const { result, consumedIndices } = parseSecureCrtCommandLineTokens([
    "Netcatty.exe",
    "/SSH2",
    "/PASSWORD",
    "ssh://s3cret",
    "/SERIAL",
    "com1",
  ]);
  assert.equal(result, null);
  assert.deepEqual([...consumedIndices].sort((a, b) => a - b), [0, 1, 2, 3]);
});

test("parseSecureCrtCommandLineTokens reports credential indices even when the parse fails", () => {
  const { result, consumedIndices, credentialIndices } = parseSecureCrtCommandLineTokens([
    "Netcatty.exe",
    "/SSH2",
    "/PASSWORD",
    "ssh://s3cret",
    "/P",
    "99999",
    "10.0.0.8",
  ]);
  assert.equal(result, null);
  // The parse fails on the invalid port, so the host positional was never
  // consumed, but the password operand is still reported as a credential (#3391).
  assert.deepEqual([...consumedIndices].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual([...credentialIndices].sort((a, b) => a - b), [3]);
});

test("parseSecureCrtCommandLineTokens reports credential operands after a pre-credential parse failure", () => {
  const { result, credentialIndices } = parseSecureCrtCommandLineTokens([
    "Netcatty.exe",
    "/SSH2",
    "/P",
    "99999",
    "/PASSWORD",
    "ssh://secret",
    "real.example.com",
  ]);
  assert.equal(result, null);
  // The invalid /P value fails the parse before /PASSWORD is visited, but the
  // password operand must still be filtered from scheme-URL scanning (#3391).
  assert.deepEqual([...credentialIndices].sort((a, b) => a - b), [5]);
});

test("parseSecureCrtCommandLineTokens reports /PASSPHRASE operands as credentials on failure", () => {
  const { result, credentialIndices } = parseSecureCrtCommandLineTokens([
    "Netcatty.exe",
    "/SSH2",
    "/PASSPHRASE",
    "ssh://secret",
    "/P",
    "99999",
    "10.0.0.8",
  ]);
  assert.equal(result, null);
  assert.deepEqual([...credentialIndices].sort((a, b) => a - b), [3]);
});

test("parseSecureCrtCommandLineTokens reports /L username operands as credentials on failure", () => {
  const { result, credentialIndices } = parseSecureCrtCommandLineTokens([
    "Netcatty.exe",
    "/SSH2",
    "/P",
    "99999",
    "/L",
    "ssh://alice",
    "real.example.com",
  ]);
  assert.equal(result, null);
  // The invalid /P value fails the parse before /L is visited, but the username
  // operand must still be filtered from scheme-URL scanning (#3391).
  assert.deepEqual([...credentialIndices].sort((a, b) => a - b), [5]);
});

test("parseSecureCrtCommandLineTokens returns null without a SecureCRT launch signal", () => {
  assert.equal(parseSecureCrtCommandLineTokens(["Netcatty.exe", "ssh://alice@example.com"]), null);
});

test("redactSecureCrtCommandLinePasswords masks /PASSWORD and /PASSPHRASE values", () => {
  const argv = ["Netcatty.exe", "/SSH2", "/PASSWORD", "s3cret", "/PASSPHRASE", "phrase", "host"];
  redactSecureCrtCommandLinePasswords(argv);
  assert.deepEqual(argv, ["Netcatty.exe", "/SSH2", "/PASSWORD", "******", "/PASSPHRASE", "******", "host"]);
});

test("reported 4A launch uses the bastion address, never the title address", () => {
  const result = parseSecureCrtCommandLine([
    String.raw`C:\Program Files\Netcatty\Netcatty.exe`,
    "/TITLEBAR", "192.0.2.10", "/N", "192.0.2.10", "/T", "/SSH2", "198.51.100.20",
    "/P", "2200", "/L", "alice", "/PASSWORD", "example",
  ]);
  assert.equal(result?.url, "ssh://alice:example@198.51.100.20:2200");
});

test("unknown SecureCRT options cannot supply a host candidate", () => {
  assert.equal(parseSecureCrtCommandLine([
    "Netcatty.exe", "/SSH2", "/SCRIPT", "login.vbs", "/L", "alice", "/PASSWORD", "secret", "server",
  ]), null);
});

test("redaction does not mistake a flag-shaped username for a password switch", () => {
  const argv = ["Netcatty.exe", "/SSH2", "/L", "/PASSWORD", "/PASSWORD", "secret", "server.example.com"];
  redactSecureCrtCommandLinePasswords(argv);
  assert.deepEqual(argv, ["Netcatty.exe", "/SSH2", "/L", "/PASSWORD", "/PASSWORD", "******", "server.example.com"]);
});

test("punctuated unknown SecureCRT switches are rejected", () => {
  for (const flag of ["/UNKNOWN-FLAG", "/UNKNOWN_FLAG", "/UNKNOWN=value", "/UNKNOWN:value", "/unknown/path"]) {
    assert.equal(parseSecureCrtCommandLine(["Netcatty.exe", "/SSH2", flag, "server.example.com"]), null);
  }
});

test("SecureCRT launches still accept absolute Electron development entry paths", () => {
  assert.equal(parseSecureCrtCommandLine([
    "/Applications/Electron.app/Contents/MacOS/Electron", "/workspace/electron/main.cjs",
    "/SSH2", "/L", "alice", "server.example.com",
  ])?.url, "ssh://alice@server.example.com");
});
