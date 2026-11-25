import assert from "node:assert/strict";
import test from "node:test";

import {
  canSendSftpPathToTerminal,
  formatSftpCdCommand,
  formatSftpPathForTerminalInsert,
  hasUnsafeTerminalControlChars,
  isShellDraftSafeForPathInsertion,
  isTerminalContinuationPrompt,
  isTerminalDraftContextSafeForCd,
  isTerminalDraftContextSafeForPathInsertion,
  quoteSftpPathForShell,
  resolveCdSftpPathInTerminalAction,
  resolveInsertSftpPathInTerminalAction,
  resolveSftpTerminalShellKind,
  type SftpTerminalShellKind,
} from "./sftpTerminalPath.ts";

const baseRemote = {
  sessionId: "sess-1",
  sessionStatus: "connected" as const,
  sessionHostId: "host-1",
  sftpHostId: "host-1",
  sftpIsLocal: false,
  protocol: "ssh" as const,
  shellType: "posix" as const,
  isNetworkDevice: false,
};

test("resolveSftpTerminalShellKind maps shellType, live prompt, and host OS to quoting dialect", () => {
  assert.equal(resolveSftpTerminalShellKind("posix"), "posix");
  assert.equal(resolveSftpTerminalShellKind("fish"), "fish");
  assert.equal(resolveSftpTerminalShellKind("powershell"), "powershell");
  assert.equal(resolveSftpTerminalShellKind("cmd"), "cmd");
  assert.equal(resolveSftpTerminalShellKind("unknown"), "unix-portable");
  assert.equal(resolveSftpTerminalShellKind(undefined), "unix-portable");
  assert.equal(resolveSftpTerminalShellKind(null), "unix-portable");

  // Remote SSH without shellType infers PowerShell/CMD from live prompt text.
  assert.equal(
    resolveSftpTerminalShellKind(undefined, { promptText: "PS C:\\Users\\alice> ", hostOs: "windows" }),
    "powershell",
  );
  assert.equal(
    resolveSftpTerminalShellKind(undefined, { promptText: "(venv) PS /home/alice> ", hostOs: "linux" }),
    "powershell",
  );
  assert.equal(
    resolveSftpTerminalShellKind(undefined, { promptText: "C:\\Users\\alice>", hostOs: "windows" }),
    "cmd",
  );

  // Unknown Windows host or Windows path must never silently fall back to POSIX.
  assert.equal(
    resolveSftpTerminalShellKind(undefined, { hostOs: "windows" }),
    null,
  );
  assert.equal(
    resolveSftpTerminalShellKind(undefined, { promptText: "custom> ", hostOs: "windows" }),
    null,
  );
  assert.equal(
    resolveSftpTerminalShellKind(undefined, { path: "/C:/Users/alice/file.txt" }),
    null,
  );
  assert.equal(
    resolveSftpTerminalShellKind(undefined, { path: "C:\\Users\\alice\\file.txt" }),
    null,
  );
});

test("formatSftpPathForTerminalInsert quotes POSIX paths safely with trailing space", () => {
  assert.equal(
    formatSftpPathForTerminalInsert("/etc/nginx/nginx.conf", "posix"),
    "/etc/nginx/nginx.conf ",
  );
  assert.equal(
    formatSftpPathForTerminalInsert("/srv/my app/docker-compose.yml", "posix"),
    "'/srv/my app/docker-compose.yml' ",
  );
  assert.equal(
    formatSftpPathForTerminalInsert("/srv/it's/file.txt", "posix"),
    "'/srv/it'\\''s/file.txt' ",
  );
  assert.equal(
    formatSftpPathForTerminalInsert("/tmp/$(whoami).txt", "posix"),
    "'/tmp/$(whoami).txt' ",
  );
  assert.equal(
    formatSftpPathForTerminalInsert("/tmp/`id`/a;rm -rf /.txt", "posix"),
    "'/tmp/`id`/a;rm -rf /.txt' ",
  );
  assert.equal(
    formatSftpPathForTerminalInsert("/tmp/a\"$HOME/file*.log", "posix"),
    "'/tmp/a\"$HOME/file*.log' ",
  );
  assert.equal(
    formatSftpPathForTerminalInsert("/srv/dir ", "posix"),
    "'/srv/dir ' ",
  );
  assert.equal(
    formatSftpPathForTerminalInsert("-rf", "posix"),
    "'-rf' ",
  );
});

test("formatSftpPathForTerminalInsert escapes backslashes and quotes for fish", () => {
  assert.equal(
    formatSftpPathForTerminalInsert("/srv/simple.txt", "fish"),
    "/srv/simple.txt ",
  );
  assert.equal(
    formatSftpPathForTerminalInsert("/srv/a\\b's (id).txt", "fish"),
    "'/srv/a\\\\b\\'s (id).txt' ",
  );
});

test("formatSftpPathForTerminalInsert quotes PowerShell paths including smart quotes", () => {
  assert.equal(
    formatSftpPathForTerminalInsert("C:\\Users\\alice\\file.txt", "powershell"),
    "C:\\Users\\alice\\file.txt ",
  );
  assert.equal(
    formatSftpPathForTerminalInsert("C:\\Program Files\\My App\\run.ps1", "powershell"),
    "'C:\\Program Files\\My App\\run.ps1' ",
  );
  assert.equal(
    formatSftpPathForTerminalInsert("C:\\Users\\O'Brien\\$(calc).txt", "powershell"),
    "'C:\\Users\\O''Brien\\$(calc).txt' ",
  );
  assert.equal(
    formatSftpPathForTerminalInsert("C:\\tmp\\`n;calc.exe", "powershell"),
    "'C:\\tmp\\`n;calc.exe' ",
  );
  // PowerShell treats U+2018..U+201B as single-quote delimiters.
  assert.equal(
    formatSftpPathForTerminalInsert("C:\\tmp\\a\u2019;calc", "powershell"),
    "'C:\\tmp\\a\u2019\u2019;calc' ",
  );
});

test("formatSftpPathForTerminalInsert handles CMD paths and blocks unquotable characters", () => {
  assert.equal(
    formatSftpPathForTerminalInsert("C:\\Users\\alice\\file.txt", "cmd"),
    "C:\\Users\\alice\\file.txt ",
  );
  assert.equal(
    formatSftpPathForTerminalInsert("C:\\Program Files\\app & calc.txt", "cmd"),
    "\"C:\\Program Files\\app & calc.txt\" ",
  );
  // Double quote, %, and ! cannot be safely escaped in interactive cmd.exe.
  assert.equal(formatSftpPathForTerminalInsert("C:\\tmp\\a\" & calc", "cmd"), null);
  assert.equal(formatSftpPathForTerminalInsert("C:\\tmp\\%COMSPEC%", "cmd"), null);
  assert.equal(formatSftpPathForTerminalInsert("C:\\tmp\\!PATH!", "cmd"), null);
});

test("control characters and line separators are rejected across all shells", () => {
  const payloads = [
    "/tmp/evil\nrm -rf /",
    "/tmp/evil\rrm -rf /",
    "/tmp/evil\r\nwhoami",
    "/tmp/evil\x00file",
    "/tmp/evil\tfile",
    "/tmp/evil\x03file",
    "/tmp/evil\x1b[31mfile",
    "/tmp/evil\x7ffile",
    "/tmp/evil\x85file",
    "/tmp/evil\x9b31mfile",
    "/tmp/evil\u2028file",
    "/tmp/evil\u2029file",
  ];
  const shells: SftpTerminalShellKind[] = ["posix", "fish", "powershell", "cmd"];

  for (const payload of payloads) {
    assert.equal(hasUnsafeTerminalControlChars(payload), true, JSON.stringify(payload));
    for (const shell of shells) {
      assert.equal(quoteSftpPathForShell(payload, shell), null, `${shell}: ${JSON.stringify(payload)}`);
      assert.equal(formatSftpPathForTerminalInsert(payload, shell), null, `${shell}: ${JSON.stringify(payload)}`);
      assert.equal(formatSftpCdCommand(payload, shell), null, `${shell}: ${JSON.stringify(payload)}`);
    }
  }

  for (const blank of ["", "   ", null, undefined]) {
    assert.equal(formatSftpPathForTerminalInsert(blank, "posix"), null);
    assert.equal(formatSftpCdCommand(blank, "posix"), null);
  }
});

test("formatSftpCdCommand builds safe cd commands for POSIX, fish, PowerShell, and CMD", () => {
  assert.equal(formatSftpCdCommand("/srv/app", "posix"), "cd -- '/srv/app'");
  assert.equal(formatSftpCdCommand("/srv/my 'app' $(id)", "posix"), "cd -- '/srv/my '\\''app'\\'' $(id)'");
  assert.equal(formatSftpCdCommand("~", "posix"), "cd -- ~");
  assert.equal(formatSftpCdCommand("~/my docs", "posix"), "cd -- ~/'my docs'");
  assert.equal(formatSftpCdCommand("relative/dir", "posix"), null);
  assert.equal(formatSftpCdCommand("C:\\Users\\alice", "posix"), null);

  assert.equal(formatSftpCdCommand("/srv/a\\b'c", "fish"), "cd -- '/srv/a\\\\b\\'c'");
  assert.equal(formatSftpCdCommand("~/a'b", "fish"), "cd -- ~/'a\\'b'");

  assert.equal(
    formatSftpCdCommand("C:\\Users\\O'Brien\\[prod]", "powershell"),
    "cd -LiteralPath 'C:\\Users\\O''Brien\\[prod]'",
  );
  assert.equal(formatSftpCdCommand("~", "powershell"), "cd ~");
  assert.equal(
    formatSftpCdCommand("\\\\server\\share\\dir", "powershell"),
    "cd -LiteralPath '\\\\server\\share\\dir'",
  );
  assert.equal(formatSftpCdCommand("relative\\dir", "powershell"), null);

  assert.equal(formatSftpCdCommand("C:\\Program Files\\app", "cmd"), "cd /d \"C:\\Program Files\\app\"");
  assert.equal(formatSftpCdCommand("D:\\", "cmd"), "cd /d \"D:\\\"");
  assert.equal(formatSftpCdCommand("/srv/app", "cmd"), null);
  assert.equal(formatSftpCdCommand("C:\\tmp\\%USERNAME%", "cmd"), null);
  assert.equal(formatSftpCdCommand("C:\\tmp\\a\" & calc", "cmd"), null);
});

test("canSendSftpPathToTerminal enforces connected, same-endpoint, non-network-device pairing", () => {
  assert.equal(canSendSftpPathToTerminal(baseRemote), true);
  assert.equal(canSendSftpPathToTerminal({ ...baseRemote, protocol: "mosh" }), true);
  assert.equal(canSendSftpPathToTerminal({ ...baseRemote, protocol: "et" }), true);

  // Local SFTP paired with local terminal (including Windows PowerShell & CMD).
  assert.equal(
    canSendSftpPathToTerminal({
      sessionId: "local-1",
      sessionStatus: "connected",
      sftpIsLocal: true,
      protocol: "local",
      shellType: "powershell",
      isNetworkDevice: false,
    }),
    true,
  );
  assert.equal(
    canSendSftpPathToTerminal({
      sessionId: "local-2",
      sessionStatus: "connected",
      sftpIsLocal: true,
      protocol: "local",
      shellType: "cmd",
      isNetworkDevice: false,
    }),
    true,
  );

  // Rejected cases
  assert.equal(canSendSftpPathToTerminal({ ...baseRemote, sessionId: null }), false);
  assert.equal(canSendSftpPathToTerminal({ ...baseRemote, sessionStatus: "disconnected" }), false);
  assert.equal(canSendSftpPathToTerminal({ ...baseRemote, sessionStatus: "connecting" }), false);
  assert.equal(canSendSftpPathToTerminal({ ...baseRemote, isNetworkDevice: true }), false);
  assert.equal(canSendSftpPathToTerminal({ ...baseRemote, protocol: "telnet" }), false);
  assert.equal(canSendSftpPathToTerminal({ ...baseRemote, protocol: "serial" }), false);
  assert.equal(canSendSftpPathToTerminal({ ...baseRemote, sftpHostId: "host-2" }), false);
  assert.equal(canSendSftpPathToTerminal({ ...baseRemote, sftpIsLocal: true, protocol: "ssh" }), false);
  assert.equal(
    canSendSftpPathToTerminal({
      ...baseRemote,
      sessionHostname: "a.example.test",
      sftpHostname: "b.example.test",
    }),
    false,
  );
});

test("resolveInsertSftpPathInTerminalAction and resolveCdSftpPathInTerminalAction build PTY payloads", () => {
  assert.deepEqual(
    resolveInsertSftpPathInTerminalAction({
      ...baseRemote,
      path: "/srv/app/my file.yml",
    }),
    {
      sessionId: "sess-1",
      data: "'/srv/app/my file.yml' ",
      shellKind: "posix",
    },
  );
  assert.deepEqual(
    resolveCdSftpPathInTerminalAction({
      ...baseRemote,
      path: "/srv/app dir",
    }),
    {
      sessionId: "sess-1",
      data: "cd -- '/srv/app dir'\r",
    },
  );
  assert.deepEqual(
    resolveInsertSftpPathInTerminalAction({
      sessionId: "win-1",
      sessionStatus: "connected",
      sftpIsLocal: true,
      protocol: "local",
      shellType: "powershell",
      path: "C:\\Program Files\\app.exe",
    }),
    {
      sessionId: "win-1",
      data: "'C:\\Program Files\\app.exe' ",
      shellKind: "powershell",
    },
  );
  assert.deepEqual(
    resolveCdSftpPathInTerminalAction({
      sessionId: "win-2",
      sessionStatus: "connected",
      sftpIsLocal: true,
      protocol: "local",
      shellType: "cmd",
      path: "D:\\work dir",
    }),
    {
      sessionId: "win-2",
      data: "cd /d \"D:\\work dir\"\r",
    },
  );
  assert.equal(
    resolveInsertSftpPathInTerminalAction({
      ...baseRemote,
      path: "/srv/evil\nid",
    }),
    null,
  );
  assert.equal(
    resolveCdSftpPathInTerminalAction({
      ...baseRemote,
      path: "/srv/evil\nid",
    }),
    null,
  );
});

test("isShellDraftSafeForPathInsertion blocks unclosed quotes, backticks, and trailing escapes in POSIX", () => {
  // Normal safe drafts
  assert.equal(isShellDraftSafeForPathInsertion("", "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion("cat ", "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion("vim -R ", "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion("cat \"hello\" ", "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion("cat 'hello' ", "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion("cat \"a \\\" b\" ", "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion("cat \"a \\\\\"", "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion("cat \\\" ", "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion("cat \\\\", "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion("echo 'a\\' ", "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion("echo $(cat ", "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion("echo \"$(cat \"a\")\" ", "posix"), true);

  // Unsafe quoting contexts (e.g. cat " + /tmp/$(id) would execute id inside double quotes)
  assert.equal(isShellDraftSafeForPathInsertion("cat \"", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("cat \"/tmp/", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("cat \"a \\\"", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("cat '", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("cat '/tmp/", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("printf $'hello\\'", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo `cat ", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo \"$(cat \"", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo \"$(cat \"a\")", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("cat \\", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("cat \\\\\\", "posix"), false);

  // Trailing unescaped `$` would fuse with an inserted `'...'` into ANSI-C `$'...'`,
  // turning `/tmp/\'; printf INJECTED; #` into an unquoted breakout.
  assert.equal(isShellDraftSafeForPathInsertion("echo $", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo $$", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo $(echo $", "posix"), false);
  assert.equal(
    isTerminalDraftContextSafeForPathInsertion({
      promptText: "user@host:~$ ",
      userInput: "echo $",
      pendingTypedInput: "echo $",
      shellKind: "posix",
    }),
    false,
  );
  // Escaped `$` or `$VAR` (not immediately preceding the inserted quote) stays safe.
  assert.equal(isShellDraftSafeForPathInsertion("echo \\$", "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion("echo $HOME", "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion("echo $HOME ", "posix"), true);
});

test("isShellDraftSafeForPathInsertion handles fish, PowerShell, and CMD quoting rules", () => {
  // Fish escapes \' inside single quotes
  assert.equal(isShellDraftSafeForPathInsertion("cat ", "fish"), true);
  assert.equal(isShellDraftSafeForPathInsertion("echo 'a\\'b' ", "fish"), true);
  assert.equal(isShellDraftSafeForPathInsertion("echo 'a\\'", "fish"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo \"a", "fish"), false);
  assert.equal(isShellDraftSafeForPathInsertion("cat \\", "fish"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo $", "fish"), false);

  // PowerShell single/double quotes, doubled quotes, curly quotes, backtick escapes
  assert.equal(isShellDraftSafeForPathInsertion("Get-Content ", "powershell"), true);
  assert.equal(isShellDraftSafeForPathInsertion("echo 'O''Brien' ", "powershell"), true);
  assert.equal(isShellDraftSafeForPathInsertion("echo \"a`\"b\" ", "powershell"), true);
  assert.equal(isShellDraftSafeForPathInsertion("echo ``", "powershell"), true);
  assert.equal(isShellDraftSafeForPathInsertion("Get-Content \"", "powershell"), false);
  assert.equal(isShellDraftSafeForPathInsertion("Get-Content '", "powershell"), false);
  assert.equal(isShellDraftSafeForPathInsertion("Get-Content 'O''Brien", "powershell"), false);
  assert.equal(isShellDraftSafeForPathInsertion("Get-Content \u2019", "powershell"), false);
  assert.equal(isShellDraftSafeForPathInsertion("Get-Content \u201C", "powershell"), false);
  assert.equal(isShellDraftSafeForPathInsertion("Get-Content `", "powershell"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo @", "powershell"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo \"$(cat \"", "powershell"), false);

  // CMD double quotes and caret escapes
  assert.equal(isShellDraftSafeForPathInsertion("type ", "cmd"), true);
  assert.equal(isShellDraftSafeForPathInsertion("type \"a\" ", "cmd"), true);
  assert.equal(isShellDraftSafeForPathInsertion("type ^^", "cmd"), true);
  assert.equal(isShellDraftSafeForPathInsertion("type \"", "cmd"), false);
  assert.equal(isShellDraftSafeForPathInsertion("type ^", "cmd"), false);
});

test("isTerminalDraftContextSafeForPathInsertion rejects continuation prompts and un-echoed open quotes", () => {
  assert.equal(isTerminalContinuationPrompt("> "), true);
  assert.equal(isTerminalContinuationPrompt(">> "), true);
  assert.equal(isTerminalContinuationPrompt("dquote> "), true);
  assert.equal(isTerminalContinuationPrompt("quote> "), true);
  assert.equal(isTerminalContinuationPrompt("heredoc> "), true);
  assert.equal(isTerminalContinuationPrompt("user@host:~$ "), false);
  assert.equal(isTerminalContinuationPrompt("C:\\Users\\alice>"), false);
  assert.equal(isTerminalContinuationPrompt("PS C:\\Users\\alice> "), false);

  // Continuation prompt blocks even when current line draft is empty
  assert.equal(
    isTerminalDraftContextSafeForPathInsertion({
      promptText: "dquote> ",
      userInput: "",
      pendingTypedInput: "",
      shellKind: "posix",
    }),
    false,
  );

  // Typed-ahead open double quote over high-latency SSH (not yet echoed on screen)
  assert.equal(
    isTerminalDraftContextSafeForPathInsertion({
      promptText: "user@host:~$ ",
      userInput: "cat ",
      pendingTypedInput: "cat \"",
      shellKind: "posix",
    }),
    false,
  );

  // Recalled history with closing quote already echoed on screen stays safe
  assert.equal(
    isTerminalDraftContextSafeForPathInsertion({
      promptText: "user@host:~$ ",
      userInput: "echo \"hi\" ",
      pendingTypedInput: "\" ",
      shellKind: "posix",
    }),
    true,
  );

  // Normal echoed draft is safe
  assert.equal(
    isTerminalDraftContextSafeForPathInsertion({
      promptText: "user@host:~$ ",
      userInput: "cat ",
      pendingTypedInput: "cat ",
      shellKind: "posix",
    }),
    true,
  );
});

test("isShellDraftSafeForPathInsertion rejects POSIX arithmetic, parameter expansion, array subscripts, and let contexts", () => {
  // Arithmetic expansion $(( ... )) and arithmetic command (( ... ))
  assert.equal(isShellDraftSafeForPathInsertion("echo $((", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo $(( 1 + ", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion('echo "$((', "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo $(( (1 + 2) + ", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("(( ", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("for (( i=0; ", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo $(( $(echo ", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo $(( 'a))' + ", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo $(( 1 + 2 )) ", "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion("echo $(( (1 + 2) + 3 )) ", "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion('echo "$((1 + 2))" ', "posix"), true);

  // Legacy $[...] arithmetic
  assert.equal(isShellDraftSafeForPathInsertion("echo $[", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion('echo "$[', "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo $[1 + 2] ", "posix"), true);

  // Parameter expansions and array subscripts
  assert.equal(isShellDraftSafeForPathInsertion("echo ${a[", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion('echo "${a[', "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo ${var:-", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("a[", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("unset arr[", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("declare -i x[", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("cp ${DIR}/", "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion('echo "${a[0]}" ', "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion("a[0]=", "posix"), true);

  // `let` arithmetic builtin and `[[` arithmetic comparison operators
  assert.equal(isShellDraftSafeForPathInsertion("let ", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo ok; let ", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo $(let ", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion('echo "foo; let " ', "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion("[[ 1 -eq ", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("[[ $x -gt ", "posix"), false);
  assert.equal(isShellDraftSafeForPathInsertion("[[ -f ", "posix"), true);
  assert.equal(isShellDraftSafeForPathInsertion("[[ 1 -eq 1 ]] && ls ", "posix"), true);
});

test("isTerminalDraftContextSafeForCd rejects continuation prompts and non-empty drafts", () => {
  assert.equal(
    isTerminalDraftContextSafeForCd({
      promptText: "user@host:~$ ",
      userInput: "",
      pendingTypedInput: "",
    }),
    true,
  );
  assert.equal(
    isTerminalDraftContextSafeForCd({
      promptText: "root@host:/# ",
      userInput: "",
      pendingTypedInput: "",
    }),
    true,
  );

  // Continuation prompts must be rejected even when draft input is empty
  for (const promptText of [
    "dquote> ",
    "quote> ",
    "> ",
    ">> ",
    "heredoc> ",
    "dquote cmdsubst> ",
    "pipe dquote> ",
    "More? ",
  ]) {
    assert.equal(
      isTerminalDraftContextSafeForCd({
        promptText,
        userInput: "",
        pendingTypedInput: "",
      }),
      false,
      `expected continuation prompt ${JSON.stringify(promptText)} to block auto-cd`,
    );
  }

  // Non-empty draft input or un-echoed typed input must block auto-cd
  assert.equal(
    isTerminalDraftContextSafeForCd({
      promptText: "user@host:~$ ",
      userInput: "ls ",
      pendingTypedInput: "",
    }),
    false,
  );
  assert.equal(
    isTerminalDraftContextSafeForCd({
      promptText: "user@host:~$ ",
      userInput: "",
      pendingTypedInput: "rm -rf",
    }),
    false,
  );
});

test("unix-portable dialect quotes backslashes and quotes identically for POSIX and fish and intersects draft safety", () => {
  // Consecutive and trailing backslashes are emitted outside single quotes so
  // both POSIX shells (sh/bash/zsh) and fish decode the exact same literal path.
  assert.equal(
    formatSftpPathForTerminalInsert("/tmp/a\\b", "unix-portable"),
    "'/tmp/a'\\\\'b' ",
  );
  assert.equal(
    formatSftpPathForTerminalInsert("/tmp/a\\\\b", "unix-portable"),
    "'/tmp/a'\\\\\\\\'b' ",
  );
  assert.equal(
    formatSftpPathForTerminalInsert("/tmp/a\\", "unix-portable"),
    "'/tmp/a'\\\\ ",
  );
  assert.equal(
    formatSftpPathForTerminalInsert("/tmp/a\\'b", "unix-portable"),
    "'/tmp/a'\\\\\\''b' ",
  );
  assert.equal(
    formatSftpCdCommand("/tmp/a\\\\b", "unix-portable"),
    "cd -- '/tmp/a'\\\\\\\\'b'",
  );

  // Draft validation under unix-portable rejects BOTH POSIX-unsafe arithmetic
  // AND fish-unsafe escaped single quotes (`'foo\'` is unclosed in fish).
  assert.equal(isShellDraftSafeForPathInsertion("echo $((", "unix-portable"), false);
  assert.equal(isShellDraftSafeForPathInsertion("echo 'foo\\'", "unix-portable"), false);
  assert.equal(isShellDraftSafeForPathInsertion("cat ", "unix-portable"), true);
});

test("remote SSH sessions with unset shellType resolve PowerShell/CMD from prompt, normalize /C:/ paths, and reject unknown Windows shells", () => {
  const remoteNoShellType = { ...baseRemote, shellType: undefined };

  // Remote Unix SSH uses unix-portable dialect for backslash paths.
  assert.deepEqual(
    resolveInsertSftpPathInTerminalAction({
      ...remoteNoShellType,
      hostOs: "linux",
      promptText: "user@host ~> ",
      path: "/tmp/a\\\\b",
    }),
    {
      sessionId: "sess-1",
      data: "'/tmp/a'\\\\\\\\'b' ",
      shellKind: "unix-portable",
    },
  );

  // Remote Windows OpenSSH running PowerShell normalizes /C:/... paths.
  assert.deepEqual(
    resolveInsertSftpPathInTerminalAction({
      ...remoteNoShellType,
      hostOs: "windows",
      promptText: "PS C:\\Users\\alice> ",
      path: "/C:/Users/alice/my file.txt",
    }),
    {
      sessionId: "sess-1",
      data: "'C:\\Users\\alice\\my file.txt' ",
      shellKind: "powershell",
    },
  );
  assert.deepEqual(
    resolveCdSftpPathInTerminalAction({
      ...remoteNoShellType,
      hostOs: "windows",
      promptText: "PS C:\\Users\\alice> ",
      path: "/C:/Users/alice/my dir",
    }),
    {
      sessionId: "sess-1",
      data: "cd -LiteralPath 'C:\\Users\\alice\\my dir'\r",
    },
  );

  // Remote Windows OpenSSH running cmd.exe normalizes /C:/... paths.
  assert.deepEqual(
    resolveInsertSftpPathInTerminalAction({
      ...remoteNoShellType,
      hostOs: "windows",
      promptText: "C:\\Users\\alice>",
      path: "/C:/Users/alice/my file.txt",
    }),
    {
      sessionId: "sess-1",
      data: '"C:\\Users\\alice\\my file.txt" ',
      shellKind: "cmd",
    },
  );
  assert.deepEqual(
    resolveCdSftpPathInTerminalAction({
      ...remoteNoShellType,
      hostOs: "windows",
      promptText: "C:\\Users\\alice>",
      path: "/C:/Users/alice/my dir",
    }),
    {
      sessionId: "sess-1",
      data: 'cd /d "C:\\Users\\alice\\my dir"\r',
    },
  );

  // Remote Windows SSH with unknown shell dialect refuses instead of emitting POSIX syntax.
  assert.equal(
    resolveInsertSftpPathInTerminalAction({
      ...remoteNoShellType,
      hostOs: "windows",
      promptText: "custom> ",
      path: "/C:/Users/alice/my file.txt",
    }),
    null,
  );
  assert.equal(
    resolveCdSftpPathInTerminalAction({
      ...remoteNoShellType,
      hostOs: "windows",
      promptText: "custom> ",
      path: "/C:/Users/alice/my dir",
    }),
    null,
  );
});
