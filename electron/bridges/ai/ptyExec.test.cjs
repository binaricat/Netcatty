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
const {
  getFreshIdlePrompt,
  trackSessionIdlePrompt,
} = require("./shellUtils.cjs");

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

test("background PowerShell jobs exclude a changed prompt from results and snapshots", async () => {
  class CapturePty extends EventEmitter {
    write() {}
  }
  const pty = new CapturePty();
  const job = startPtyJob(pty, "Set-Location C:\\tmp; Write-Output 'DONE'", {
    shellKind: "unknown",
    loginShellHint: "cmd",
    timeoutMs: 1000,
    expectedPrompt: "PS C:\\Users\\alice>",
    maxBufferedChars: 1024,
    normalizeFinalOutput: false,
  });

  const endMarker = `${job.marker}_E:0`;
  pty.emit("data", Buffer.from(`${job.marker}_S\r\nDONE\r\n${endMarker.slice(0, 4)}`));
  const partialSnapshot = job.getSnapshot();
  assert.equal(partialSnapshot.stdout, "DONE\n");
  assert.equal(partialSnapshot.totalOutputChars, "DONE\n".length);
  assert.doesNotMatch(partialSnapshot.stdout, /__NC/);

  pty.emit("data", Buffer.from(`${endMarker.slice(4)}\r\nPS C:\\tmp>`));
  const result = await job.resultPromise;
  const snapshot = job.getSnapshot();

  assert.equal(result.ok, true);
  assert.equal(result.stdout, "DONE\n");
  assert.equal(snapshot.stdout, "DONE\n");
  assert.ok(snapshot.totalOutputChars >= partialSnapshot.totalOutputChars);
  assert.doesNotMatch(result.stdout, /PS C:\\\\tmp>/);
  assert.doesNotMatch(snapshot.stdout, /PS C:\\\\tmp>/);
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

test("pending-input clear prefix covers interactive shells and skips raw devices", () => {
  assert.equal(buildPendingInputClearPrefix("posix"), "\x15\x0b");
  assert.equal(buildPendingInputClearPrefix("fish"), "\x15\x0b");
  assert.equal(buildPendingInputClearPrefix("powershell"), "\x1bggd2147483647d\x1br\x1b\x1bi\x08");
  assert.equal(buildPendingInputClearPrefix("cmd"), "\x1b");
  assert.equal(buildPendingInputClearPrefix("raw"), "");
});

test("consecutive jobs wait for the PowerShell prompt after a split end marker", async () => {
  const writes = [];
  class CapturePty extends EventEmitter {
    write(data) {
      writes.push(String(data));
    }
  }
  const pty = new CapturePty();
  const session = { _loginShellKind: "cmd" };
  pty.on("data", (data) => trackSessionIdlePrompt(session, String(data)));
  trackSessionIdlePrompt(session, "Microsoft Windows...\r\nPS C:\\Users\\alice>");

  for (const probe of ["PROBE_1", "PROBE_2"]) {
    const job = startPtyJob(pty, `Write-Output '${probe}'`, {
      shellKind: session.shellKind,
      loginShellHint: session._loginShellKind,
      timeoutMs: 20,
      expectedPrompt: getFreshIdlePrompt(session),
    });
    const write = writes.at(-1);
    assert.match(write, /\$__NCMCP_/);
    assert.doesNotMatch(write, /cmd \/d \/s \/c/i);

    pty.emit(
      "data",
      Buffer.from(`${job.marker}_S\r\n${probe}\r\n${job.marker}_E:0\r\n`),
    );
    let settled = false;
    job.resultPromise.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(settled, false);

    pty.emit("data", Buffer.from("PS C:\\Users\\alice>"));
    const result = await job.resultPromise;
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, probe);
  }
});

test("non-target shells still finish at the end marker without waiting for a prompt", async () => {
  class CapturePty extends EventEmitter {
    write() {}
  }
  const pty = new CapturePty();
  const job = startPtyJob(pty, "printf done", {
    shellKind: "posix",
    timeoutMs: 20,
    expectedPrompt: "alice@host:~$",
  });
  pty.emit("data", Buffer.from(`${job.marker}_S\r\ndone\r\n${job.marker}_E:0\r\n`));

  let settled = false;
  job.resultPromise.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  if (!settled) job.cancel();
  assert.equal(settled, true);
});

test("cancel retries stop after an end marker while the prompt is delayed", async () => {
  const writes = [];
  class CapturePty extends EventEmitter {
    write(data) {
      writes.push(String(data));
    }
  }
  const pty = new CapturePty();
  const job = startPtyJob(pty, "Start-Sleep 10", {
    shellKind: "unknown",
    loginShellHint: "cmd",
    timeoutMs: 1000,
    expectedPrompt: "PS C:\\Users\\alice>",
  });
  job.cancel();
  assert.equal(writes.filter((write) => write === "\x03").length, 1);

  pty.emit("data", Buffer.from(`${job.marker}_S\r\n${job.marker}_E:130\r\n`));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(writes.filter((write) => write === "\x03").length, 1);

  pty.emit("data", Buffer.from("PS C:\\Users\\alice>"));
  const result = await job.resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.error, "Cancelled");
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stdout, /__NCMCP_/);
});

test("cancelled output strips an end marker delivered with the prompt", async () => {
  const writes = [];
  class CapturePty extends EventEmitter {
    write(data) {
      writes.push(String(data));
    }
  }
  const pty = new CapturePty();
  const job = startPtyJob(pty, "Start-Sleep 10", {
    shellKind: "unknown",
    loginShellHint: "cmd",
    timeoutMs: 1000,
    expectedPrompt: "PS C:\\Users\\alice>",
  });
  pty.emit("data", Buffer.from(`${job.marker}_S\r\n`));
  job.cancel();

  pty.emit(
    "data",
    Buffer.from(`${job.marker}_E:130\r\nPS C:\\Users\\alice>`),
  );
  const result = await job.resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.error, "Cancelled");
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stdout, /__NCMCP_/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(writes.filter((write) => write === "\x03").length, 1);
});

test("cancel after an end marker keeps waiting without interrupting the prompt", async () => {
  const writes = [];
  class CapturePty extends EventEmitter {
    write(data) {
      writes.push(String(data));
    }
  }
  const pty = new CapturePty();
  const job = startPtyJob(pty, "Write-Output 'DONE'", {
    shellKind: "unknown",
    loginShellHint: "cmd",
    timeoutMs: 1000,
    expectedPrompt: "PS C:\\Users\\alice>",
  });
  pty.emit("data", Buffer.from(`${job.marker}_S\r\nDONE\r\n${job.marker}_E:0\r\n`));
  job.cancel();

  let settled = false;
  job.resultPromise.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(writes.filter((write) => write === "\x03").length, 0);

  pty.emit("data", Buffer.from("PS C:\\Users\\alice>"));
  const result = await job.resultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "DONE");
});

test("stream termination after an end marker preserves the completed result", async (t) => {
  for (const termination of ["close", "error", "exit"]) {
    await t.test(termination, async () => {
      class CapturePty extends EventEmitter {
        write() {}

        onExit(callback) {
          this.exitCallback = callback;
          return { dispose() {} };
        }
      }
      const pty = new CapturePty();
      const job = startPtyJob(pty, "Write-Output 'DONE'", {
        shellKind: "unknown",
        loginShellHint: "cmd",
        timeoutMs: 1000,
        expectedPrompt: "PS C:\\Users\\alice>",
      });
      pty.emit("data", Buffer.from(`${job.marker}_S\r\nDONE\r\n${job.marker}_E:7\r\n`));
      if (termination === "error") {
        pty.emit("error", new Error("disconnected"));
      } else if (termination === "exit") {
        pty.exitCallback();
      } else {
        pty.emit("close");
      }

      const result = await job.resultPromise;
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 7);
      assert.equal(result.stdout, "DONE");
      assert.doesNotMatch(result.stdout, /__NCMCP_/);
      assert.equal(result.error, undefined);
    });
  }
});

test("a foreground wall deadline returns on time but blocks writes until the prompt returns", async () => {
  const writes = [];
  class CapturePty extends EventEmitter {
    write(data) {
      writes.push(String(data));
    }
  }
  const pty = new CapturePty();
  const session = { _loginShellKind: "cmd" };
  pty.on("data", (data) => trackSessionIdlePrompt(session, String(data)));
  trackSessionIdlePrompt(session, "PS C:\\Users\\alice>");

  const first = startPtyJob(pty, "Write-Output 'DONE'", {
    shellKind: session.shellKind,
    loginShellHint: session._loginShellKind,
    timeoutMs: 30,
    expectedPrompt: getFreshIdlePrompt(session),
    enforceWallTimeout: true,
  });
  pty.emit("data", Buffer.from(`${first.marker}_S\r\nDONE\r\n${first.marker}_E:0\r\n`));

  const deadlineGuard = Symbol("deadline guard");
  const firstResult = await Promise.race([
    first.resultPromise,
    new Promise((resolve) => setTimeout(() => resolve(deadlineGuard), 300)),
  ]);
  assert.notEqual(firstResult, deadlineGuard);
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.exitCode, 0);
  assert.equal(firstResult.stdout, "DONE");
  assert.equal(writes.filter((write) => write === "\x03").length, 0);

  assert.throws(
    () => startPtyJob(pty, "Write-Output 'TOO_EARLY'", {
      shellKind: session.shellKind,
      loginShellHint: session._loginShellKind,
      timeoutMs: 1000,
      expectedPrompt: getFreshIdlePrompt(session),
    }),
    (error) => (
      error?.code === "SHELL_PROMPT_PENDING"
      && /waiting for the shell prompt/i.test(error.message)
    ),
  );
  assert.equal(writes.length, 1);

  pty.emit("data", Buffer.from("PS C:\\Users\\alice>"));
  const second = startPtyJob(pty, "Write-Output 'NEXT'", {
    shellKind: session.shellKind,
    loginShellHint: session._loginShellKind,
    timeoutMs: 1000,
    expectedPrompt: getFreshIdlePrompt(session),
  });
  const secondWrite = writes.at(-1);
  assert.match(secondWrite, /\$__NCMCP_/);
  assert.doesNotMatch(secondWrite, /cmd \/d \/s \/c/i);
  pty.emit(
    "data",
    Buffer.from(`${second.marker}_S\r\nNEXT\r\n${second.marker}_E:0\r\nPS C:\\Users\\alice>`),
  );
  const secondResult = await second.resultPromise;
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.stdout, "NEXT");
  assert.equal(writes.filter((write) => write === "\x03").length, 0);
});

test("startPtyJob clears PowerShell input in Windows, Emacs, and Vi editor states", async () => {
  class PowerShellLinePty extends EventEmitter {
    constructor(editMode, { legacyVi = false } = {}) {
      super();
      this.editMode = editMode;
      this.legacyVi = legacyVi;
      this.pendingInput = "";
      this.cursor = 0;
      this.viInsertMode = true;
      this.viReplacePending = false;
      this.viChord = "";
      this.viChordDigits = "";
      this.emacsChord = false;
      this.submittedLines = [];
      this.writes = [];
    }

    setPendingInput(text, { cursor = text.length, viInsertMode = true } = {}) {
      this.pendingInput = text;
      this.cursor = cursor;
      this.viInsertMode = viInsertMode;
      this.viReplacePending = false;
      this.viChord = "";
      this.viChordDigits = "";
    }

    insert(text) {
      this.pendingInput = `${this.pendingInput.slice(0, this.cursor)}${text}${this.pendingInput.slice(this.cursor)}`;
      this.cursor += text.length;
    }

    applyEditKey(key) {
      if (this.editMode === "windows") {
        if (key === "\x1b") {
          this.pendingInput = "";
          this.cursor = 0;
        } else if (key === "\x08") {
          if (this.cursor > 0) {
            this.pendingInput = `${this.pendingInput.slice(0, this.cursor - 1)}${this.pendingInput.slice(this.cursor)}`;
            this.cursor -= 1;
          }
        } else {
          this.insert(key);
        }
        return;
      }

      if (this.editMode === "emacs") {
        if (this.emacsChord) {
          this.emacsChord = false;
          if (key.toLowerCase() === "r") {
            this.pendingInput = "";
            this.cursor = 0;
          }
        } else if (key === "\x1b") {
          this.emacsChord = true;
        } else if (key === "\x15") {
          this.pendingInput = this.pendingInput.slice(this.cursor);
          this.cursor = 0;
        } else if (key === "\x0b") {
          this.pendingInput = this.pendingInput.slice(0, this.cursor);
        } else if (key === "\x08") {
          if (this.cursor > 0) {
            this.pendingInput = `${this.pendingInput.slice(0, this.cursor - 1)}${this.pendingInput.slice(this.cursor)}`;
            this.cursor -= 1;
          }
        } else {
          this.insert(key);
        }
        return;
      }

      if (this.viReplacePending) {
        this.viReplacePending = false;
        return;
      }
      if (this.viChord) {
        const chord = this.viChord;
        if (chord === "d" && /[0-9]/.test(key)) {
          this.viChordDigits += key;
          return;
        }
        this.viChord = "";
        if (chord === "g" && key === "g") {
          this.cursor = 0;
        } else if (chord === "d" && key === "G" && !this.legacyVi) {
          this.pendingInput = this.pendingInput.slice(0, this.cursor);
        } else if (chord === "d" && key === "d") {
          // PSReadLine 2.0's dd clears the whole buffer. In 2.1+, dd clears
          // the requested number of logical lines.
          if (this.legacyVi) {
            this.pendingInput = "";
            this.cursor = 0;
          } else {
            const requestedLines = Number(this.viChordDigits || "1");
            const lineStart = this.pendingInput.lastIndexOf("\n", Math.max(0, this.cursor - 1)) + 1;
            let lineEnd = lineStart;
            let remaining = requestedLines;
            while (remaining > 0 && lineEnd < this.pendingInput.length) {
              const newline = this.pendingInput.indexOf("\n", lineEnd);
              if (newline === -1) {
                lineEnd = this.pendingInput.length;
                break;
              }
              lineEnd = newline + 1;
              remaining -= 1;
            }
            this.pendingInput = `${this.pendingInput.slice(0, lineStart)}${this.pendingInput.slice(lineEnd)}`;
            this.cursor = Math.min(lineStart, this.pendingInput.length);
          }
        }
        this.viChordDigits = "";
        return;
      }
      if (!this.viInsertMode) {
        if (key === "i") {
          this.viInsertMode = true;
        } else if (key === "r") {
          this.viReplacePending = true;
        } else if (key === "g" || key === "d") {
          this.viChord = key;
        }
        return;
      }
      if (key === "\x1b") {
        this.viInsertMode = false;
      } else if (key === "\x08") {
        if (this.cursor > 0) {
          this.pendingInput = `${this.pendingInput.slice(0, this.cursor - 1)}${this.pendingInput.slice(this.cursor)}`;
          this.cursor -= 1;
        }
      } else {
        this.insert(key);
      }
    }

    write(data) {
      const text = String(data);
      this.writes.push(text);

      const clearPrefix = buildPendingInputClearPrefix("powershell");
      assert.ok(text.startsWith(clearPrefix));
      for (const key of clearPrefix) this.applyEditKey(key);
      const wrapper = text.slice(clearPrefix.length);
      const submittedLine = this.viInsertMode
        ? `${this.pendingInput.slice(0, this.cursor)}${wrapper}${this.pendingInput.slice(this.cursor)}`
        : this.pendingInput;
      this.submittedLines.push(submittedLine);
      this.pendingInput = "";
      this.cursor = 0;

      const marker = submittedLine.match(/__NCMCP_[0-9a-z]+_[0-9a-f]+__/)?.[0];
      assert.ok(marker);
      queueMicrotask(() => {
        this.emit("data", Buffer.from(`${marker}_S\r\n${marker}_E:0\r\nPS C:\\Users\\alice>`));
      });
    }
  }

  const legacyPreviousPrefixPty = new PowerShellLinePty("vi", { legacyVi: true });
  legacyPreviousPrefixPty.setPendingInput("first line\n; Write-Output 'USER_SECOND'");
  for (const key of "\x1bggdG\x1br\x1b\x1bi\x08") legacyPreviousPrefixPty.applyEditKey(key);
  assert.match(legacyPreviousPrefixPty.pendingInput, /USER_SECOND/);

  const editorCases = [
    { editMode: "windows", cursorAtStart: false, viInsertMode: true, multiline: false },
    { editMode: "emacs", cursorAtStart: true, viInsertMode: true, multiline: false },
    { editMode: "vi", cursorAtStart: true, viInsertMode: true, multiline: false },
    { editMode: "vi", cursorAtStart: true, viInsertMode: false, multiline: false },
    { editMode: "vi", cursorAtStart: false, viInsertMode: true, multiline: true },
    { editMode: "vi", cursorAtStart: false, viInsertMode: false, multiline: true },
    { editMode: "vi", cursorAtStart: false, viInsertMode: true, multiline: true, legacyVi: true },
    { editMode: "vi", cursorAtStart: false, viInsertMode: false, multiline: true, legacyVi: true },
  ];
  for (const { editMode, cursorAtStart, viInsertMode, multiline, legacyVi = false } of editorCases) {
    const pty = new PowerShellLinePty(editMode, { legacyVi });
    const commands = ["Write-Output 'one'", "Write-Output 'two'"];
    for (const [index, command] of commands.entries()) {
      if (index === 1) {
        // Model input accepted by PSReadLine before its echo reaches the
        // tracked PTY output. The leading semicolon makes a retained suffix
        // executable after the wrapper, matching the dangerous Vi edge case.
        const pendingInput = multiline
          ? "; Write-Output 'USER'\nWrite-Output 'USER_SECOND'"
          : cursorAtStart
            ? "; Write-Output 'USER'"
            : "Write-Output 'USER'; ";
        pty.setPendingInput(pendingInput, {
          cursor: cursorAtStart ? 0 : pendingInput.length,
          viInsertMode,
        });
      }
      const job = startPtyJob(pty, command, {
        shellKind: "unknown",
        loginShellHint: "cmd",
        timeoutMs: 50,
        expectedPrompt: "PS C:\\Users\\alice>",
      });
      await job.resultPromise;
    }

    assert.equal(pty.writes.length, 2);
    assert.equal(pty.submittedLines.length, 2);
    for (const [index, submittedLine] of pty.submittedLines.entries()) {
      assert.ok(pty.writes[index].startsWith("\x1bggd2147483647d\x1br\x1b\x1bi\x08$__NCMCP_"));
      assert.ok(submittedLine.startsWith("$__NCMCP_"));
      assert.doesNotMatch(submittedLine, /Write-Output 'USER'/);
      assert.doesNotMatch(submittedLine, /Write-Output 'USER_SECOND'/);
      assert.doesNotMatch(submittedLine, /cmd \/d \/s \/c/i);
    }
  }
});

test("startPtyJob keeps the clear prefix for non-PowerShell sessions", async () => {
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
