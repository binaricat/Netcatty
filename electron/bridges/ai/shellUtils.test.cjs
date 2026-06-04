const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildWindowsShellCommandLine,
  extractTrailingIdlePrompt,
  getFreshIdlePrompt,
  isDefaultPowerShellPromptLine,
  isPlausibleCliVersionOutput,
  looksLikeIdleAutoLogout,
  prepareCommandForSpawn,
  resolveClaudeCodeExecutableForSdk,
  trackSessionIdlePrompt,
} = require("./shellUtils.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("extracts a trailing PowerShell idle prompt", () => {
  assert.equal(
    extractTrailingIdlePrompt("Microsoft Windows...\r\nPS C:\\Users\\alice>"),
    "PS C:\\Users\\alice>",
  );
});

test("preserves trailing whitespace on a captured PowerShell prompt", () => {
  // The wrapper-selection logic trims this, but the suffix-match logic in
  // hasExpectedPromptSuffix() compares against raw PTY bytes, so the trailing
  // space PowerShell emits after `>` must round-trip unchanged.
  assert.equal(
    extractTrailingIdlePrompt("Microsoft Windows...\r\nPS C:\\Users\\alice> "),
    "PS C:\\Users\\alice> ",
  );
});

test("extracts a bare PowerShell prompt with no working directory", () => {
  assert.equal(extractTrailingIdlePrompt("welcome\r\nPS>"), "PS>");
});

test("does not extract content that merely looks PowerShell-ish", () => {
  // Any non-prompt output ending in `PSO>` or `ZIPS>` would have produced a
  // trailing newline before the next prompt; this guards against the regex
  // accidentally matching command output that just happens to contain "PS".
  assert.equal(extractTrailingIdlePrompt("nope\r\nPSO>"), "");
  assert.equal(extractTrailingIdlePrompt("nope\r\nZIPS>"), "");
});

test("rejects `PS >` (literal `PS` + space + `>`) so spoofed scripts can't masquerade as a default prompt", () => {
  // Default PowerShell never emits this shape; rejecting it makes the
  // override harder to coerce via printed output.
  assert.equal(extractTrailingIdlePrompt("welcome\r\nPS >"), "");
});

test("treats CR repaints as line breaks so only the redrawn line is captured", () => {
  // PSReadLine / ConPTY emit bare `\r` to repaint the current line. The
  // captured prompt must equal the visible last line, not the
  // concatenation of every overwritten frame, so hasExpectedPromptSuffix
  // can still match the live PTY tail later.
  assert.equal(
    extractTrailingIdlePrompt("PS C:\\old>\rPS C:\\new>"),
    "PS C:\\new>",
  );
});

test("isDefaultPowerShellPromptLine matches default shapes and rejects look-alikes", () => {
  assert.equal(isDefaultPowerShellPromptLine("PS C:\\Users\\alice>"), true);
  assert.equal(isDefaultPowerShellPromptLine("PS /home/alice>"), true);
  assert.equal(isDefaultPowerShellPromptLine("PS>"), true);
  assert.equal(isDefaultPowerShellPromptLine("PS >"), false);
  assert.equal(isDefaultPowerShellPromptLine("PSO>"), false);
  assert.equal(isDefaultPowerShellPromptLine("ZIPS>"), false);
  assert.equal(isDefaultPowerShellPromptLine(""), false);
  assert.equal(isDefaultPowerShellPromptLine(null), false);
});

test("isPlausibleCliVersionOutput rejects stack traces and file URLs", () => {
  assert.equal(isPlausibleCliVersionOutput("2.1.123 (Claude Code)"), true);
  assert.equal(isPlausibleCliVersionOutput("codex-cli 0.125.0"), true);
  assert.equal(isPlausibleCliVersionOutput("file:///opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js:95"), false);
  assert.equal(isPlausibleCliVersionOutput("TypeError: Cannot read properties of undefined"), false);
  assert.equal(isPlausibleCliVersionOutput("    at runCli (cli.js:10:1)"), false);
  assert.equal(isPlausibleCliVersionOutput("permission denied"), false);
  assert.equal(isPlausibleCliVersionOutput("Usage: claude [options]"), false);
});

test("buildWindowsShellCommandLine quotes command paths and args with spaces", () => {
  assert.equal(
    buildWindowsShellCommandLine("C:\\Program Files\\Codex\\codex.cmd", ["login", "status"]),
    "\"C:\\Program Files\\Codex\\codex.cmd\" \"login\" \"status\"",
  );
});

test("prepareCommandForSpawn wraps Windows cmd shims as a single shell command", () => {
  const result = prepareCommandForSpawn("C:\\Program Files\\Codex\\codex.cmd", ["--version"]);
  if (process.platform === "win32") {
    assert.deepEqual(result, {
      command: "\"C:\\Program Files\\Codex\\codex.cmd\" \"--version\"",
      args: [],
      shell: true,
    });
  } else {
    assert.deepEqual(result, {
      command: "C:\\Program Files\\Codex\\codex.cmd",
      args: ["--version"],
      shell: false,
    });
  }
});

test("resolveClaudeCodeExecutableForSdk maps Windows npm cmd shim to Claude Code cli.js", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-claude-shim-"));
  try {
    const shimPath = path.join(tmp, "claude.cmd");
    const scriptPath = path.join(tmp, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, "", "utf8");
    fs.writeFileSync(
      shimPath,
      '@ECHO off\r\nnode "%basedir%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
      "utf8",
    );

    assert.equal(resolveClaudeCodeExecutableForSdk(shimPath, "win32"), scriptPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeExecutableForSdk leaves non-Windows Claude paths unchanged", () => {
  assert.equal(
    resolveClaudeCodeExecutableForSdk("/usr/local/bin/claude", "darwin"),
    "/usr/local/bin/claude",
  );
});

test("resolveClaudeCodeExecutableForSdk keeps Windows cmd shim when Claude Code cli.js is missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-claude-missing-cli-"));
  try {
    const shimPath = path.join(tmp, "claude.cmd");
    fs.writeFileSync(
      shimPath,
      '@ECHO off\r\nnode "%basedir%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
      "utf8",
    );

    assert.equal(resolveClaudeCodeExecutableForSdk(shimPath, "win32"), shimPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("tracks PowerShell idle prompt after SSH output", () => {
  const session = {};

  const prompt = trackSessionIdlePrompt(session, "Last login...\r\nPS C:\\Windows\\System32>");

  assert.equal(prompt, "PS C:\\Windows\\System32>");
  assert.equal(session.lastIdlePrompt, "PS C:\\Windows\\System32>");
  assert.equal(typeof session.lastIdlePromptAt, "number");
});

test("getFreshIdlePrompt returns the cached prompt when the live tail still ends with it", () => {
  const session = {
    lastIdlePrompt: "PS C:\\Users\\alice>",
    _promptTrackTail: "Microsoft Windows...\r\nPS C:\\Users\\alice>",
  };
  assert.equal(getFreshIdlePrompt(session), "PS C:\\Users\\alice>");
});

test("getFreshIdlePrompt drops a stale prompt when the live tail has moved on (e.g. exited PowerShell)", () => {
  // Simulates: SSH session entered PowerShell, captured `PS C:\>`, then
  // user `exit`-ed back into a shell with a custom prompt the regex
  // doesn't recognize. lastIdlePrompt is still the old PS line, but the
  // visible tail now shows the new prompt — we must NOT keep handing
  // the stale value to resolveEffectiveShellKind.
  const session = {
    lastIdlePrompt: "PS C:\\Users\\alice>",
    _promptTrackTail: "PS C:\\Users\\alice>\r\nexit\r\nlogout\r\n❯ ",
  };
  assert.equal(getFreshIdlePrompt(session), "");
});

test("getFreshIdlePrompt drops a stale prompt when the live tail switched to cmd.exe", () => {
  const session = {
    lastIdlePrompt: "PS C:\\Users\\alice>",
    _promptTrackTail: "PS C:\\Users\\alice>\r\ncmd\r\nMicrosoft Windows...\r\nC:\\Users\\alice>",
  };
  assert.equal(getFreshIdlePrompt(session), "");
});

test("getFreshIdlePrompt tolerates ANSI colour codes that wrap the prompt in either side", () => {
  const session = {
    lastIdlePrompt: "PS C:\\Users\\alice>",
    _promptTrackTail: "stuff\r\n[32mPS C:\\Users\\alice>[0m",
  };
  assert.equal(getFreshIdlePrompt(session), "PS C:\\Users\\alice>");
});

test("getFreshIdlePrompt returns empty string when the session has no cached prompt or tail", () => {
  assert.equal(getFreshIdlePrompt(null), "");
  assert.equal(getFreshIdlePrompt(undefined), "");
  assert.equal(getFreshIdlePrompt({}), "");
  assert.equal(getFreshIdlePrompt({ lastIdlePrompt: "PS C:\\>" }), "");
  assert.equal(
    getFreshIdlePrompt({ lastIdlePrompt: "", _promptTrackTail: "anything" }),
    "",
  );
});

test("getFreshIdlePrompt and trackSessionIdlePrompt round-trip through a real PTY-like flow", () => {
  // (1) Remote PowerShell prompt arrives — lastIdlePrompt is captured.
  const session = {};
  trackSessionIdlePrompt(session, "Microsoft Windows...\r\nPS C:\\Users\\alice>");
  assert.equal(getFreshIdlePrompt(session), "PS C:\\Users\\alice>");

  // (2) User runs `exit` and the shell now shows an unrecognized prompt.
  // trackSessionIdlePrompt does not update lastIdlePrompt (the new shape
  // doesn't match POSIX or PowerShell regexes), so the cache is stale.
  trackSessionIdlePrompt(session, "\r\nexit\r\nlogout\r\n❯ ");
  assert.equal(session.lastIdlePrompt, "PS C:\\Users\\alice>"); // unchanged
  // The freshness check rescues us: the visible tail no longer ends
  // with the cached PS line, so downstream wrapper selection sees "".
  assert.equal(getFreshIdlePrompt(session), "");
});

test("looksLikeIdleAutoLogout detects the bash TMOUT banner at the tail", () => {
  // bash prints this immediately before a TMOUT auto-logout exit. The exit
  // itself is a clean shell exit (code 0, no signal), so the banner is the
  // only reliable discriminator from a user-typed `exit` (#1062 / #977).
  assert.equal(
    looksLikeIdleAutoLogout("user@host:~$ \x07timed out waiting for input: auto-logout\r\n"),
    true,
  );
});

test("looksLikeIdleAutoLogout detects the csh/tcsh auto-logout banner", () => {
  assert.equal(looksLikeIdleAutoLogout("\r\nauto-logout\r\n"), true);
});

test("looksLikeIdleAutoLogout sees through ANSI escapes around the banner", () => {
  assert.equal(
    looksLikeIdleAutoLogout("\x1b[0m\x1b[33mtimed out waiting for input: auto-logout\x1b[0m\r\n"),
    true,
  );
});

test("looksLikeIdleAutoLogout ignores a plain (non-timeout) logout", () => {
  // A normal login-shell exit prints "logout" — without the "auto-" prefix —
  // and must still auto-close the tab.
  assert.equal(looksLikeIdleAutoLogout("user@host:~$ logout\r\n"), false);
});

test("looksLikeIdleAutoLogout ignores the banner when it is not at the tail", () => {
  // "auto-logout" scrolled past long ago; the user then ran more commands and
  // exited normally. Only the tail end is inspected, so this is not a timeout.
  const tail = "auto-logout\n" + "x".repeat(400) + "\nuser@host:~$ logout\r\n";
  assert.equal(looksLikeIdleAutoLogout(tail), false);
});

test("looksLikeIdleAutoLogout ignores auto-logout in command output before an intentional exit", () => {
  // Investigating TMOUT: the user greps the profile (output mentions
  // "auto-logout"), reads it, then exits on purpose. The banner is not the
  // final line, so the tab must still auto-close. Guards against matching an
  // unanchored substring anywhere in the recent output.
  const tail =
    "root@h:~# grep -i auto-logout /etc/profile\r\n" +
    "# bash TMOUT auto-logout setting\r\nTMOUT=300\r\n" +
    "root@h:~# exit\r\nlogout\r\n";
  assert.equal(looksLikeIdleAutoLogout(tail), false);
});

test("looksLikeIdleAutoLogout matches the real-server banner shape (prompt + banner on one line)", () => {
  // The banner can share a line with the trailing prompt after ANSI/control
  // bytes are stripped (observed over real SSH); anchoring on the line end
  // must still match.
  const tail =
    "\x1b]0;root@VM:~\x07root@VM:~# \x1b[?2004l\x07timed out waiting for input: auto-logout\n";
  assert.equal(looksLikeIdleAutoLogout(tail), true);
});

test("looksLikeIdleAutoLogout returns false for empty / non-string input", () => {
  assert.equal(looksLikeIdleAutoLogout(""), false);
  assert.equal(looksLikeIdleAutoLogout(undefined), false);
  assert.equal(looksLikeIdleAutoLogout(null), false);
});

function withExecPath(fakePath, fn) {
  const original = process.execPath;
  Object.defineProperty(process, "execPath", { value: fakePath, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "execPath", { value: original, configurable: true, writable: true });
  }
}
