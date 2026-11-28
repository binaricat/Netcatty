const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const { parseLsofCwdOutput, readLocalSessionCwd } = require("./localSessionCwd.cjs");

test("parseLsofCwdOutput accepts a directory name and ignores annotations", () => {
  assert.equal(
    parseLsofCwdOutput("p4242\nfcwd\ntDIR\nn/srv/app dir\n"),
    "/srv/app dir",
  );
  assert.equal(
    parseLsofCwdOutput("p4242\nfcwd\ntDIR\nn/proc/4242/cwd (readlink: Permission denied)\n"),
    null,
  );
  assert.equal(parseLsofCwdOutput("p4242\nfcwd\ntunknown\nn/tmp\n"), null);
  assert.equal(parseLsofCwdOutput(""), null);
});

test("parseLsofCwdOutput decodes lsof byte escapes in non-ASCII paths", () => {
  assert.equal(
    parseLsofCwdOutput("p4242\nfcwd\nn/private/tmp/\\xe4\\xb8\\xad\\xe6\\x96\\x87 \\\\x41\n"),
    "/private/tmp/中文 \\x41",
  );
  assert.equal(
    parseLsofCwdOutput("p4242\nfcwd\nn/Users/me/\\xe9\\xa1\\xb9\\xe7\\x9b\\xae\n"),
    "/Users/me/项目",
  );
  assert.equal(parseLsofCwdOutput("p4242\nfcwd\nn/tmp/a\\tb\n"), "/tmp/a\tb");
  assert.equal(parseLsofCwdOutput("p4242\nfcwd\nn/tmp/\\101\n"), "/tmp/A");
  // lsof's caret form cannot distinguish a BEL byte from literal "^G".
  assert.equal(parseLsofCwdOutput("p4242\nfcwd\nn/tmp/^G\n"), null);
});

test("readLocalSessionCwd reads /proc cwd for a local shell pid", async () => {
  const result = await readLocalSessionCwd(
    { protocol: "local", proc: { pid: 42 } },
    {
      platform: "linux",
      readlink: async (target) => {
        assert.equal(target, "/proc/42/cwd");
        return "/srv/project";
      },
      execFile: () => {
        throw new Error("lsof should not run after /proc succeeds");
      },
    },
  );
  assert.deepEqual(result, { success: true, cwd: "/srv/project" });
});

test("readLocalSessionCwd falls back to lsof on macOS", async () => {
  const calls = [];
  const result = await readLocalSessionCwd(
    { type: "local", pty: { pid: 7 } },
    {
      platform: "darwin",
      execFile: (file, args, _options, callback) => {
        calls.push([file, args]);
        callback(Object.assign(new Error("missing"), { code: "ENOENT" }), "");
      },
    },
  );
  assert.equal(result.success, false);
  assert.deepEqual(calls[0][0], "/usr/sbin/lsof");
  assert.deepEqual(calls[1][0], "lsof");

  const ok = await readLocalSessionCwd(
    { protocol: "local", proc: { pid: 7 } },
    {
      platform: "darwin",
      lsofBinaries: ["lsof"],
      execFile: (_file, _args, _options, callback) => {
        callback(null, "p7\nfcwd\nn/Users/me/work\n");
      },
    },
  );
  assert.deepEqual(ok, { success: true, cwd: "/Users/me/work" });
});

test("readLocalSessionCwd does not guess a home directory", async () => {
  const missing = await readLocalSessionCwd({ protocol: "local" }, { platform: "linux" });
  assert.deepEqual(missing, { success: false, error: "Local session has no process" });

  const windows = await readLocalSessionCwd(
    { protocol: "local", proc: { pid: 9 } },
    { platform: "win32", readlink: async () => "/tmp" },
  );
  assert.equal(windows.success, false);
});

test("a real local bash cd is visible from the spawned pid", { skip: process.platform !== "linux" }, async () => {
  const expected = fs.realpathSync("/tmp");
  const child = spawn("/bin/bash", ["-c", "cd /tmp && exec sleep 30"], {
    cwd: "/",
    stdio: "ignore",
  });
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    // spawn fires before bash runs cd. Keep reading until the directory
    // actually changes; the first successful /proc read is still "/".
    let cwd = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const result = await readLocalSessionCwd({
        protocol: "local",
        proc: { pid: child.pid },
      });
      if (result.success) cwd = result.cwd;
      if (cwd === expected) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(cwd, expected);
  } finally {
    child.kill("SIGKILL");
  }
});
