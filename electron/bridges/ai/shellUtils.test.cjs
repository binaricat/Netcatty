const test = require("node:test");
const assert = require("node:assert/strict");

const {
  stripAnsi,
  addCodexExecutableEnvForSdk,
  buildWindowsShellCommandLine,
  extractTrailingIdlePrompt,
  formatSyntheticEcho,
  getFreshIdlePrompt,
  getVisibleIdlePrompt,
  isDefaultPowerShellPromptLine,
  isDefaultCmdPromptLine,
  isDefaultPosixPromptLine,
  isPlausibleCliVersionOutput,
  looksLikeIdleAutoLogout,
  prepareCommandForSpawn,
  resolveWindowsShimToNativeExe,
  resolveClaudeCodeExecutableForSdk,
  resolveCodexExecutableForSdk,
  resolveCodebuddyExecutableForSdk,
  parseRegQueryPath,
  expandWindowsEnvRefs,
  mergeWindowsPath,
  readWindowsRegistryPath,
  createWindowsLivePathResolver,
  trackSessionIdlePrompt,
} = require("./shellUtils.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("OSC stripping preserves text between independently terminated sequences", () => {
  for (const firstEnd of ["\x07", "\x1b\\"]) {
    for (const secondEnd of ["\x07", "\x1b\\"]) {
      const text = `\x1b]3008;start${firstEnd}\nprobe-reply\n\x1b]3008;end${secondEnd}prompt`;
      assert.equal(stripAnsi(text), "\nprobe-reply\nprompt");
    }
  }
  assert.equal(
    stripAnsi("before\x1b[31mcolored\x1b[0m\x1b]0;title\x07after"),
    "beforecoloredafter",
  );
});

test("formatSyntheticEcho normalizes multi-line commands to CRLF so xterm doesn't staircase", () => {
  assert.equal(
    formatSyntheticEcho("set -e\ncd /tmp\necho done"),
    "set -e\r\ncd /tmp\r\necho done\r\n",
  );
  // Already-CRLF input is not doubled.
  assert.equal(formatSyntheticEcho("a\r\nb"), "a\r\nb\r\n");
  // Single-line commands keep the original shape.
  assert.equal(formatSyntheticEcho("npm test"), "npm test\r\n");
});

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

test("extracts a trailing cmd.exe idle prompt", () => {
  // Windows OpenSSH default shell is cmd.exe; without capturing `C:\...>`
  // AI exec cannot select the cmd wrapper when shellKind is still unset.
  assert.equal(
    extractTrailingIdlePrompt("Microsoft Windows...\r\nC:\\Users\\alice>"),
    "C:\\Users\\alice>",
  );
  assert.equal(extractTrailingIdlePrompt("welcome\r\nC:\\>"), "C:\\>");
  assert.equal(extractTrailingIdlePrompt("welcome\r\nD:\\data\\proj>"), "D:\\data\\proj>");
});

test("isDefaultCmdPromptLine matches drive-letter cmd prompts only", () => {
  assert.equal(isDefaultCmdPromptLine("C:\\Users\\alice>"), true);
  assert.equal(isDefaultCmdPromptLine("C:\\>"), true);
  assert.equal(isDefaultCmdPromptLine("C:>"), true);
  assert.equal(isDefaultCmdPromptLine("PS C:\\Users\\alice>"), false);
  assert.equal(isDefaultCmdPromptLine("alice@host:~$"), false);
  assert.equal(isDefaultCmdPromptLine("C: >"), false);
  assert.equal(isDefaultCmdPromptLine(""), false);
});

test("isDefaultPosixPromptLine matches classic user@host prompts", () => {
  assert.equal(isDefaultPosixPromptLine("alice@host:~$"), true);
  assert.equal(isDefaultPosixPromptLine("user@host:~$"), true);
  assert.equal(isDefaultPosixPromptLine("alice@wsl:/mnt/c$"), true);
  assert.equal(isDefaultPosixPromptLine("root@box:/#"), true);
  assert.equal(isDefaultPosixPromptLine("[opc@instance-20260905-1821 ~]$"), true);
  assert.equal(isDefaultPosixPromptLine("[opc@instance-20260905-1821 ~]$ "), true);
  assert.equal(isDefaultPosixPromptLine("[root@host ~]#"), true);
  assert.equal(isDefaultPosixPromptLine("[user@host]$"), true);
  assert.equal(isDefaultPosixPromptLine("[user@host My Project]$"), true);
  assert.equal(isDefaultPosixPromptLine("[user@host My Project]$ "), true);
  assert.equal(isDefaultPosixPromptLine("[user@host My [Project]]$"), true);
  assert.equal(isDefaultPosixPromptLine("[user@host My [Project]]$ "), true);
  assert.equal(isDefaultPosixPromptLine("root@host ~#"), false);
  assert.equal(isDefaultPosixPromptLine("PS C:\\Users\\alice>"), false);
  assert.equal(isDefaultPosixPromptLine("C:\\Users\\alice>"), false);
  assert.equal(isDefaultPosixPromptLine(""), false);
});

test("isDefaultPosixPromptLine matches the macOS zsh default prompt", () => {
  for (const prompt of [
    "hexiao@JosephdeMacBook-Pro-2 ~ %",
    "hexiao@JosephdeMacBook-Pro-2 ~ % ",
    "alice@MacBook-Pro ~/src % ",
    "alice@MacBook-Pro /tmp %",
    "alice@MacBook-Pro My Project % ",
    "root@MacBook-Pro ~ # ",
    "root@MacBook-Pro My Project # ",
    "(venv) alice@MacBook-Pro ~/src % ",
  ]) {
    assert.equal(isDefaultPosixPromptLine(prompt), true, prompt);
  }
});

test("zsh default prompt recognition rejects pending input and non-prompt output", () => {
  for (const line of [
    "user@host ~ % echo",
    "user@host ~ %echo",
    "user@host ~ % printf busy%",
    "user@host My Project % echo %",
    "root@host My Project # echo #",
    "user@host My Project % echo #",
    "user@host My Project % echo $",
    "user@host 100%",
    "user@host 100#",
    "progress 50 %",
    "user@host   %",
    "#",
    "%",
    "progress@build 50%",
  ]) {
    assert.equal(isDefaultPosixPromptLine(line), false, line);
    assert.equal(extractTrailingIdlePrompt(`welcome\r\n${line}`), "", line);
  }
});

test("recognizes parenthesized Deck prompts without accepting pending input", () => {
  for (const prompt of ["(deck@steamdeck ~)$ ", "(root@steamdeck /home/deck)#", "(deck@steamdeck My Project)$ ", "(venv) (deck@steamdeck ~)$ ", "(deck@steamdeck My Project (1))$ ", "(root@steamdeck /cash$# (old))# ", "(venv) (deck@steamdeck $work#1)$ "]) {
    assert.equal(isDefaultPosixPromptLine(prompt), true, prompt);
    assert.equal(extractTrailingIdlePrompt(`welcome\r\n${prompt}`), prompt);
  }
  for (const line of ["(deck@steamdeck ~)$ echo hello", "(deck@steamdeck ~)$ echo $", "(deck@steamdeck ~)$ echo (x)$", "(deck@steamdeck 100%)%", "(venv) "]) {
    assert.equal(isDefaultPosixPromptLine(line), false, line);
    assert.equal(extractTrailingIdlePrompt(`welcome\r\n${line}`), "", line);
  }
});

test("extracts the macOS zsh default prompt and preserves trailing whitespace", () => {
  assert.equal(
    extractTrailingIdlePrompt("Last login: Mon Oct 26\r\nhexiao@MacBook-Pro ~ % "),
    "hexiao@MacBook-Pro ~ % ",
  );
  assert.equal(
    extractTrailingIdlePrompt("welcome\r\nhexiao@MacBook-Pro ~/git %"),
    "hexiao@MacBook-Pro ~/git %",
  );
  assert.equal(
    extractTrailingIdlePrompt("welcome\r\nalice@MacBook-Pro My Project % "),
    "alice@MacBook-Pro My Project % ",
  );
  assert.equal(
    extractTrailingIdlePrompt("welcome\r\nroot@MacBook-Pro My Project # "),
    "root@MacBook-Pro My Project # ",
  );
  assert.equal(extractTrailingIdlePrompt("welcome\r\nhexiao@MacBook-Pro ~ % echo"), "");
  assert.equal(extractTrailingIdlePrompt("welcome\r\nhexiao@MacBook-Pro ~ %\r\n"), "");
});

test("isDefaultPosixPromptLine matches Alpine host:path prompts without a username", () => {
  for (const prompt of [
    "localhost:~#",
    "localhost:~# ",
    "alpine:~$ ",
    "alpine-host:~/projects$",
    "alpine-host:/# ",
    "alpine.example:/srv/My Project$ ",
  ]) {
    assert.equal(isDefaultPosixPromptLine(prompt), true, prompt);
  }
});

test("Alpine prompt recognition rejects output and partially entered commands", () => {
  for (const line of [
    "#",
    "$",
    "status: ready#",
    "progress:100%$",
    ":~#",
    "alpine:#",
    "alpine:relative$",
    "alpine:~user$",
    "localhost:~# printf busy",
    "localhost:/tmp# printf busy#",
    "alpine:/tmp$ printf busy$",
  ]) {
    assert.equal(isDefaultPosixPromptLine(line), false, line);
    assert.equal(extractTrailingIdlePrompt(`welcome\r\n${line}`), "", line);
  }
});

test("extracts an Alpine idle prompt while preserving its trailing whitespace", () => {
  assert.equal(
    extractTrailingIdlePrompt("Welcome to Alpine!\r\n\x1b[32mlocalhost:~# \x1b[0m"),
    "localhost:~# ",
  );
  assert.equal(extractTrailingIdlePrompt("alpine:/srv$ "), "alpine:/srv$ ");
  assert.equal(extractTrailingIdlePrompt("localhost:~# \r\n"), "");
});

test("extracts a trailing RHEL-family bracketed idle prompt", () => {
  // Oracle Linux / RHEL / CentOS / Fedora default PS1 is `[\u@\h \W]\$ `.
  // Trailing space must round-trip, same as the PowerShell prompt capture.
  assert.equal(
    extractTrailingIdlePrompt("[opc@instance-20260905-1821 ~]$ "),
    "[opc@instance-20260905-1821 ~]$ ",
  );
  assert.equal(
    extractTrailingIdlePrompt("Last login: Fri Oct 24\r\n[root@host ~]#"),
    "[root@host ~]#",
  );
  assert.equal(
    extractTrailingIdlePrompt("welcome\r\nuser@host:~$ "),
    "user@host:~$ ",
  );
  assert.equal(
    extractTrailingIdlePrompt("welcome\r\n[user@host My Project]$ "),
    "[user@host My Project]$ ",
  );
  assert.equal(
    extractTrailingIdlePrompt("welcome\r\n[user@host My [Project]]$ "),
    "[user@host My [Project]]$ ",
  );
  // Unbracketed space form is still not a recognized default prompt.
  assert.equal(extractTrailingIdlePrompt("welcome\r\nroot@host ~#"), "");
});

test("extractTrailingIdlePrompt recognizes a two-line user@host then bare $/# PS1", () => {
  // export PS1="\u@\h: \w\n$ " paints the host line, then a lone "$ ".
  // The cached prompt must keep both lines so a lone "$" cannot satisfy endsWith.
  assert.equal(
    extractTrailingIdlePrompt("welcome\r\nuser@host: /home/foo\n$ "),
    "user@host: /home/foo\n$ ",
  );
  assert.equal(
    extractTrailingIdlePrompt("welcome\r\nroot@host: /root\n# "),
    "root@host: /root\n# ",
  );
  // Live bash PTY: prompt CR plus ONLCR is `\r\r\n`, which this normalizer
  // stores as blank lines. The cache must keep them so endsWith still matches.
  assert.equal(
    extractTrailingIdlePrompt("\x1b[?2004huser@host: /home/foo\r\r\n$ "),
    "user@host: /home/foo\n\n\n$ ",
  );
  assert.equal(
    extractTrailingIdlePrompt("\x1b[?2004hroot@host: /root\r\r\n# "),
    "root@host: /root\n\n\n# ",
  );
  assert.equal(extractTrailingIdlePrompt("$ "), "");
  assert.equal(extractTrailingIdlePrompt("# "), "");
  assert.equal(extractTrailingIdlePrompt("welcome\r\n$ "), "");
  assert.equal(extractTrailingIdlePrompt("not a host line\n$ "), "");
  assert.equal(extractTrailingIdlePrompt("copied output\n# "), "");
  assert.equal(isDefaultPosixPromptLine("$"), false);
  assert.equal(isDefaultPosixPromptLine("#"), false);
  assert.equal(isDefaultPosixPromptLine("$ "), false);
  assert.equal(isDefaultPosixPromptLine("# "), false);
});

test("trackSessionIdlePrompt and getFreshIdlePrompt accept a two-line user@host PS1", () => {
  const session = {};
  const prompt = "user@host: /home/foo\n$ ";
  trackSessionIdlePrompt(session, `welcome\r\n${prompt}`);
  assert.equal(getFreshIdlePrompt(session), prompt);

  const ptySession = {};
  trackSessionIdlePrompt(ptySession, "\x1b[?2004huser@host: /home/foo\r\r\n$ ");
  assert.equal(getFreshIdlePrompt(ptySession), "user@host: /home/foo\n\n\n$ ");
});

test("extractTrailingIdlePrompt recognizes an Oh My Zsh ys two-line idle prompt", () => {
  // ys paints `# user @ host ...` then a bare `$` or `#`. Spaces around `@`
  // and the leading decorative `#` are required; a lone marker is not a prompt.
  assert.equal(
    extractTrailingIdlePrompt("# user @ host in ~ [12:34:56]\n$ "),
    "# user @ host in ~ [12:34:56]\n$ ",
  );
  assert.equal(
    extractTrailingIdlePrompt("welcome\r\n# user @ host in ~ [12:34:56]\n# "),
    "# user @ host in ~ [12:34:56]\n# ",
  );
  assert.equal(
    extractTrailingIdlePrompt("# user @ host in ~/proj on git:main [12:34:56]\n$ "),
    "# user @ host in ~/proj on git:main [12:34:56]\n$ ",
  );
  assert.equal(
    extractTrailingIdlePrompt("welcome\r\n# ys @ ys-mbp in ~/.oh-my-zsh on git:master x [21:47:42] C:127\n$ "),
    "# ys @ ys-mbp in ~/.oh-my-zsh on git:master x [21:47:42] C:127\n$ ",
  );
  // Same CR / CRLF blank lines as the classic two-line PS1.
  assert.equal(
    extractTrailingIdlePrompt("# user @ host in ~ [12:34:56]\r\r\n$ "),
    "# user @ host in ~ [12:34:56]\n\n\n$ ",
  );
  assert.equal(
    extractTrailingIdlePrompt("# user @ host in ~ [12:34:56]\r\n# "),
    "# user @ host in ~ [12:34:56]\n\n# ",
  );
  // Optional "(name) " env prefix is stripped only for recognition (#3947).
  assert.equal(
    extractTrailingIdlePrompt("(venv) # user @ host in ~ [12:34:56]\n$ "),
    "(venv) # user @ host in ~ [12:34:56]\n$ ",
  );
  assert.equal(
    extractTrailingIdlePrompt("(venv) user@host: /home/foo\n$ "),
    "(venv) user@host: /home/foo\n$ ",
  );

  assert.equal(extractTrailingIdlePrompt("$ "), "");
  assert.equal(extractTrailingIdlePrompt("# "), "");
  assert.equal(extractTrailingIdlePrompt("welcome\r\n$ "), "");
  assert.equal(extractTrailingIdlePrompt("not a host line\n$ "), "");
  assert.equal(extractTrailingIdlePrompt("user @ host in ~\n$ "), "");
  assert.equal(extractTrailingIdlePrompt("# user host in ~ [12:34:56]\n$ "), "");
  assert.equal(extractTrailingIdlePrompt("# user@host in ~ [12:34:56]\n$ "), "");
  assert.equal(extractTrailingIdlePrompt("copied output\n# "), "");
  assert.equal(extractTrailingIdlePrompt("# user @ host in ~ [12:34:56]\n$ ls"), "");
  assert.equal(extractTrailingIdlePrompt("# user @ host in ~ [12:34:56] $"), "");
  assert.equal(extractTrailingIdlePrompt("echo $"), "");
  assert.equal(extractTrailingIdlePrompt("price is 5$"), "");
  assert.equal(extractTrailingIdlePrompt("(venv) not a host line\n$ "), "");
});

test("trackSessionIdlePrompt and getFreshIdlePrompt accept an Oh My Zsh ys two-line prompt", () => {
  const session = {};
  const prompt = "# user @ host in ~ [12:34:56]\n$ ";
  trackSessionIdlePrompt(session, `welcome\r\n${prompt}`);
  assert.equal(getFreshIdlePrompt(session), prompt);

  const extra = {};
  trackSessionIdlePrompt(extra, "# user @ host in ~/proj on git:main [12:34:56]\r\r\n$ ");
  assert.equal(
    getFreshIdlePrompt(extra),
    "# user @ host in ~/proj on git:main [12:34:56]\n\n\n$ ",
  );

  const root = {};
  trackSessionIdlePrompt(root, "# user @ host in ~ [12:34:56]\n# ");
  assert.equal(getFreshIdlePrompt(root), "# user @ host in ~ [12:34:56]\n# ");

  const bare = {};
  assert.equal(trackSessionIdlePrompt(bare, "$ "), "");
  assert.equal(getFreshIdlePrompt(bare), "");
  assert.equal(trackSessionIdlePrompt(bare, "not a host line\n$ "), "");
  assert.equal(getFreshIdlePrompt(bare), "");
});

test("extractTrailingIdlePrompt still recognizes a classic single-line POSIX prompt", () => {
  assert.equal(extractTrailingIdlePrompt("welcome\r\nuser@host:~$ "), "user@host:~$ ");
});

test("isDefaultPosixPromptLine accepts virtualenv, conda, and BT-panel env prefixes", () => {
  // Python venv / conda / BT-panel prepend "(name) " before the real prompt.
  // Recognition strips that prefix; a missing space after ")" is already
  // accepted because the username class absorbs the parens (#3947).
  for (const prompt of [
    "(3.12.12) root@example:~# ",
    "(3.12.12) root@example:~#",
    "(venv) alice@host:~$ ",
    "(base) [opc@host ~]$ ",
    "(my-env) localhost:~# ",
    "(3.12.12)root@example:~# ",
  ]) {
    assert.equal(isDefaultPosixPromptLine(prompt), true, prompt);
  }
});

test("extractTrailingIdlePrompt keeps the full env-prefixed POSIX prompt", () => {
  // Suffix matching compares the visible PTY line, so the captured prompt
  // must still include the "(name) " prefix rather than the stripped form.
  for (const prompt of [
    "(3.12.12) root@example:~# ",
    "(3.12.12) root@example:~#",
    "(venv) alice@host:~$ ",
    "(base) [opc@host ~]$ ",
    "(my-env) localhost:~# ",
  ]) {
    assert.equal(extractTrailingIdlePrompt(`Last login\r\n${prompt}`), prompt, prompt);
  }
});

test("env-prefixed POSIX recognition rejects incomplete prefixes and non-prompts", () => {
  for (const line of [
    "(3.12.12 root@example:~# ",
    "(3.12.12) root@example:~# printf busy",
    "(venv) not a prompt",
    "root@host ~#",
    "(base) [opc@host ~]$ printf busy",
    "(my-env) localhost:~# printf busy",
  ]) {
    assert.equal(isDefaultPosixPromptLine(line), false, line);
    assert.equal(extractTrailingIdlePrompt(`welcome\r\n${line}`), "", line);
  }
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

test("resolveClaudeCodeExecutableForSdk maps Windows npm cmd shim to native claude.exe when cli.js is absent", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-claude-native-"));
  try {
    const shimPath = path.join(tmp, "claude.cmd");
    const nativeExe = path.join(tmp, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    fs.mkdirSync(path.dirname(nativeExe), { recursive: true });
    fs.writeFileSync(nativeExe, "", "utf8");
    fs.writeFileSync(
      shimPath,
      '@ECHO off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n',
      "utf8",
    );

    assert.equal(resolveClaudeCodeExecutableForSdk(shimPath, "win32"), nativeExe);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveWindowsShimToNativeExe resolves npm .cmd shim to native exe", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-shim-native-"));
  try {
    const shimPath = path.join(tmp, "claude.cmd");
    const nativeExe = path.join(tmp, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    fs.mkdirSync(path.dirname(nativeExe), { recursive: true });
    fs.writeFileSync(nativeExe, "", "utf8");
    // Single backslashes in the .cmd content (%~dp0 expands to the shim dir)
    fs.writeFileSync(
      shimPath,
      '@ECHO off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n',
      "utf8",
    );

    const resolved = resolveWindowsShimToNativeExe(shimPath, "win32");
    assert.equal(resolved, nativeExe);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCommandForSpawn can skip native exe unwrap for node+script shims", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-spawn-no-unwrap-"));
  try {
    const shimPath = path.join(tmp, "cursor-agent.cmd");
    const nodeExe = path.join(tmp, "versions", "2026.06.01-abc", "node.exe");
    fs.mkdirSync(path.dirname(nodeExe), { recursive: true });
    fs.writeFileSync(nodeExe, "", "utf8");
    fs.writeFileSync(
      shimPath,
      '@ECHO off\r\n"%~dp0\\versions\\2026.06.01-abc\\node.exe" "%~dp0\\versions\\2026.06.01-abc\\index.js" %*\r\n',
      "utf8",
    );

    assert.equal(resolveWindowsShimToNativeExe(shimPath, "win32"), nodeExe);

    const unwrapped = prepareCommandForSpawn(shimPath, ["status", "--format", "json"]);
    const wrapped = prepareCommandForSpawn(shimPath, ["status", "--format", "json"], {
      unwrapNativeExe: false,
    });
    if (process.platform === "win32") {
      assert.deepEqual(unwrapped, {
        command: nodeExe,
        args: ["status", "--format", "json"],
        shell: false,
      });
      assert.deepEqual(wrapped, {
        command: buildWindowsShellCommandLine(shimPath, ["status", "--format", "json"]),
        args: [],
        shell: true,
      });
    } else {
      assert.equal(unwrapped.shell, false);
      assert.equal(wrapped.shell, false);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepareCommandForSpawn resolves Windows cmd shim to native exe with shell:false", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-spawn-native-"));
  try {
    const shimPath = path.join(tmp, "claude.cmd");
    const nativeExe = path.join(tmp, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    fs.mkdirSync(path.dirname(nativeExe), { recursive: true });
    fs.writeFileSync(nativeExe, "", "utf8");
    fs.writeFileSync(
      shimPath,
      '@ECHO off\r\n"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n',
      "utf8",
    );

    const result = prepareCommandForSpawn(shimPath, ["--version"]);
    if (process.platform === "win32") {
      assert.deepEqual(result, {
        command: nativeExe,
        args: ["--version"],
        shell: false,
      });
    } else {
      // On non-Windows, resolveWindowsShimToNativeExe is skipped; verify win32 behavior explicitly.
      assert.equal(resolveWindowsShimToNativeExe(shimPath, "win32"), nativeExe);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function writeCodexWin32NativeLayout(globalPrefix, arch = process.arch === "arm64" ? "arm64" : "x64") {
  const triple = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const platformPackage = arch === "arm64" ? "@openai/codex-win32-arm64" : "@openai/codex-win32-x64";
  const nativeExe = path.join(
    globalPrefix,
    "node_modules",
    platformPackage,
    "vendor",
    triple,
    "bin",
    "codex.exe",
  );
  fs.mkdirSync(path.dirname(nativeExe), { recursive: true });
  fs.writeFileSync(nativeExe, "", "utf8");
  return nativeExe;
}

test("resolveCodexExecutableForSdk maps Windows npm cmd shim to native codex.exe", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-shim-"));
  try {
    const shimPath = path.join(tmp, "codex.cmd");
    const nativeExe = writeCodexWin32NativeLayout(tmp);
    fs.writeFileSync(
      shimPath,
      '@ECHO off\r\nnode "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
      "utf8",
    );

    assert.equal(resolveCodexExecutableForSdk(shimPath, "win32"), nativeExe);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveCodexExecutableForSdk maps Windows local npm bin shim to native codex.exe", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-local-shim-"));
  try {
    const shimPath = path.join(tmp, "node_modules", ".bin", "codex.cmd");
    const nativeExe = writeCodexWin32NativeLayout(tmp);
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(
      shimPath,
      '@ECHO off\r\nnode "%~dp0\\..\\@openai\\codex\\bin\\codex.js" %*\r\n',
      "utf8",
    );

    assert.equal(resolveCodexExecutableForSdk(shimPath, "win32"), nativeExe);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveCodexExecutableForSdk leaves non-Windows Codex paths unchanged", () => {
  assert.equal(
    resolveCodexExecutableForSdk("/usr/local/bin/codex", "darwin"),
    "/usr/local/bin/codex",
  );
});

test("resolveCodexExecutableForSdk returns null for Windows cmd shim when native codex.exe is missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-missing-native-"));
  try {
    const shimPath = path.join(tmp, "codex.cmd");
    fs.writeFileSync(
      shimPath,
      '@ECHO off\r\nnode "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
      "utf8",
    );

    assert.equal(resolveCodexExecutableForSdk(shimPath, "win32"), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveCodexExecutableForSdk maps Windows nvmd bin shim to native codex.exe", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-nvmd-shim-"));
  try {
    const nvmdHome = path.join(tmp, ".nvmd");
    const binDir = path.join(nvmdHome, "bin");
    const versionRoot = path.join(nvmdHome, "versions", "22.14.0");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(nvmdHome, "default"), "22.14.0\n", "utf8");
    fs.writeFileSync(
      path.join(nvmdHome, "packages.json"),
      JSON.stringify({ codex: ["22.14.0"] }),
      "utf8",
    );

    // nvmd Windows package shims are copies of npm.cmd / nvmd.exe, not npm's
    // @openai/codex launcher. The real install lives under versions/<ver>/.
    const shimPath = path.join(binDir, "codex.cmd");
    fs.writeFileSync(shimPath, '@echo off\r\n"%~dpn0.exe" %*\r\n', "utf8");
    fs.writeFileSync(path.join(binDir, "codex.exe"), "", "utf8");
    fs.writeFileSync(path.join(binDir, "nvmd.exe"), "", "utf8");

    const nativeExe = writeCodexWin32NativeLayout(versionRoot);

    assert.equal(resolveCodexExecutableForSdk(shimPath, "win32"), nativeExe);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveCodexExecutableForSdk maps Windows nvmd.exe package shim to native codex.exe", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-nvmd-exe-"));
  try {
    const nvmdHome = path.join(tmp, ".nvmd");
    const binDir = path.join(nvmdHome, "bin");
    const versionRoot = path.join(nvmdHome, "versions", "20.18.0");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(nvmdHome, "default"), "20.18.0\n", "utf8");

    const shimPath = path.join(binDir, "codex.exe");
    fs.writeFileSync(shimPath, "", "utf8");
    fs.writeFileSync(path.join(binDir, "nvmd.exe"), "", "utf8");
    const nativeExe = writeCodexWin32NativeLayout(versionRoot);

    assert.equal(resolveCodexExecutableForSdk(shimPath, "win32"), nativeExe);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveCodexExecutableForSdk maps Windows PowerShell shim to native codex.exe", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-ps1-shim-"));
  try {
    const shimPath = path.join(tmp, "codex.ps1");
    const nativeExe = writeCodexWin32NativeLayout(tmp);
    fs.writeFileSync(
      shimPath,
      '& "$basedir/node_modules/@openai/codex/bin/codex.js" $args\r\n',
      "utf8",
    );

    assert.equal(resolveCodexExecutableForSdk(shimPath, "win32"), nativeExe);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveCodexExecutableForSdk maps codex.js entry to native codex.exe", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-js-entry-"));
  try {
    const codexJs = path.join(tmp, "node_modules", "@openai", "codex", "bin", "codex.js");
    const nativeExe = writeCodexWin32NativeLayout(tmp);
    fs.mkdirSync(path.dirname(codexJs), { recursive: true });
    fs.writeFileSync(codexJs, "", "utf8");

    assert.equal(resolveCodexExecutableForSdk(codexJs, "win32"), nativeExe);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("addCodexExecutableEnvForSdk prepends bundled Codex path dir on Windows", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codex-env-path-"));
  try {
    const nativeExe = writeCodexWin32NativeLayout(tmp);
    const pathDir = path.join(path.dirname(path.dirname(nativeExe)), "codex-path");
    fs.mkdirSync(pathDir, { recursive: true });

    const env = addCodexExecutableEnvForSdk({ Path: "C:\\Windows\\System32" }, nativeExe, "win32");

    assert.equal(env.Path, `${pathDir};C:\\Windows\\System32`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function writeCodebuddyWin32BinLayout(dir) {
  const binJs = path.join(dir, "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy");
  fs.mkdirSync(path.dirname(binJs), { recursive: true });
  fs.writeFileSync(binJs, "#!/usr/bin/env node\n", "utf8");
  return binJs;
}

test("resolveCodebuddyExecutableForSdk leaves non-Windows CodeBuddy paths unchanged", () => {
  assert.equal(
    resolveCodebuddyExecutableForSdk("/usr/local/bin/codebuddy", "darwin"),
    "/usr/local/bin/codebuddy",
  );
});

test("resolveCodebuddyExecutableForSdk maps Windows npm cmd shim to package bin/codebuddy", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codebuddy-shim-"));
  try {
    const shimPath = path.join(tmp, "codebuddy.cmd");
    const binJs = writeCodebuddyWin32BinLayout(tmp);
    fs.writeFileSync(
      shimPath,
      '@ECHO off\r\nnode "%~dp0\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy" %*\r\n',
      "utf8",
    );

    assert.equal(resolveCodebuddyExecutableForSdk(shimPath, "win32"), binJs);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveCodebuddyExecutableForSdk maps extensionless Windows shim to package bin/codebuddy", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codebuddy-noext-"));
  try {
    const shimPath = path.join(tmp, "codebuddy");
    const binJs = writeCodebuddyWin32BinLayout(tmp);
    fs.writeFileSync(shimPath, "#!/bin/sh\n", "utf8");

    assert.equal(resolveCodebuddyExecutableForSdk(shimPath, "win32"), binJs);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveCodebuddyExecutableForSdk returns null for Windows cmd shim when package JS is missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-codebuddy-missing-"));
  try {
    const shimPath = path.join(tmp, "codebuddy.cmd");
    fs.writeFileSync(shimPath, "@ECHO off\r\nnode foo %*\r\n", "utf8");

    assert.equal(resolveCodebuddyExecutableForSdk(shimPath, "win32"), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveCodebuddyExecutableForSdk passes through a native exe path", () => {
  assert.equal(
    resolveCodebuddyExecutableForSdk("C:\\tools\\codebuddy.exe", "win32"),
    "C:\\tools\\codebuddy.exe",
  );
});

test("parseRegQueryPath extracts the Path value from reg query output", () => {
  const out = parseRegQueryPath(
    "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\Users\\me\\AppData\\Roaming\\npm;C:\\tools\r\n",
  );
  assert.equal(out, "C:\\Users\\me\\AppData\\Roaming\\npm;C:\\tools");
});

test("parseRegQueryPath handles REG_SZ and missing value", () => {
  assert.equal(parseRegQueryPath("    Path    REG_SZ    C:\\bin"), "C:\\bin");
  assert.equal(parseRegQueryPath("HKEY_CURRENT_USER\\Environment\r\n    Temp    REG_SZ    C:\\Temp"), "");
});

test("expandWindowsEnvRefs expands %VAR% case-insensitively", () => {
  assert.equal(
    expandWindowsEnvRefs("%AppData%\\npm;%Other%", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }),
    "C:\\Users\\me\\AppData\\Roaming\\npm;%Other%",
  );
});

test("mergeWindowsPath dedupes case-insensitively and trims trailing slashes", () => {
  const out = mergeWindowsPath(
    "C:\\Windows\\System32;C:\\tools\\",
    "c:\\windows\\system32;C:\\tools;C:\\new",
  );
  assert.equal(out, "C:\\Windows\\System32;C:\\tools\\;C:\\new");
});

test("mergeWindowsPath keeps refreshed Windows PATH entries ahead of stale process entries", () => {
  const out = mergeWindowsPath(
    "C:\\new-codebuddy;C:\\Windows\\System32",
    "C:\\Users\\me\\AppData\\Roaming\\npm",
    "C:\\old-codebuddy;C:\\Windows\\System32",
  );
  assert.equal(out, "C:\\new-codebuddy;C:\\Windows\\System32;C:\\Users\\me\\AppData\\Roaming\\npm;C:\\old-codebuddy");
});

test("readWindowsRegistryPath merges HKCU and HKLM and expands refs", async () => {
  const exec = async (cmd, args) => {
    assert.equal(cmd, "reg");
    const hive = args[1];
    if (hive === "HKCU\\Environment") {
      return { stdout: "    Path    REG_EXPAND_SZ    %APPDATA%\\npm\r\n" };
    }
    return { stdout: "    Path    REG_EXPAND_SZ    C:\\Windows\\System32\r\n" };
  };
  const out = await readWindowsRegistryPath({ exec, env: { APPDATA: "C:\\Roaming" } });
  assert.equal(out, "C:\\Windows\\System32;C:\\Roaming\\npm");
});

test("readWindowsRegistryPath tolerates a failing hive query", async () => {
  const exec = async (cmd, args) => {
    if (args[1] === "HKCU\\Environment") throw new Error("ERROR: cannot read");
    return { stdout: "    Path    REG_SZ    C:\\tools\r\n" };
  };
  const out = await readWindowsRegistryPath({ exec, env: {} });
  assert.equal(out, "C:\\tools");
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

test("tracks split Alpine prompts and expires them while the shell is busy", () => {
  const session = {};
  assert.equal(trackSessionIdlePrompt(session, "Welcome to Alpine!\r\nlocalhost:"), "");
  assert.equal(trackSessionIdlePrompt(session, "~# "), "localhost:~# ");
  assert.equal(getFreshIdlePrompt(session), "localhost:~# ");

  assert.equal(trackSessionIdlePrompt(session, "printf busy"), "");
  assert.equal(getFreshIdlePrompt(session), "");

  trackSessionIdlePrompt(session, "\r\nbusy\r\nlocalhost:/srv# ");
  assert.equal(getFreshIdlePrompt(session), "localhost:/srv# ");
  trackSessionIdlePrompt(session, "printf working\r\nworking...");
  assert.equal(getFreshIdlePrompt(session), "");
});

test("trackSessionIdlePrompt and getFreshIdlePrompt accept an Oracle/RHEL bracketed bash prompt", () => {
  const session = {};
  trackSessionIdlePrompt(session, "Last login...\r\n[opc@instance-20260905-1821 ~]$ ");
  assert.equal(session.lastIdlePrompt, "[opc@instance-20260905-1821 ~]$ ");
  assert.equal(getFreshIdlePrompt(session), "[opc@instance-20260905-1821 ~]$ ");

  const rootSession = {};
  trackSessionIdlePrompt(rootSession, "[root@host ~]#");
  assert.equal(getFreshIdlePrompt(rootSession), "[root@host ~]#");

  const classic = {};
  trackSessionIdlePrompt(classic, "user@host:~$ ");
  assert.equal(getFreshIdlePrompt(classic), "user@host:~$ ");

  const unbracketed = {};
  assert.equal(trackSessionIdlePrompt(unbracketed, "root@host ~#"), "");
  assert.equal(getFreshIdlePrompt(unbracketed), "");

  const spacedPath = {};
  trackSessionIdlePrompt(spacedPath, "Last login...\r\n[user@host My Project]$ ");
  assert.equal(spacedPath.lastIdlePrompt, "[user@host My Project]$ ");
  assert.equal(getFreshIdlePrompt(spacedPath), "[user@host My Project]$ ");

  const bracketedPath = {};
  trackSessionIdlePrompt(bracketedPath, "Last login...\r\n[user@host My [Project]]$ ");
  assert.equal(bracketedPath.lastIdlePrompt, "[user@host My [Project]]$ ");
  assert.equal(getFreshIdlePrompt(bracketedPath), "[user@host My [Project]]$ ");
});

test("visible idle prompt survives a PSReadLine erase that leaves the raw tail dirty", () => {
  // PSReadLine echoes the pending-input clear prefix (`ggd2147483647d` / `i`),
  // then homes the cursor and erases those keys with CSI. stripAnsi drops the
  // erase but keeps the keys, so the cached prompt no longer matches the tail.
  // The screen is still an idle default PowerShell prompt (#3927).
  const session = {};
  const prompt = "PS C:\\Users\\alice> ";
  trackSessionIdlePrompt(session, `Windows PowerShell\r\n${prompt}ggd2147483647d\x1b[20G\x1b[0J`);
  assert.equal(getFreshIdlePrompt(session), "");
  assert.equal(extractTrailingIdlePrompt(session._promptTrackTail), "");
  assert.equal(getVisibleIdlePrompt(session), prompt);

  const backspaced = {};
  trackSessionIdlePrompt(backspaced, `${prompt}\x08`);
  assert.equal(getFreshIdlePrompt(backspaced), "");
  assert.equal(getVisibleIdlePrompt(backspaced), prompt);

  const crHomed = {};
  trackSessionIdlePrompt(crHomed, `${prompt}\r`);
  assert.equal(getFreshIdlePrompt(crHomed), "");
  assert.equal(getVisibleIdlePrompt(crHomed), prompt);
});

test("visible idle prompt stays empty for pending input, a following line, and an unrecognized prompt", () => {
  const pending = {};
  trackSessionIdlePrompt(pending, "PS C:\\Users\\alice> Write-Output ok");
  assert.equal(getFreshIdlePrompt(pending), "");
  assert.equal(getVisibleIdlePrompt(pending), "");

  const movedOn = {};
  trackSessionIdlePrompt(movedOn, "PS C:\\Users\\alice> \r\n");
  assert.equal(getVisibleIdlePrompt(movedOn), "");

  const custom = {};
  trackSessionIdlePrompt(custom, "PS C:\\Users\\alice>\r\nexit\r\n❯ ");
  assert.equal(getVisibleIdlePrompt(custom), "");

  const fullscreen = {};
  trackSessionIdlePrompt(fullscreen, "PS C:\\Users\\alice> \x1b[?1049h\x1b[Hvim");
  assert.equal(getVisibleIdlePrompt(fullscreen), "");

  assert.equal(getVisibleIdlePrompt({ _promptTrackTail: "" }), "");
  assert.equal(getVisibleIdlePrompt(null), "");
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

test("Windows live PATH refresh is shared, asynchronous, bounded, and cached", async () => {
  let calls = 0;
  let tick = 0;
  const resolve = createWindowsLivePathResolver({
    exec: () => { calls += 1; return new Promise(() => {}); },
    timeoutMs: 20,
    now: () => tick,
    ttlMs: 50,
  });
  const options = { basePath: "C:\\Windows\\System32", platform: "win32", env: {}, knownCliDirs: () => [] };
  let eventLoopRan = false;
  setTimeout(() => { eventLoopRan = true; }, 0);
  const first = resolve(options);
  const second = resolve(options);
  assert.equal(calls, 2, "concurrent terminals share one query per hive");
  assert.deepEqual(await Promise.all([first, second]), [options.basePath, options.basePath]);
  assert.equal(eventLoopRan, true, "registry reads must not block the main event loop");
  await resolve(options);
  assert.equal(calls, 2, "even failed queries are briefly cached");
  tick = 51;
  await resolve(options);
  assert.equal(calls, 4, "expired snapshots refresh");
});

test("Windows live PATH keeps machine before user and guesses after inherited entries", async () => {
  const resolve = createWindowsLivePathResolver({
    exec: async (_cmd, args, options) => {
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 1000);
      return { stdout: args[1].startsWith("HKLM")
        ? "    Path    REG_SZ    C:\\Windows\\System32;C:\\shared\\\r\n"
        : "    Path    REG_EXPAND_SZ    %APPDATA%\\npm;c:\\SHARED;C:\\new-release\r\n" };
    },
  });
  const result = await resolve({
    basePath: "C:\\old-release;C:\\Windows\\System32;C:\\launcher",
    env: { APPDATA: "C:\\Roaming" },
    platform: "win32",
    knownCliDirs: () => ["C:\\guess", "C:\\launcher"],
  });
  assert.equal(result, "C:\\Windows\\System32;C:\\shared\\;C:\\Roaming\\npm;C:\\new-release;C:\\old-release;C:\\launcher;C:\\guess");
});

test("Windows live PATH picks up upgraded directories after cache expiry", async () => {
  let tick = 0;
  let release = "v1";
  let unavailable = false;
  const resolve = createWindowsLivePathResolver({
    now: () => tick,
    ttlMs: 10,
    exec: async () => {
      if (unavailable) throw new Error("registry unavailable");
      return { stdout: `    Path    REG_SZ    C:\\${release}\r\n` };
    },
  });
  const options = { platform: "win32", basePath: "C:\\old", env: {}, knownCliDirs: () => [] };
  assert.equal(await resolve(options), "C:\\v1;C:\\old");
  release = "v2";
  tick = 11;
  assert.equal(await resolve(options), "C:\\v2;C:\\old");
  unavailable = true;
  tick = 22;
  assert.equal(await resolve(options), "C:\\v2;C:\\old", "query failure retains the last successful snapshot");
});

test("cached Windows registry references expand per terminal environment", async () => {
  const resolve = createWindowsLivePathResolver({
    exec: async () => ({ stdout: "    Path    REG_EXPAND_SZ    %APPDATA%\\npm\r\n" }),
  });
  const options = { platform: "win32", basePath: "", knownCliDirs: () => [] };
  assert.equal(await resolve({ ...options, env: { APPDATA: "C:\\first" } }), "C:\\first\\npm");
  assert.equal(await resolve({ ...options, env: { APPDATA: "C:\\second" } }), "C:\\second\\npm");
});

test("Windows live PATH resolver does not query the registry off Windows", async () => {
  const resolve = createWindowsLivePathResolver({ exec: () => { throw new Error("must not query"); } });
  assert.equal(await resolve({ basePath: "/usr/bin:/bin", platform: "linux" }), "/usr/bin:/bin");
});

test("a failed machine hive does not promote user directories ahead of inherited system paths", async () => {
  const resolve = createWindowsLivePathResolver({
    exec: async (_cmd, args) => {
      if (args[1].startsWith("HKLM")) throw new Error("unavailable");
      return { stdout: "    Path    REG_SZ    C:\\user-tools\r\n" };
    },
  });
  assert.equal(await resolve({
    platform: "win32", basePath: "C:\\Windows\\System32", env: {}, knownCliDirs: () => [],
  }), "C:\\Windows\\System32;C:\\user-tools");
});
