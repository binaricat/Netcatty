import test from "node:test";
import assert from "node:assert/strict";

import {
  createSudoPasswordAutofill,
  prepareSudoAutofillInput,
} from "./terminalSudoAutofill";
import {
  recordTerminalCommandExecution,
  resolveSubmittedShellCommand,
} from "./terminalCommandExecution";
import { createPromptLineBreakState } from "./promptLineBreak";

function createFakeTerm(
  lineText = "$ echo ok",
  cursorX = lineText.length,
  options?: {
    ghostFrom?: number;
    /** Per-cell fg overrides for accepted text (syntax highlighting). */
    fgAt?: (x: number) => number;
  },
) {
  const ghostFrom = options?.ghostFrom;
  const fgAt = options?.fgAt;
  return {
    buffer: {
      active: {
        cursorX,
        cursorY: 0,
        baseY: 0,
        getLine(line: number) {
          if (line !== 0) return undefined;
          return {
            isWrapped: false,
            translateToString() {
              return lineText;
            },
            getCell(x: number) {
              const isGhost = ghostFrom != null && x >= ghostFrom;
              return {
                getWidth: () => 1,
                getChars: () => lineText[x] ?? "",
                isDim: () => (isGhost ? 1 : 0),
                getFgColorMode: () => 0,
                getFgColor: () => {
                  if (isGhost) return 8;
                  return fgAt?.(x) ?? 15;
                },
              };
            },
          };
        },
      },
    },
  };
}

function createWrappedFakeTerm(rows: string[], cursorY: number, cursorX: number, cols: number) {
  return {
    cols,
    buffer: {
      active: {
        cursorX,
        cursorY,
        baseY: 0,
        getLine(line: number) {
          const lineText = rows[line];
          if (lineText === undefined) return undefined;
          return {
            isWrapped: line > 0,
            translateToString() {
              return lineText;
            },
          };
        },
      },
    },
  };
}

test("sudo autofill input preparation arms on a submitted sudo command without altering input", () => {
  const writes: string[] = [];
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    write: (data) => writes.push(data),
    onHint: () => true,
  });

  assert.equal(prepareSudoAutofillInput("\r", "sudo whoami", autofill), "\r");
  autofill.handleOutput("[sudo] password for alice: ");
  autofill.confirmFill();
  assert.deepEqual(writes, ["secret\n"]);
});

test("sudo autofill input preparation arms on a single-line pasted sudo command", () => {
  const writes: string[] = [];
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    write: (data) => writes.push(data),
    onHint: () => true,
  });

  assert.equal(prepareSudoAutofillInput("sudo whoami\n", null, autofill), "sudo whoami\n");
  autofill.handleOutput("[sudo] password for alice: ");
  autofill.confirmFill();
  assert.deepEqual(writes, ["secret\n"]);
});

test("sudo autofill input preparation preserves bracketed pasted sudo commands", () => {
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    write: () => {},
  });

  assert.equal(
    prepareSudoAutofillInput("\x1b[200~sudo whoami\n\x1b[201~", null, autofill),
    "\x1b[200~sudo whoami\n\x1b[201~",
  );
});

test("sudo autofill input preparation leaves ordinary commands unchanged", () => {
  const autofill = createSudoPasswordAutofill({
    password: "secret",
    write: () => {},
  });

  assert.equal(prepareSudoAutofillInput("\r", "echo ok", autofill), "\r");
  assert.equal(prepareSudoAutofillInput("x", "sudo whoami", autofill), "x");
  assert.equal(prepareSudoAutofillInput("sudo whoami\nsudo id\n", null, autofill), "sudo whoami\nsudo id\n");
});

test("command execution arms prompt line break even without command history callback", () => {
  const promptState = createPromptLineBreakState();
  const commandBufferRef = { current: "echo ok" };

  const recordedCommand = recordTerminalCommandExecution("echo ok", {
    host: {
      id: "host-1",
      label: "Host",
    },
    sessionId: "session-1",
    commandBufferRef,
    promptLineBreakStateRef: { current: promptState },
  });

  assert.equal(commandBufferRef.current, "");
  assert.equal(recordedCommand, "echo ok");
  assert.equal(promptState.pendingCommand, true);
});

test("sensitive terminal input never reaches command or semantic callbacks", () => {
  const promptState = createPromptLineBreakState();
  const commandBufferRef = { current: "correct horse battery staple" };
  const submitted: string[] = [];
  const executed: string[] = [];

  const recordedCommand = recordTerminalCommandExecution(
    commandBufferRef.current,
    {
      host: { id: "host-1", label: "Host" },
      sessionId: "session-1",
      commandBufferRef,
      promptLineBreakStateRef: { current: promptState },
      onCommandSubmitted: (command) => submitted.push(command),
      onCommandExecuted: (command) => executed.push(command),
    },
    createFakeTerm("Password: correct horse battery staple") as never,
    { sensitive: true },
  );

  assert.equal(recordedCommand, null);
  assert.equal(commandBufferRef.current, "");
  assert.deepEqual(submitted, []);
  assert.deepEqual(executed, []);
  assert.equal(promptState.pendingCommand, false);
});

test("resolveSubmittedShellCommand recovers ↑ history when keystroke buffer is empty (#2191)", () => {
  // Shell history redraws the line remotely; commandBuffer never sees "su -".
  assert.equal(
    resolveSubmittedShellCommand("", createFakeTerm("user@host:~$ su -") as never),
    "su -",
  );
  assert.equal(
    resolveSubmittedShellCommand("", createFakeTerm("user@host:~$ sudo whoami") as never),
    "sudo whoami",
  );
  // Prefer the typed buffer when present
  assert.equal(
    resolveSubmittedShellCommand("ls", createFakeTerm("user@host:~$ ls") as never),
    "ls",
  );
});

test("resolveSubmittedShellCommand strips themed prompt chrome without stale cache (#2191)", () => {
  // Themed decoration must not become the command (#806); peel via reconcile.
  assert.equal(
    resolveSubmittedShellCommand("", createFakeTerm("➜  git su -") as never),
    "su -",
  );
  assert.equal(
    resolveSubmittedShellCommand("", createFakeTerm("➜  ~ sudo whoami") as never),
    "sudo whoami",
  );
  // Cached prompt still works when present (including after prompt-changing cd).
  assert.equal(
    resolveSubmittedShellCommand(
      "",
      createFakeTerm("➜  git su -") as never,
      "➜  git ",
    ),
    "su -",
  );
  // Stale cache from before `cd` must not block themed history recall.
  assert.equal(
    resolveSubmittedShellCommand(
      "",
      createFakeTerm("➜  git su -") as never,
      "➜  ~ ",
    ),
    "su -",
  );
  // Partial cache after git status appears must peel remaining decoration.
  assert.equal(
    resolveSubmittedShellCommand(
      "",
      createFakeTerm("➜  netcatty git:(main) ✗ su -") as never,
      "➜  netcatty ",
    ),
    "su -",
  );
  // Complete Powerline prompts isolate multiword sudo already.
  assert.equal(
    resolveSubmittedShellCommand(
      "",
      createFakeTerm("\uE0B6 root \uE0B0 ~ \uE0B0 sudo whoami") as never,
    ),
    "sudo whoami",
  );
  // Empty Enter on themed decoration must not invent a command (#2191 review).
  assert.equal(
    resolveSubmittedShellCommand("", createFakeTerm("➜  git ") as never),
    "",
  );
  assert.equal(
    resolveSubmittedShellCommand(
      "",
      createFakeTerm("➜  netcatty git:(main) ✗ ") as never,
    ),
    "",
  );
  // One-word su at a glyph-only prompt must still arm (#2191 review).
  assert.equal(
    resolveSubmittedShellCommand("", createFakeTerm("❯ su") as never),
    "su",
  );
  // Double-space after glyph must not peel "su" into decoration.
  assert.equal(
    resolveSubmittedShellCommand("", createFakeTerm("❯  su -") as never),
    "su -",
  );
  assert.equal(
    resolveSubmittedShellCommand("", createFakeTerm("❯  sudo whoami") as never),
    "sudo whoami",
  );
  // Multi-word themed directory without cache.
  assert.equal(
    resolveSubmittedShellCommand("", createFakeTerm("➜  My Project su -") as never),
    "su -",
  );
  // Directory token "su " with trailing pad is chrome, not a command.
  assert.equal(
    resolveSubmittedShellCommand("", createFakeTerm("➜  su ") as never),
    "",
  );
  // Absolute path commands on normal prompts are real, not decoration.
  assert.equal(
    resolveSubmittedShellCommand(
      "",
      createFakeTerm("user@host:~$ /bin/ls") as never,
    ),
    "/bin/ls",
  );
  // Cursor mid-line: empty buffer does not absorb post-cursor paint (autosuggest).
  // At EOL with empty buffer, the full recalled line is already in userInput.
  assert.equal(
    resolveSubmittedShellCommand(
      "",
      createFakeTerm("user@host:~$ sudo whoami") as never,
    ),
    "sudo whoami",
  );
  // zsh-style suggestion after the cursor must not be recorded as input.
  assert.equal(
    resolveSubmittedShellCommand(
      "git",
      createFakeTerm("user@host:~$ git status", "user@host:~$ git".length) as never,
    ),
    "git",
  );
  // Same-token autosuggest (typed "g", paint "git status") must stay "g".
  assert.equal(
    resolveSubmittedShellCommand(
      "g",
      createFakeTerm("user@host:~$ git status", "user@host:~$ g".length) as never,
    ),
    "g",
  );
  // Stale typed prefix after history to privilege command.
  assert.equal(
    resolveSubmittedShellCommand(
      "s",
      createFakeTerm("user@host:~$ su -") as never,
    ),
    "su -",
  );
  // Double-space glyph + non-privilege history keeps the first word.
  assert.equal(
    resolveSubmittedShellCommand("", createFakeTerm("❯  git status") as never),
    "git status",
  );
  // Unicode / punctuated themed directories before su.
  assert.equal(
    resolveSubmittedShellCommand("", createFakeTerm("➜  项目 su -") as never),
    "su -",
  );
  assert.equal(
    resolveSubmittedShellCommand("", createFakeTerm("➜  Project (old) su -") as never),
    "su -",
  );
  // Ordinary commands ending in "su -" must not be peeled to privilege-only.
  assert.equal(
    resolveSubmittedShellCommand("", createFakeTerm("❯  echo su -") as never),
    "echo su -",
  );
  // No-space prompt on first history recall (no lastPromptText cache).
  assert.equal(
    resolveSubmittedShellCommand("", createFakeTerm("user@host:~$su -") as never),
    "su -",
  );
  // Themed multi-word dir resolves and still records for arming.
  {
    const commandBufferRef = { current: "" };
    const recorded = recordTerminalCommandExecution("", {
      host: { id: "h", label: "H" },
      sessionId: "s",
      commandBufferRef,
    }, createFakeTerm("➜  My Project su -") as never);
    assert.equal(recorded, "su -");
  }
  // Incomplete remote echo of a longer typed word: trust keystrokes.
  assert.equal(
    resolveSubmittedShellCommand(
      "sudo",
      createFakeTerm("user@host:~$ su") as never,
    ),
    "sudo",
  );
  // History shortened a multi-word typed buffer to a different short command.
  assert.equal(
    resolveSubmittedShellCommand(
      "sudo whoami",
      createFakeTerm("user@host:~$ su") as never,
    ),
    "su",
  );
  // No trailing space after $: recover via lastPromptText (#2191 review).
  assert.equal(
    resolveSubmittedShellCommand(
      "",
      createFakeTerm("user@host:~$su -") as never,
      "user@host:~$",
    ),
    "su -",
  );
  // Stale partial cache on empty themed prompt must not record git chrome.
  assert.equal(
    resolveSubmittedShellCommand(
      "",
      createFakeTerm("➜  netcatty git:(main) ✗ ") as never,
      "➜  netcatty ",
    ),
    "",
  );
  // Prefixed themed terminator + cwd token is not a command.
  assert.equal(
    resolveSubmittedShellCommand("", createFakeTerm("⚡ ➜  git ") as never),
    "",
  );
  // Stale buffer aligned to mid-line prefix after history recall.
  assert.equal(
    resolveSubmittedShellCommand(
      "s",
      createFakeTerm("user@host:~$ su -", "user@host:~$ s".length) as never,
    ),
    "su -",
  );
});

test("resolveSubmittedShellCommand prefers live line when history replaces a typed prefix (#2191)", () => {
  // User typed "s" then ↑ recalled "su -" — buffer still holds the stale prefix.
  assert.equal(
    resolveSubmittedShellCommand("s", createFakeTerm("user@host:~$ su -") as never),
    "su -",
  );
  assert.equal(
    resolveSubmittedShellCommand("s", createFakeTerm("➜  git su -") as never),
    "su -",
  );
  // Echo lag: buffer ahead of live echo keeps the typed command.
  assert.equal(
    resolveSubmittedShellCommand("su -", createFakeTerm("user@host:~$ su") as never),
    "su -",
  );
});

test("resolveSubmittedShellCommand records full line after mid-line history edit (#2850)", () => {
  // ↑ recalled "systemctl stop firewalld", cursor moved onto "stop", replaced
  // with "start", Enter while still mid-line. Keystroke buffer only saw the
  // replacement token; Enter still submits the whole zle line.
  const line = "user@host:~$ systemctl start firewalld";
  const cursorAfterStart = "user@host:~$ systemctl start".length;
  assert.equal(
    resolveSubmittedShellCommand(
      "start",
      createFakeTerm(line, cursorAfterStart) as never,
    ),
    "systemctl start firewalld",
  );
  // Empty buffer + mid-line cursor after recall/edit (no typed suffix).
  assert.equal(
    resolveSubmittedShellCommand(
      "",
      createFakeTerm(line, cursorAfterStart) as never,
    ),
    "systemctl start firewalld",
  );
  // Per-token syntax highlighting must not strip the accepted suffix after
  // the cursor (command / arg / path colors differ across the line).
  {
    const prompt = "user@host:~$ ";
    const cmd = "systemctl start firewalld";
    const painted = `${prompt}${cmd}`;
    const cursor = `${prompt}systemctl start`.length;
    const systemctlEnd = `${prompt}systemctl`.length;
    const startEnd = `${prompt}systemctl start`.length;
    assert.equal(
      resolveSubmittedShellCommand(
        "start",
        createFakeTerm(painted, cursor, {
          fgAt: (x) => {
            if (x < prompt.length) return 15;
            if (x < systemctlEnd) return 2; // command
            if (x < startEnd) return 3; // arg
            return 4; // differently colored accepted suffix
          },
        }) as never,
      ),
      "systemctl start firewalld",
    );
  }
  // zsh autosuggest paint past the cursor must stay on the typed prefix.
  assert.equal(
    resolveSubmittedShellCommand(
      "git",
      createFakeTerm("user@host:~$ git status", "user@host:~$ git".length) as never,
    ),
    "git",
  );
  // ↑ recalled "git", then typed " st" with zsh ghost "atus". Enter submits
  // "git st", not the unaccepted suggestion "git status".
  assert.equal(
    resolveSubmittedShellCommand(
      " st",
      createFakeTerm(
        "user@host:~$ git status",
        "user@host:~$ git st".length,
        { ghostFrom: "user@host:~$ git st".length },
      ) as never,
    ),
    "git st",
  );
  assert.equal(
    resolveSubmittedShellCommand(
      "st",
      createFakeTerm(
        "user@host:~$ git status",
        "user@host:~$ git st".length,
        { ghostFrom: "user@host:~$ git st".length },
      ) as never,
    ),
    "git st",
  );
  // Cross-token autosuggest after history: ↑ "sudo", typed " apt", ghost
  // " upgrade". Enter submits "sudo apt", not "sudo apt upgrade".
  assert.equal(
    resolveSubmittedShellCommand(
      " apt",
      createFakeTerm(
        "user@host:~$ sudo apt upgrade",
        "user@host:~$ sudo apt".length,
        { ghostFrom: "user@host:~$ sudo apt".length },
      ) as never,
    ),
    "sudo apt",
  );
  // End-to-end: history callback must receive the full painted command.
  {
    const commandBufferRef = { current: "start" };
    const recorded: string[] = [];
    const recordedCommand = recordTerminalCommandExecution("start", {
      host: { id: "host-1", label: "Host" },
      sessionId: "session-1",
      commandBufferRef,
      onCommandExecuted(cmd) {
        recorded.push(cmd);
      },
    }, createFakeTerm(line, cursorAfterStart) as never);
    assert.equal(recordedCommand, "systemctl start firewalld");
    assert.deepEqual(recorded, ["systemctl start firewalld"]);
  }
});

test("recordTerminalCommandExecution arms su after empty-buffer history recall (#2191)", () => {
  const commandBufferRef = { current: "" };
  const recorded: string[] = [];
  const recordedCommand = recordTerminalCommandExecution("", {
    host: { id: "host-1", label: "Host" },
    sessionId: "session-1",
    commandBufferRef,
    onCommandExecuted(cmd) {
      recorded.push(cmd);
    },
  }, createFakeTerm("user@host:~$ su -") as never);

  assert.equal(recordedCommand, "su -");
  assert.deepEqual(recorded, ["su -"]);
  assert.equal(commandBufferRef.current, "");

  // Full Enter path: empty buffer + live line still arms sudo autofill
  const writes: string[] = [];
  const autofill = createSudoPasswordAutofill({
    mode: "picker",
    candidates: [
      { id: "host", label: "Host", password: "host-secret" },
      { id: "identity:root", label: "Root", password: "root-secret" },
    ],
    write: (d) => writes.push(d),
    onPicker: () => true,
  });
  prepareSudoAutofillInput("\r", recordedCommand, autofill);
  autofill.handleOutput("Password: ");
  assert.equal(autofill.isPickerPending(), true);
  autofill.confirmFill("host");
  assert.deepEqual(writes, ["host-secret\n"]);
});

test("recordTerminalCommandExecution arms su from themed history using lastPromptText (#2191)", () => {
  const promptState = createPromptLineBreakState();
  promptState.lastPromptText = "➜  git ";
  const commandBufferRef = { current: "" };
  const recordedCommand = recordTerminalCommandExecution("", {
    host: { id: "host-1", label: "Host" },
    sessionId: "session-1",
    commandBufferRef,
    promptLineBreakStateRef: { current: promptState },
  }, createFakeTerm("➜  git su -") as never);

  assert.equal(recordedCommand, "su -");

  const autofill = createSudoPasswordAutofill({
    mode: "picker",
    candidates: [
      { id: "host", label: "Host", password: "host-secret" },
      { id: "identity:root", label: "Root", password: "root-secret" },
    ],
    write: () => {},
    onPicker: () => true,
  });
  prepareSudoAutofillInput("\r", recordedCommand, autofill);
  autofill.handleOutput("Password: ");
  assert.equal(autofill.isPickerPending(), true);
});

test("command execution caches the current prompt instead of prompt-like command text", () => {
  const promptState = createPromptLineBreakState();
  const commandBufferRef = { current: "echo > out" };

  recordTerminalCommandExecution("echo > out", {
    host: {
      id: "host-1",
      label: "Host",
    },
    sessionId: "session-1",
    commandBufferRef,
    promptLineBreakStateRef: { current: promptState },
  }, createFakeTerm("$ echo > out") as never);

  assert.equal(promptState.lastPromptText, "$ ");
  assert.equal(promptState.pendingCommand, true);
});

test("command execution does not write interactive program input to shell history", () => {
  const cases = [
    { lineText: "sftp> get file", command: "get file" },
    { lineText: "cqlsh:cycling> select * from cyclist", command: "select * from cyclist" },
    { lineText: "hive (default)> select 1", command: "select 1" },
    { lineText: "trino:tpch> select 1", command: "select 1" },
    { lineText: "lftp user@example.com:~> ls", command: "ls" },
    { lineText: "irb(main):001> puts 1", command: "puts 1" },
    { lineText: "pry(main)> whereami", command: "whereami" },
    { lineText: "[1] pry(main)> whereami", command: "whereami" },
    { lineText: "SQL> select 1", command: "select 1" },
    { lineText: "test> db.stats()", command: "db.stats()" },
    { lineText: "test> db", command: "db" },
    { lineText: "test> const x = 1", command: "const x = 1" },
    { lineText: "test> await db.users.findOne()", command: "await db.users.findOne()" },
    { lineText: "rs0:PRIMARY> db.stats()", command: "db.stats()" },
    { lineText: "rs0 [direct: primary] test> db.stats()", command: "db.stats()" },
    { lineText: "rs0 [direct: primary] reporting> db.stats()", command: "db.stats()" },
    { lineText: "rs0 [direct: primary] reporting> const x = 1", command: "const x = 1" },
    { lineText: "rs0 [direct: primary] reporting> await db.users.findOne()", command: "await db.users.findOne()" },
    { lineText: "Atlas a [primary] reporting> db.stats()", command: "db.stats()" },
    { lineText: "Atlas a [primary] reporting> await db.users.findOne()", command: "await db.users.findOne()" },
    { lineText: "test> print(1)", command: "print(1)" },
    { lineText: "rs0 primary test> db.stats()", command: "db.stats()" },
    { lineText: "test> rs.status()", command: "rs.status()" },
    { lineText: "rs0 primary reporting> exit", command: "exit" },
    { lineText: "admin@localhost:27017> db.stats()", command: "db.stats()" },
  ];

  for (const { lineText, command } of cases) {
    const commandBufferRef = { current: command };
    const promptState = createPromptLineBreakState();
    const recorded: string[] = [];

    const recordedCommand = recordTerminalCommandExecution(command, {
      host: {
        id: "host-1",
        label: "Host",
      },
      sessionId: "session-1",
      commandBufferRef,
      promptLineBreakStateRef: { current: promptState },
      onCommandExecuted(nextCommand) {
        recorded.push(nextCommand);
      },
    }, createFakeTerm(lineText) as never);

    assert.deepEqual(recorded, [], lineText);
    assert.equal(recordedCommand, null, lineText);
    assert.equal(commandBufferRef.current, "", lineText);
    assert.equal(promptState.lastPromptText, "", lineText);
    assert.equal(promptState.pendingCommand, true, lineText);
  }
});

test("command execution does not record interactive input before echo appears", () => {
  const cases = [
    { lineText: "test> ", command: "rs.status()" },
    { lineText: "test> ", command: "db" },
    { lineText: "test> ", command: "const x = 1" },
    { lineText: "test> ", command: "await db.users.findOne()" },
    { lineText: "rs0 [direct: primary] reporting> ", command: "const x = 1" },
    { lineText: "rs0 [direct: primary] reporting> ", command: "await db.users.findOne()" },
    { lineText: "rs0 [direct: primary] test> ", command: "db.stats()" },
    { lineText: "rs0 [direct: primary] reporting> ", command: "db.stats()" },
    { lineText: "Atlas a [primary] reporting> ", command: "db.stats()" },
  ];

  for (const { lineText, command } of cases) {
    const commandBufferRef = { current: command };
    const recorded: string[] = [];

    recordTerminalCommandExecution(command, {
      host: {
        id: "host-1",
        label: "Host",
      },
      sessionId: "session-1",
      commandBufferRef,
      onCommandExecuted(nextCommand) {
        recorded.push(nextCommand);
      },
    }, createFakeTerm(lineText) as never);

    assert.deepEqual(recorded, [], lineText);
    assert.equal(commandBufferRef.current, "", lineText);
  }
});

test("command execution publishes submitted commands even when history recording is skipped", () => {
  const commandBufferRef = { current: "cd /srv/app" };
  const history: string[] = [];
  const submitted: string[] = [];

  const recordedCommand = recordTerminalCommandExecution("cd /srv/app", {
    host: {
      id: "host-1",
      label: "Host",
    },
    sessionId: "session-1",
    commandBufferRef,
    onCommandExecuted(nextCommand) {
      history.push(nextCommand);
    },
    onCommandSubmitted(nextCommand) {
      submitted.push(nextCommand);
    },
  }, createFakeTerm("sftp> cd /srv/app") as never);

  assert.deepEqual(history, []);
  assert.deepEqual(submitted, ["cd /srv/app"]);
  assert.equal(recordedCommand, null);
  assert.equal(commandBufferRef.current, "");
});

test("command execution does not record wrapped interactive program input", () => {
  const cases = [
    { rows: ["Atlas a [primary]", " reporting> db.stats()"], command: "db.stats()" },
    { rows: ["test> d", "b"], command: "db" },
  ];

  for (const { rows, command } of cases) {
    const commandBufferRef = { current: command };
    const recorded: string[] = [];

    recordTerminalCommandExecution(command, {
      host: {
        id: "host-1",
        label: "Host",
      },
      sessionId: "session-1",
      commandBufferRef,
      onCommandExecuted(nextCommand) {
        recorded.push(nextCommand);
      },
    }, createWrappedFakeTerm(rows, 1, rows[1].length, 20) as never);

    assert.deepEqual(recorded, [], rows[0]);
    assert.equal(commandBufferRef.current, "", rows[0]);
  }
});

test("command execution records non-Mongo-looking default-name greater-than prompts", () => {
  const prompts = ["test> ", "admin> ", "local> ", "config> "];
  const commands = ["deploy", "exit", "help", "show dbs"];

  for (const prompt of prompts) {
    for (const command of commands) {
      const commandBufferRef = { current: command };
      const recorded: string[] = [];

      recordTerminalCommandExecution(command, {
        host: {
          id: "host-1",
          label: "Host",
        },
        sessionId: "session-1",
        commandBufferRef,
        onCommandExecuted(nextCommand) {
          recorded.push(nextCommand);
        },
      }, createFakeTerm(`${prompt}${command}`) as never);

      assert.deepEqual(recorded, [command], `${prompt}${command}`);
      assert.equal(commandBufferRef.current, "", `${prompt}${command}`);
    }
  }
});

test("command execution records wrapped non-Mongo-looking default-name greater-than prompts", () => {
  const cases = [
    { rows: ["test> hel", "p"], command: "help" },
    { rows: ["test> show ", "dbs"], command: "show dbs" },
    { rows: ["admin> ex", "it"], command: "exit" },
    { rows: ["local> dep", "loy"], command: "deploy" },
  ];

  for (const { rows, command } of cases) {
    const commandBufferRef = { current: command };
    const recorded: string[] = [];

    recordTerminalCommandExecution(command, {
      host: {
        id: "host-1",
        label: "Host",
      },
      sessionId: "session-1",
      commandBufferRef,
      onCommandExecuted(nextCommand) {
        recorded.push(nextCommand);
      },
    }, createWrappedFakeTerm(rows, 1, rows[1].length, 20) as never);

    assert.deepEqual(recorded, [command], rows[0]);
    assert.equal(commandBufferRef.current, "", rows[0]);
  }
});

test("command execution records short commands when standard prompt echo lags by one character", () => {
  const cases = [
    { lineText: "$ l", command: "ls" },
    { lineText: "$ c", command: "cd" },
    { lineText: "prod-web> l", command: "ls" },
    { lineText: "prod> l", command: "ls" },
    { lineText: "prod.web> l", command: "ls" },
    { lineText: "user@host:~$ l", command: "ls" },
    { lineText: "[user@host ~]$ l", command: "ls" },
    { lineText: "➜  netcatty $ l", command: "ls" },
    { lineText: "➜  git l", command: "ls" },
    { lineText: "➜  git np", command: "npm" },
  ];

  for (const { lineText, command } of cases) {
    const commandBufferRef = { current: command };
    const recorded: string[] = [];

    recordTerminalCommandExecution(command, {
      host: {
        id: "host-1",
        label: "Host",
      },
      sessionId: "session-1",
      commandBufferRef,
      onCommandExecuted(nextCommand) {
        recorded.push(nextCommand);
      },
    }, createFakeTerm(lineText) as never);

    assert.deepEqual(recorded, [command], lineText);
    assert.equal(commandBufferRef.current, "", lineText);
  }
});

test("command execution records direct sends from themed bare directory prompts", () => {
  const cases = [
    { lineText: "➜  netcatty ", command: "ls", promptText: "➜  netcatty " },
    { lineText: "➜  git ", command: "npm", promptText: "➜  git " },
    { lineText: "➜  git ", command: "git status", promptText: "➜  git " },
    { lineText: "➜  make ", command: "sudo", promptText: "➜  make " },
    { lineText: "➜  make ", command: "make build", promptText: "➜  make " },
    { lineText: "➜  node ", command: "yarn", promptText: "➜  node " },
  ];

  for (const { lineText, command, promptText } of cases) {
    const commandBufferRef = { current: command };
    const promptState = createPromptLineBreakState();
    const recorded: string[] = [];

    recordTerminalCommandExecution(command, {
      host: {
        id: "host-1",
        label: "Host",
      },
      sessionId: "session-1",
      commandBufferRef,
      promptLineBreakStateRef: { current: promptState },
      onCommandExecuted(nextCommand) {
        recorded.push(nextCommand);
      },
    }, createFakeTerm(lineText) as never);

    assert.deepEqual(recorded, [command], lineText);
    assert.equal(commandBufferRef.current, "", lineText);
    assert.equal(promptState.lastPromptText, promptText, lineText);
    assert.equal(promptState.pendingCommand, true, lineText);
  }
});

test("command execution still records host-style greater-than prompts", () => {
  const prompts = [
    "prod-web> ",
    "prod> ",
    "prod.web> ",
    "server> ",
    "staging> ",
    "webdb> ",
    "prod.db> ",
  ];
  const commands = ["deploy", "exit", "show dbs", "use app", "it", "help", "print(1)", "db.stats()"];

  for (const prompt of prompts) {
    for (const command of commands) {
      const commandBufferRef = { current: command };
      const recorded: string[] = [];

      recordTerminalCommandExecution(command, {
        host: {
          id: "host-1",
          label: "Host",
        },
        sessionId: "session-1",
        commandBufferRef,
        onCommandExecuted(nextCommand) {
          recorded.push(nextCommand);
        },
      }, createFakeTerm(`${prompt}${command}`) as never);

      assert.deepEqual(recorded, [command], `${prompt}${command}`);
      assert.equal(commandBufferRef.current, "", `${prompt}${command}`);
    }
  }
});

test("command execution records direct sends from host-style greater-than prompts", () => {
  const cases = [
    { lineText: "server> ", command: "exit" },
    { lineText: "staging> ", command: "show dbs" },
    { lineText: "server> ", command: "db.stats()" },
    { lineText: "webdb> ", command: "deploy" },
    { lineText: "prod.db> ", command: "deploy" },
    { lineText: "test> ", command: "deploy" },
    { lineText: "test> ", command: "exit" },
    { lineText: "test> ", command: "help" },
    { lineText: "test> ", command: "show dbs" },
    { lineText: "admin> ", command: "deploy" },
  ];

  for (const { lineText, command } of cases) {
    const commandBufferRef = { current: command };
    const recorded: string[] = [];

    recordTerminalCommandExecution(command, {
      host: {
        id: "host-1",
        label: "Host",
      },
      sessionId: "session-1",
      commandBufferRef,
      onCommandExecuted(nextCommand) {
        recorded.push(nextCommand);
      },
    }, createFakeTerm(lineText) as never);

    assert.deepEqual(recorded, [command], lineText);
    assert.equal(commandBufferRef.current, "", lineText);
  }
});

test("alternate-screen history preview stays selectable and copyable", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");

  assert.match(source, /pointerEvents:\s*"auto"/);
  assert.match(source, /userSelect:\s*"text"/);
  assert.match(source, /shouldHideHistoryPreviewOnMouseDown/);
  assert.match(source, /shouldKeepHistoryPreviewOnKey/);
  assert.match(source, /previewSelection \|\| getTerminalSelectionForClipboard/);
  assert.match(source, /hasCopyableSelection = term\.hasSelection\(\) \|\| Boolean\(previewSelection\)/);
  assert.match(source, /shouldUseUrgentTerminalInterrupt\(e, \{ hasSelection: hasCopyableSelection \}\)/);
  assert.match(source, /isHistoryPreviewDismissClick/);
  assert.match(source, /HISTORY_PREVIEW_WRAP_ATTR/);
  assert.match(source, /HISTORY_PREVIEW_HIDE_EVENT/);
  assert.match(source, /document\.addEventListener\("copy", handlePreviewNativeCopy, true\)/);
});
