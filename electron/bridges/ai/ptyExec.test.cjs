const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  resolveEffectiveShellKind,
  execViaChannel,
} = require("./ptyExec.cjs");
const {
  buildWrappedCommand,
} = require("./ptyExecHelpers.cjs");

test("uses PowerShell wrapping when a session with no confirmed shell sees a PowerShell prompt", () => {
  // SSH sessions don't set shellKind (sshBridge never assigns one), which
  // is exactly the issue #841 case the override targets.
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS C:\\Users\\alice>"),
    "powershell",
  );
});

test("uses PowerShell wrapping when shellKind is 'unknown'", () => {
  assert.equal(
    resolveEffectiveShellKind("unknown", "PS C:\\Users\\alice>"),
    "powershell",
  );
});

test("does NOT override an explicit non-PowerShell shell kind even if the prompt looks like PowerShell", () => {
  // Defends against a malicious remote process spoofing a `PS ...>` line
  // on a real bash/zsh/cmd/fish/raw session to coerce a single
  // mis-wrapped command.
  assert.equal(
    resolveEffectiveShellKind("posix", "PS C:\\Users\\alice>"),
    "posix",
  );
  assert.equal(
    resolveEffectiveShellKind("fish", "PS C:\\Users\\alice>"),
    "fish",
  );
  assert.equal(
    resolveEffectiveShellKind("cmd", "PS C:\\Users\\alice>"),
    "cmd",
  );
  assert.equal(
    resolveEffectiveShellKind("raw", "PS C:\\Users\\alice>"),
    "raw",
  );
});

test("keeps powershell wrapping for an explicit powershell session even when nested into a non-PS shell", () => {
  // After `wsl` or similar, a confirmed PowerShell session may show a
  // posix prompt. We currently keep PowerShell wrapping (the user's
  // configured shell is the source of truth). Reverse detection would
  // be a separate feature; this test locks the current behavior so a
  // future change is intentional.
  assert.equal(
    resolveEffectiveShellKind("powershell", "alice@host:~$"),
    "powershell",
  );
  assert.equal(
    resolveEffectiveShellKind("powershell", ""),
    "powershell",
  );
});

test("recognizes a PowerShell prompt that has trailing whitespace", () => {
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS C:\\Users\\alice>   "),
    "powershell",
  );
});

test("recognizes a bare PowerShell prompt without a working directory", () => {
  assert.equal(resolveEffectiveShellKind(undefined, "PS>"), "powershell");
});

test("recognizes PowerShell on Linux/macOS prompts (`PS /home/alice>`)", () => {
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS /home/alice>"),
    "powershell",
  );
});

test("ignores ANSI-coloured PowerShell prompts when detecting the shell", () => {
  assert.equal(
    resolveEffectiveShellKind(undefined, "[32mPS C:\\Users\\alice>[0m"),
    "powershell",
  );
});

test("treats a CR-redrawn last line as the effective prompt, not the doubled string", () => {
  // PSReadLine / ConPTY emit `\r` to repaint the current line. Without
  // CR-as-newline normalization the regex would match a doubled prompt
  // string that never round-trips through the live PTY tail.
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS C:\\old>\rPS C:\\new>"),
    "powershell",
  );
});

test("rejects spoofed `PS >` (literal space then `>`) — default PowerShell never emits this", () => {
  assert.equal(resolveEffectiveShellKind(undefined, "PS >"), "posix");
});

test("falls back to posix when neither shell kind nor prompt is informative", () => {
  assert.equal(resolveEffectiveShellKind(undefined, ""), "posix");
  assert.equal(resolveEffectiveShellKind(null, undefined), "posix");
});

test("does not misclassify command output that happens to contain 'PS'", () => {
  assert.equal(resolveEffectiveShellKind(undefined, "PSO>"), "posix");
  assert.equal(resolveEffectiveShellKind(undefined, "ZIPS>"), "posix");
});

test("cmd wrapper uses interactive cmd variable expansion", () => {
  const wrapped = buildWrappedCommand("ipconfig /all", "cmd", "__NCMCP_TEST__");
  assert.match(wrapped, /"%__NCMCP_TEST___CMD%"/);
  assert.doesNotMatch(wrapped, /"%%__NCMCP_TEST___CMD%%"/);
});

test("posix wrapper isolates set -e failures from the parent login shell", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("  set -e\nfalse\necho SHOULD_NOT_PRINT", "posix", marker);
  const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.match(result.stdout, new RegExp(`${marker}_S`));
  assert.match(result.stdout, new RegExp(`${marker}_E:1`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_PRINT/);
});

test("posix wrapper keeps non-exiting state changes in the parent shell", () => {
  const marker = "__NCMCP_TEST__";
  const cwd = mkdtempSync(join(tmpdir(), "netcatty-pty-cd-"));
  try {
    const wrapped = buildWrappedCommand(`cd '${cwd.replace(/'/g, "'\\''")}'`, "posix", marker);
    const result = spawnSync("sh", ["-c", `${wrapped}pwd`], {
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL: "/bin/false",
      },
    });

    assert.equal(result.error, undefined);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
    assert.match(result.stdout, new RegExp(`${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("posix wrapper survives a failing command when parent errexit is already active", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("false", "posix", marker);
  const result = spawnSync("sh", ["-c", `set -e; ${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_S`));
  assert.match(result.stdout, new RegExp(`${marker}_E:1`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper isolates inside the current shell instead of SHELL env", { skip: process.platform === "win32" }, () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("set -e\n[[ 1 == 1 ]] && echo BASH_OK", "posix", marker);
  const result = spawnSync("bash", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/false",
    },
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /BASH_OK/);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper emits the end marker on a fresh line after exec without trailing newline", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("exec printf OK", "posix", marker);
  const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
    env: {
      ...process.env,
      SHELL: "/bin/sh",
    },
  });

  assert.equal(result.error, undefined);
  assert.match(result.stdout, new RegExp(`OK\\n${marker}_E:0`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("execViaChannel registers a pending-cancel marker before the SSH channel opens", () => {
  // Regression for the IPC-transit race surfaced by codex on #1101
  // problem 3: if `cancelPtyExecsForSession` runs while we're still
  // waiting on `sshClient.exec`'s callback, the cancel finds nothing in
  // `activePtyExecs` and the channel opens anyway. The fix registers a
  // pending marker synchronously so the cancel has something to act on.
  const track = new Map();
  let execCallback;
  const fakeClient = {
    exec(_command, callback) {
      // Capture but do not invoke yet — simulates the channel-open
      // delay where the race window lives.
      execCallback = callback;
    },
  };
  void execViaChannel(fakeClient, "echo hi", {
    trackForCancellation: track,
    chatSessionId: "chat-1",
    timeoutMs: 5_000,
  });
  assert.equal(track.size, 1, "pending marker should be registered before the channel opens");
  const entry = Array.from(track.values())[0];
  assert.equal(entry.chatSessionId, "chat-1");
  assert.equal(typeof entry.cancel, "function");
  // Drain the callback so the timeout the test set doesn't fire later.
  execCallback(new Error("test teardown"), null);
});

test("execViaChannel drops the pending marker and resolves cleanly when sshClient.exec throws synchronously", async () => {
  const track = new Map();
  const fakeClient = {
    exec() {
      throw new Error("client destroyed");
    },
  };
  const result = await execViaChannel(fakeClient, "echo hi", {
    trackForCancellation: track,
    chatSessionId: "chat-throw",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "client destroyed");
  assert.equal(track.size, 0, "pending marker must be removed even on sync throw");
});

test("execViaChannel short-circuits when cancel fires before the SSH channel opens", async () => {
  const track = new Map();
  let execCallback;
  const fakeClient = {
    exec(_command, callback) {
      execCallback = callback;
    },
  };
  const resultPromise = execViaChannel(fakeClient, "sleep 5", {
    trackForCancellation: track,
    chatSessionId: "chat-2",
    timeoutMs: 5_000,
  });

  // Cancel while still waiting for the channel-open callback.
  assert.equal(track.size, 1);
  for (const entry of track.values()) {
    if (entry.chatSessionId === "chat-2") entry.cancel();
  }

  // Now the channel "opens" — even though `sshClient.exec` would
  // hand us a working stream, we must short-circuit because the user
  // already cancelled.
  const fakeExecStream = {
    closed: false,
    close() { this.closed = true; },
    stderr: { on() {} },
    on() {},
  };
  execCallback(null, fakeExecStream);
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.error, "Cancelled");
  assert.equal(fakeExecStream.closed, true, "should close the now-unwanted stream");
  assert.equal(track.size, 0, "pending marker should be removed after callback runs");
});
