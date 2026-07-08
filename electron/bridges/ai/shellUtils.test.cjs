const test = require("node:test");
const assert = require("node:assert/strict");

const {
  addCodexExecutableEnvForSdk,
  buildWindowsShellCommandLine,
  extractTrailingIdlePrompt,
  formatSyntheticEcho,
  getFreshIdlePrompt,
  isDefaultPowerShellPromptLine,
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
  trackSessionIdlePrompt,
} = require("./shellUtils.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
  assert.equal(out, "C:\\Roaming\\npm;C:\\Windows\\System32");
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
