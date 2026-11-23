import assert from "node:assert/strict";
import test from "node:test";

import {
  canSendSftpPathToTerminal,
  formatSftpCdCommand,
  formatSftpPathForTerminalInsert,
  hasUnsafeTerminalControlChars,
  isShellDraftSafeForPathInsertion,
  isTerminalContinuationPrompt,
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

test("resolveSftpTerminalShellKind maps shellType to quoting dialect", () => {
  assert.equal(resolveSftpTerminalShellKind("posix"), "posix");
  assert.equal(resolveSftpTerminalShellKind("fish"), "fish");
  assert.equal(resolveSftpTerminalShellKind("powershell"), "powershell");
  assert.equal(resolveSftpTerminalShellKind("cmd"), "cmd");
  assert.equal(resolveSftpTerminalShellKind("unknown"), "posix");
  assert.equal(resolveSftpTerminalShellKind(undefined), "posix");
  assert.equal(resolveSftpTerminalShellKind(null), "posix");
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
