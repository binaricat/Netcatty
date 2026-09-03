const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { mkdtempSync, rmSync, realpathSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  execViaPty,
  startPtyJob,
  DEFAULT_FOREGROUND_PTY_CAPTURE_CHARS,
  resolveEffectiveShellKind,
  execViaChannel,
  execViaRawPty,
} = require("./ptyExec.cjs");
const {
  buildPendingInputClearPrefix,
  buildWrappedCommand,
} = require("./ptyExecHelpers.cjs");

class ShellBackedPty extends EventEmitter {
  write(data) {
    if (data === "\x03") return;
    const script = String(data).replace(/^\x15\x0b/, "");
    const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });
    queueMicrotask(() => {
      this.emit("data", Buffer.from(result.stdout));
    });
  }
}

function markerFromWrite(data) {
  return String(data).match(/(__NCMCP_[a-z0-9]+_[0-9a-f]+__)/i)?.[1] || null;
}

test("execViaPty completes when command output has no trailing newline", async () => {
  const result = await execViaPty(new ShellBackedPty(), "printf 'abc'", {
    shellKind: "posix",
    timeoutMs: 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdout, "abc");
  assert.equal(result.exitCode, 0);
});

test("foreground PTY capture bounds a single 20 MiB output chunk and keeps its tail", async () => {
  class LargeOutputPty extends EventEmitter {
    write(data) {
      const marker = markerFromWrite(data);
      if (!marker) return;
      queueMicrotask(() => {
        this.emit("data", Buffer.from(
          `${marker}_S\n${"x".repeat(20 * 1024 * 1024)}TAIL\n${marker}_E:0\n`,
        ));
      });
    }
  }

  const result = await execViaPty(new LargeOutputPty(), "large-output", {
    shellKind: "posix",
    timeoutMs: 1_000,
  });
  assert.equal(result.ok, true);
  assert.ok(result.stdout.length <= DEFAULT_FOREGROUND_PTY_CAPTURE_CHARS);
  assert.match(result.stdout, /TAIL$/u);
  assert.equal(result.outputTruncated, true);
  assert.ok(result.outputBaseOffset > 0);
});

test("foreground PTY capture preserves UTF-8 and markers split across chunks", async () => {
  class SplitOutputPty extends EventEmitter {
    write(data) {
      const marker = markerFromWrite(data);
      if (!marker) return;
      queueMicrotask(() => {
        const start = Buffer.from(`${marker}_S\n`);
        const content = Buffer.from("中文回夝", "utf8");
        const end = Buffer.from(`\n${marker}_E:0\n`);
        this.emit("data", start.subarray(0, 7));
        this.emit("data", start.subarray(7));
        this.emit("data", content.subarray(0, 2));
        this.emit("data", content.subarray(2));
        this.emit("data", end.subarray(0, 9));
        this.emit("data", end.subarray(9));
      });
    }
  }

  const result = await execViaPty(new SplitOutputPty(), "split-output", {
    shellKind: "posix",
    timeoutMs: 1_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "中文回夝");
});

test("foreground PTY timeout returns only a bounded tail", async () => {
  class TimedOutPty extends EventEmitter {
    signal() {}
    write(data) {
      const marker = markerFromWrite(data);
      if (!marker || this.started) return;
      this.started = true;
      queueMicrotask(() => {
        this.emit("data", Buffer.from(`${marker}_S\n${"y".repeat(20 * 1024 * 1024)}`));
      });
    }
  }

  const result = await execViaPty(new TimedOutPty(), "timeout-output", {
    shellKind: "posix",
    timeoutMs: 5,
    enforceWallTimeout: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/i);
  assert.ok(result.stdout.length <= DEFAULT_FOREGROUND_PTY_CAPTURE_CHARS);
  assert.equal(result.outputTruncated, true);
});

test("foreground PTY cancellation returns only a bounded tail", async () => {
  class CancelledPty extends EventEmitter {
    signal() {}
    write(data) {
      const marker = markerFromWrite(data);
      if (!marker || this.started) return;
      this.started = true;
      queueMicrotask(() => {
        this.emit("data", Buffer.from(`${marker}_S\n${"z".repeat(20 * 1024 * 1024)}`));
      });
    }
  }

  const pty = new CancelledPty();
  const job = startPtyJob(pty, "cancel-output", {
    shellKind: "posix",
    timeoutMs: 1_000,
    expectedPrompt: "$ ",
  });
  await new Promise((resolve) => setImmediate(resolve));
  job.cancel();
  pty.emit("data", Buffer.from("$ "));
  const result = await job.resultPromise;
  assert.equal(result.ok, false);
  assert.match(result.error, /cancelled/i);
  assert.ok(result.stdout.length <= DEFAULT_FOREGROUND_PTY_CAPTURE_CHARS);
  assert.equal(result.outputTruncated, true);
});

test("background PTY jobs preserve output that has no trailing newline", async () => {
  const job = startPtyJob(new ShellBackedPty(), "printf 'abc'", {
    shellKind: "posix",
    timeoutMs: 1000,
    maxBufferedChars: 1024,
  });
  const result = await job.resultPromise;

  assert.equal(result.ok, true);
  assert.equal(result.stdout, "abc");
  assert.equal(result.exitCode, 0);
});

test("uses PowerShell wrapping when a session with no confirmed shell sees a PowerShell prompt", () => {
  // SSH sessions don't set shellKind (sshBridge never assigns one), which
  // is exactly the issue #841 case the override targets.
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS C:\\Users\\alice>"),
    "powershell",
  );
});

test("uses cmd wrapping when a session with no confirmed shell sees a cmd.exe prompt", () => {
  // Windows OpenSSH defaults to cmd.exe; without this override AI types a
  // posix wrapper into cmd and hangs until Stop (issue #2959).
  assert.equal(
    resolveEffectiveShellKind(undefined, "C:\\Users\\alice>"),
    "cmd",
  );
  assert.equal(resolveEffectiveShellKind("unknown", "C:\\>"), "cmd");
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

test("loginShellHint selects fish/posix/powershell/cmd without pinning confirmed shellKind", () => {
  assert.equal(
    resolveEffectiveShellKind(undefined, "user@host:~$", { loginShellHint: "fish" }),
    "fish",
  );
  assert.equal(
    resolveEffectiveShellKind(undefined, "user@host:~$", { loginShellHint: "posix" }),
    "posix",
  );
  assert.equal(
    resolveEffectiveShellKind(undefined, "", { loginShellHint: "powershell" }),
    "powershell",
  );
  assert.equal(
    resolveEffectiveShellKind(undefined, "", { loginShellHint: "cmd" }),
    "cmd",
  );
  // Live PowerShell prompt still wins over a posix/fish login hint.
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS C:\\Users\\alice>", { loginShellHint: "posix" }),
    "powershell",
  );
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS C:\\Users\\alice>", { loginShellHint: "fish" }),
    "powershell",
  );
  // Live opposing Windows prompt wins over a Windows DefaultShell soft hint.
  assert.equal(
    resolveEffectiveShellKind(undefined, "C:\\Users\\alice>", { loginShellHint: "powershell" }),
    "cmd",
  );
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS C:\\Users\\alice>", { loginShellHint: "cmd" }),
    "powershell",
  );
  // Live POSIX prompt (e.g. WSL nested from Windows OpenSSH) overrides a
  // PowerShell/cmd soft hint so AI does not type a Windows wrapper into bash.
  assert.equal(
    resolveEffectiveShellKind(undefined, "user@host:~$", { loginShellHint: "powershell" }),
    "posix",
  );
  assert.equal(
    resolveEffectiveShellKind(undefined, "alice@wsl:/mnt/c$", { loginShellHint: "cmd" }),
    "posix",
  );
  // Confirmed shellKind is never overridden by a login hint.
  assert.equal(
    resolveEffectiveShellKind("posix", "user@host:~$", { loginShellHint: "fish" }),
    "posix",
  );
});

test("live fish banner hint selects fish wrapping over posix/unknown base kinds (#3261)", () => {
  // User typed a nested `fish` on a POSIX login shell: the login-shell probe
  // correctly reports posix, but the interactive shell is fish. The banner
  // tracked from the PTY wins so the fish wrapper is used.
  assert.equal(
    resolveEffectiveShellKind("posix", "user@host:~$", { liveShellKind: "fish" }),
    "fish",
  );
  assert.equal(
    resolveEffectiveShellKind(undefined, "", { liveShellKind: "fish", loginShellHint: "posix" }),
    "fish",
  );
  assert.equal(
    resolveEffectiveShellKind("fish", "user@host:~$", { liveShellKind: "fish" }),
    "fish",
  );
  // Windows and raw/serial sessions are never overridden by the fish banner.
  assert.equal(
    resolveEffectiveShellKind("powershell", "", { liveShellKind: "fish" }),
    "powershell",
  );
  assert.equal(
    resolveEffectiveShellKind("cmd", "", { liveShellKind: "fish" }),
    "cmd",
  );
  assert.equal(
    resolveEffectiveShellKind("raw", "", { liveShellKind: "fish" }),
    "raw",
  );
  // Without a live banner nothing changes.
  assert.equal(
    resolveEffectiveShellKind("posix", "user@host:~$", { loginShellHint: "fish" }),
    "posix",
  );
});

test("pending-input clear prefix covers interactive shells and skips raw devices", () => {
  assert.equal(buildPendingInputClearPrefix("posix"), "\x15\x0b");
  assert.equal(buildPendingInputClearPrefix("fish"), "\x15\x0b");
  assert.equal(buildPendingInputClearPrefix("powershell"), "\x1b\x15\x0b");
  assert.equal(buildPendingInputClearPrefix("cmd"), "\x1b");
  assert.equal(buildPendingInputClearPrefix("raw"), "");
});

test("startPtyJob writes the clear prefix before the wrapper", async () => {
  const writes = [];
  class CapturePty extends EventEmitter {
    write(data) {
      writes.push(String(data));
    }
  }
  const pty = new CapturePty();
  const job = startPtyJob(pty, "echo hi", {
    shellKind: "posix",
    timeoutMs: 50,
    expectedPrompt: "$ ",
  });
  assert.equal(writes.length, 1);
  assert.ok(writes[0].startsWith("\x15\x0b"));
  assert.match(writes[0], /__NCMCP_/);
  job.cancel();
  pty.emit("data", Buffer.from("$ "));
  await job.resultPromise;
});

test("startPtyJob forwards liveShellKind so nested fish gets the fish wrapper", async () => {
  // Regression test for #3261/#3262: the handler passes
  // liveShellKind: session._liveShellKind to execViaPty → startPtyJob,
  // which must forward it to resolveEffectiveShellKind. Without that
  // forwarding a nested fish session still received the POSIX wrapper.
  const writes = [];
  class CapturePty extends EventEmitter {
    write(data) {
      writes.push(String(data));
    }
  }
  const pty = new CapturePty();
  const job = startPtyJob(pty, "echo hi", {
    shellKind: "posix",
    liveShellKind: "fish",
    timeoutMs: 50,
    expectedPrompt: "user@host:~$",
  });
  assert.equal(writes.length, 1);
  // The pending-input clear prefix (if any) comes before the wrapper.
  const wrapped = writes[0].replace(/^[\x15\x0b\x1b]+/, "");
  // Fish wrapper signature: leading space + fish `set`/`set -l` syntax.
  assert.ok(wrapped.startsWith(" set "));
  assert.ok(wrapped.includes("set -l "));
  // Sanity: posix wrapper would have started with the marker assignment.
  assert.ok(!wrapped.startsWith("__NCMCP_"));
  job.cancel();
  pty.emit("data", Buffer.from("user@host:~$"));
  await job.resultPromise;
});

test("startPtyJob invalidates the live fish hint when the wrapper start marker never arrives", async () => {
  // Codex P1 on #3262: when a user exits nested fish back to a parent shell
  // with a custom prompt, the stale live fish hint keeps fish-wrapping
  // commands into a POSIX shell forever. The wrapper fails before its start
  // marker, so the startup timeout is the signal that the hint is stale.
  const writes = [];
  let invalidated = 0;
  class NoMarkerPty extends EventEmitter {
    write(data) {
      writes.push(String(data));
      // Simulate a POSIX shell that chokes on the fish wrapper: it echoes
      // garbage but never emits the start marker.
      queueMicrotask(() => {
        this.emit("data", Buffer.from("bash: syntax error near unexpected token\r\nuser@host ❯ "));
      });
    }
  }
  const pty = new NoMarkerPty();
  const job = startPtyJob(pty, "echo hi", {
    shellKind: "posix",
    liveShellKind: "fish",
    timeoutMs: 50,
    onLiveShellKindInvalidated: () => { invalidated += 1; },
  });
  const result = await job.resultPromise;
  assert.ok(result.error.includes("start marker never arrived"));
  assert.equal(invalidated, 1);

  // Without the live fish hint driving the wrapper, no invalidation fires.
  invalidated = 0;
  const job2 = startPtyJob(new NoMarkerPty(), "echo hi", {
    shellKind: "posix",
    timeoutMs: 50,
    onLiveShellKindInvalidated: () => { invalidated += 1; },
  });
  await job2.resultPromise;
  assert.equal(invalidated, 0);
});

test("execViaRawPty does not prepend a line-clear before device commands", async () => {
  const writes = [];
  const port = new EventEmitter();
  port.write = (data) => {
    writes.push(String(data));
  };
  const abort = new AbortController();
  const resultPromise = execViaRawPty(port, "show version", {
    timeoutMs: 200,
    idleMs: 20,
    abortSignal: abort.signal,
  });
  assert.deepEqual(writes, ["show version\r"]);
  abort.abort();
  const result = await resultPromise;
  assert.equal(result.ok, false);
});

test("cmd wrapper uses interactive cmd variable expansion", () => {
  const wrapped = buildWrappedCommand("ipconfig /all", "cmd", "__NCMCP_TEST__");
  assert.match(wrapped, /"%__NCMCP_TEST___CMD%"/);
  assert.doesNotMatch(wrapped, /"%%__NCMCP_TEST___CMD%%"/);
});

// Issue #1850: agent-generated commands run inside a subshell so that
// shell-terminating constructs (set -e + failure, exit, ...) end only the
// subshell, never the user's active login shell / SSH session.
test("posix wrapper isolates set -e failures from the active shell", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand(
    "set -e\ncd /nonexistent-dir-1850\necho SHOULD_NOT_PRINT",
    "posix",
    marker,
  );
  const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_S`));
  assert.match(result.stdout, new RegExp(`${marker}_E:[1-9]`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_PRINT/);
});

test("posix wrapper types multi-line commands as one physical line (no PS2 leak) and preserves semantics", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand(
    "echo first\necho \"it's quoted\"\n\necho last",
    "posix",
    marker,
  );
  // A single physical line: the interactive shell must never show PS2
  // ("> ") continuation echoes, which would leak past the preload filter.
  assert.equal(wrapped.indexOf("\n"), wrapped.length - 1);

  const result = spawnSync("sh", ["-c", wrapped], { encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.match(result.stdout, /first\n/);
  assert.match(result.stdout, /it's quoted\n/);
  assert.match(result.stdout, /last\n/);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
});

test("posix wrapper isolates explicit exit from the active shell and reports its code", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("exit 7", "posix", marker);
  const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_E:7`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper keeps cd contained in the subshell (documented trade-off)", () => {
  const marker = "__NCMCP_TEST__";
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "netcatty-pty-cd-")));
  try {
    const wrapped = buildWrappedCommand("cd / && pwd", "posix", marker);
    const result = spawnSync("sh", ["-c", `${wrapped}pwd`], {
      encoding: "utf8",
      cwd,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
    const lines = result.stdout.trim().split("\n");
    // The command itself sees the cd take effect (pwd inside prints /)...
    assert.ok(lines.includes("/"), `expected command pwd "/" in: ${result.stdout}`);
    // ...but the active shell's cwd is untouched (trailing pwd prints cwd).
    assert.equal(lines[lines.length - 1], cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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
      // Capture but do not invoke yet � simulates the channel-open
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
  let invalidations = 0;
  const fakeClient = {
    exec(_command, callback) {
      execCallback = callback;
    },
    destroy() { invalidations += 1; },
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

  const result = await Promise.race([
    resultPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("pending cancel did not settle")), 25)),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error, "Cancelled");
  assert.equal(track.size, 0, "pending marker should be removed as soon as cancel settles");
  assert.equal(invalidations, 1, "pending cancel must invalidate the uncancellable channel-open request");

  // Now the channel "opens" � even though `sshClient.exec` would
  // hand us a working stream, we must short-circuit because the user
  // already cancelled.
  const fakeExecStream = {
    closed: false,
    close() { this.closed = true; },
    stderr: { on() {} },
    on() {},
  };
  execCallback(null, fakeExecStream);
  assert.equal(fakeExecStream.closed, true, "should close the now-unwanted stream");
});

test("execViaChannel times out while SSH never opens the exec channel", async () => {
  const track = new Map();
  let execCallback;
  let invalidations = 0;
  const fakeClient = {
    exec(_command, callback) {
      execCallback = callback;
    },
    destroy() { invalidations += 1; },
  };
  const result = await Promise.race([
    execViaChannel(fakeClient, "echo hi", {
      trackForCancellation: track,
      chatSessionId: "chat-opening-timeout",
      timeoutMs: 5,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("opening timeout did not settle")), 50)),
  ]);

  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
  assert.equal(track.size, 0);
  assert.equal(invalidations, 1);

  const lateStream = {
    closed: false,
    close() { this.closed = true; },
    stderr: { on() {} },
    on() {},
  };
  execCallback(null, lateStream);
  assert.equal(lateStream.closed, true, "late exec channels must be closed after opening timeout");
});

test("execViaChannel terminates the command when combined output exceeds its hard limit", async () => {
  const track = new Map();
  const execStream = new EventEmitter();
  execStream.stderr = new EventEmitter();
  execStream.closed = false;
  execStream.close = () => { execStream.closed = true; };
  execStream.destroy = () => { execStream.closed = true; };
  const fakeClient = {
    exec(_command, callback) {
      callback(null, execStream);
    },
  };

  const resultPromise = execViaChannel(fakeClient, "yes", {
    trackForCancellation: track,
    chatSessionId: "chat-output-limit",
    timeoutMs: 5_000,
    maxOutputBytes: 5,
  });
  execStream.emit("data", Buffer.from("abc"));
  execStream.stderr.emit("data", Buffer.from("de"));
  execStream.emit("data", Buffer.from("f"));

  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.stdout, "abc");
  assert.equal(result.stderr, "de");
  assert.equal(result.exitCode, -1);
  assert.match(result.error, /output exceeded.*5 byte/i);
  assert.equal(execStream.closed, true, "the noisy remote process must be terminated");
  assert.equal(track.size, 0, "the cancelled exec channel must not remain tracked");
  assert.equal(execStream.listenerCount("data"), 0);
  assert.equal(execStream.stderr.listenerCount("data"), 0);
  assert.equal(execStream.listenerCount("close"), 0);
});

test("execViaChannel settles and releases listeners when the SSH channel errors", async () => {
  const track = new Map();
  const execStream = new EventEmitter();
  execStream.stderr = new EventEmitter();
  execStream.closed = false;
  execStream.close = () => { execStream.closed = true; };
  execStream.destroy = () => { execStream.closed = true; };
  const fakeClient = {
    exec(_command, callback) {
      callback(null, execStream);
    },
  };

  const resultPromise = execViaChannel(fakeClient, "echo hi", {
    trackForCancellation: track,
    chatSessionId: "chat-channel-error",
    timeoutMs: 5_000,
  });
  execStream.emit("data", Buffer.from("partial"));
  execStream.emit("error", new Error("channel fault"));

  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.stdout, "partial");
  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, -1);
  assert.match(result.error, /channel fault/i);
  assert.equal(execStream.closed, true);
  assert.equal(track.size, 0);
  assert.equal(execStream.listenerCount("data"), 0);
  assert.equal(execStream.stderr.listenerCount("data"), 0);
  assert.equal(execStream.stderr.listenerCount("error"), 0);
  assert.equal(execStream.listenerCount("close"), 0);
  assert.equal(execStream.listenerCount("error"), 0);
});

function createExecChannelHarness() {
  const execStream = new EventEmitter();
  execStream.stderr = new EventEmitter();
  execStream.closed = false;
  execStream.close = () => { execStream.closed = true; };
  execStream.destroy = () => { execStream.closed = true; };
  return {
    execStream,
    fakeClient: {
      exec(_command, callback) {
        callback(null, execStream);
      },
    },
  };
}

test("execViaChannel preserves UTF-8 split across stdout chunks", async () => {
  const { execStream, fakeClient } = createExecChannelHarness();
  const resultPromise = execViaChannel(fakeClient, "printf unicode", { timeoutMs: 5_000 });
  const bytes = Buffer.from("中文", "utf8");
  execStream.emit("data", bytes.subarray(0, 2));
  execStream.emit("data", bytes.subarray(2, 4));
  execStream.emit("data", bytes.subarray(4));
  execStream.emit("close", 0);

  assert.deepEqual(await resultPromise, {
    ok: true,
    stdout: "中文",
    stderr: "",
    exitCode: 0,
  });
});

test("execViaChannel decodes interleaved stdout and stderr independently", async () => {
  const { execStream, fakeClient } = createExecChannelHarness();
  const resultPromise = execViaChannel(fakeClient, "printf unicode", { timeoutMs: 5_000 });
  const stdoutBytes = Buffer.from("中", "utf8");
  const stderrBytes = Buffer.from("文", "utf8");
  execStream.emit("data", stdoutBytes.subarray(0, 2));
  execStream.stderr.emit("data", stderrBytes.subarray(0, 1));
  execStream.emit("data", stdoutBytes.subarray(2));
  execStream.stderr.emit("data", stderrBytes.subarray(1));
  execStream.emit("close", 0);

  assert.deepEqual(await resultPromise, {
    ok: true,
    stdout: "中",
    stderr: "文",
    exitCode: 0,
  });
});

test("execViaChannel omits an incomplete UTF-8 character at the output limit", async () => {
  const { execStream, fakeClient } = createExecChannelHarness();
  const resultPromise = execViaChannel(fakeClient, "printf unicode", {
    timeoutMs: 5_000,
    maxOutputBytes: 2,
  });
  execStream.emit("data", Buffer.from("中", "utf8"));

  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /�/u);
  assert.match(result.error, /output exceeded.*2 byte/i);
  assert.equal(execStream.closed, true);
});

test("execViaChannel cancellation never exposes an incomplete UTF-8 character", async () => {
  const track = new Map();
  const { execStream, fakeClient } = createExecChannelHarness();
  const resultPromise = execViaChannel(fakeClient, "printf unicode", {
    timeoutMs: 5_000,
    trackForCancellation: track,
    chatSessionId: "chat-unicode-cancel",
  });
  execStream.emit("data", Buffer.from("中", "utf8").subarray(0, 2));
  const entry = [...track.values()].find((candidate) => (
    candidate.chatSessionId === "chat-unicode-cancel"
  ));
  entry.cancel();

  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stdout, /�/u);
  assert.equal(result.error, "Cancelled");
});
