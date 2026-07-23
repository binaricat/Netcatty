import test from "node:test";
import assert from "node:assert/strict";

import {
  consumeOsc133CommandCompletion,
  createPromptLineBreakState,
  detectTerminalCommandCompletions,
  findTerminalPromptSourceChunkVisibleStarts,
  insertPromptLineBreakBeforePrompt,
  markPromptLineBreakCommandPending,
  markTerminalCommandCompletionPending,
  prepareTerminalDataForPromptLineBreak,
  syncPromptLineBreakState,
} from "./promptLineBreak";

test("finds prompt chunks across trailing and leading ANSI sequences", () => {
  const trailingAnsiData = "file tail\x1b[0m$ ";
  assert.deepEqual(
    findTerminalPromptSourceChunkVisibleStarts(
      trailingAnsiData,
      "$ ",
      ["file tail\x1b[0m".length],
    ),
    ["file tail".length],
  );

  const leadingAnsiData = "file tail\x1b[32m$ ";
  assert.deepEqual(
    findTerminalPromptSourceChunkVisibleStarts(leadingAnsiData, "$ ", ["file tail".length]),
    ["file tail".length],
  );
  assert.deepEqual(findTerminalPromptSourceChunkVisibleStarts("file tail$ ", "$ ", []), []);

  const clearData = "file tail\x1b[2J$ ";
  const promptVisibleStarts = findTerminalPromptSourceChunkVisibleStarts(
    clearData,
    "$ ",
    ["file tail\x1b[2J".length],
  );
  const state = createPromptLineBreakState();
  state.lastPromptText = "$ ";
  state.pendingCommand = true;
  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("", 0) as never,
      "file tail\x1b[2J\x1b[3J$ ",
      state,
      true,
      promptVisibleStarts,
    ),
    "file tail\r\n\x1b[2J\x1b[3J$ ",
  );
});

test("keeps cursor movement before a prompt-side line break", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "$ ";
  state.pendingCommand = true;
  const output = "foo\x1b[E";
  const data = `${output}$ `;
  const promptStarts = findTerminalPromptSourceChunkVisibleStarts(
    data,
    state.lastPromptText,
    [output.length],
  );

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("", 0) as never,
      data,
      state,
      true,
      promptStarts,
    ),
    data,
  );
});

test("measures cursor-only prompt prefixes before deciding on a line break", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "$ ";
  state.pendingCommand = true;
  const cursorForward = "\x1b[10C";
  const data = `${cursorForward}$ `;

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("", 0) as never,
      data,
      state,
      true,
      findTerminalPromptSourceChunkVisibleStarts(data, "$ ", [cursorForward.length]),
    ),
    `${cursorForward}\r\n$ `,
  );
});

test("does not move a clear-screen prompt away from cursor home", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "$ ";
  state.pendingCommand = true;
  const data = "\x1b[H\x1b[2J$ ";

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("", 5) as never,
      data,
      state,
      true,
      findTerminalPromptSourceChunkVisibleStarts(data, "$ "),
    ),
    data,
  );
});

test("does not add a second break after carriage return", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "$ ";
  state.pendingCommand = true;
  const output = "foo\r";
  const data = `${output}$ `;

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("", 5) as never,
      data,
      state,
      true,
      findTerminalPromptSourceChunkVisibleStarts(data, "$ ", [output.length]),
    ),
    data,
  );
});

test("does not move prompts after row-positioning controls", () => {
  for (const control of ["\x1b[r", "\x1b[A", "\x1b[B", "\x1b[d", "\x1b[e"]) {
    const state = createPromptLineBreakState();
    state.lastPromptText = "$ ";
    state.pendingCommand = true;
    const data = `${control}$ `;

    assert.equal(
      prepareTerminalDataForPromptLineBreak(
        createFakeTerm("", 0) as never,
        data,
        state,
        true,
        findTerminalPromptSourceChunkVisibleStarts(data, "$ ", [control.length]),
      ),
      data,
      JSON.stringify(control),
    );
  }
});

test("keeps non-moving mode toggles on the prompt side of an inserted break", () => {
  for (const control of ["\x1b[?2004h", "\x1b[?25h", "\x1b[?25l"]) {
    const stateAtLineStart = createPromptLineBreakState();
    stateAtLineStart.lastPromptText = "$ ";
    stateAtLineStart.pendingCommand = true;
    const data = `${control}$ `;
    const promptStarts = findTerminalPromptSourceChunkVisibleStarts(
      data,
      stateAtLineStart.lastPromptText,
      [control.length],
    );

    assert.equal(
      prepareTerminalDataForPromptLineBreak(
        createFakeTerm("", 0) as never,
        data,
        stateAtLineStart,
        true,
        promptStarts,
      ),
      data,
      JSON.stringify(control),
    );

    const stateMidLine = createPromptLineBreakState();
    stateMidLine.lastPromptText = "$ ";
    stateMidLine.pendingCommand = true;
    assert.equal(
      prepareTerminalDataForPromptLineBreak(
        createFakeTerm("output", 6) as never,
        data,
        stateMidLine,
        true,
        promptStarts,
      ),
      `\r\n${data}`,
      JSON.stringify(control),
    );
  }
});

test("inserts a prompt line break after leaving the alternate screen", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "$ ";
  state.pendingCommand = true;
  const leaveAlternateScreen = "\x1b[?1049l";
  const data = `${leaveAlternateScreen}$ `;
  const promptStarts = findTerminalPromptSourceChunkVisibleStarts(
    data,
    state.lastPromptText,
    [leaveAlternateScreen.length],
  );

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("", 5) as never,
      data,
      state,
      true,
      promptStarts,
    ),
    `${leaveAlternateScreen}\r\n$ `,
  );
});

function createFakeTerm(lineText = "", cursorX = lineText.length) {
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
          };
        },
      },
    },
  };
}

test("command completion tracking prefers OSC 133 and consumes one submitted command", () => {
  const state = createPromptLineBreakState();
  const stateRef = { current: state };
  markTerminalCommandCompletionPending(stateRef);
  markTerminalCommandCompletionPending(stateRef);

  assert.equal(consumeOsc133CommandCompletion("C", state), false);
  assert.equal(consumeOsc133CommandCompletion("D;0", state), true);
  assert.equal(state.pendingCommandCompletions, 1);
  assert.equal(consumeOsc133CommandCompletion("D;1", state), true);
  assert.equal(consumeOsc133CommandCompletion("D;0", state), false);
});

test("command completion prompt fallback drains bounded submitted commands only at an empty prompt", () => {
  const state = createPromptLineBreakState();
  const stateRef = { current: state };
  markTerminalCommandCompletionPending(stateRef);
  markTerminalCommandCompletionPending(stateRef);

  assert.equal(
    detectTerminalCommandCompletions(createFakeTerm("$ echo pending") as never, state),
    0,
  );
  assert.equal(state.pendingCommandCompletions, 2);
  assert.equal(
    detectTerminalCommandCompletions(createFakeTerm("$ ") as never, state),
    2,
  );
  assert.equal(state.pendingCommandCompletions, 0);
  assert.equal(
    detectTerminalCommandCompletions(createFakeTerm("$ ") as never, state),
    0,
  );
});

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

test("does not insert before prompt-like suffixes in a larger output chunk", () => {
  assert.equal(
    insertPromptLineBreakBeforePrompt("hello$ ", "$ ", 0),
    "hello$ ",
  );
});

test("inserts at the start of a prompt chunk when previous output left the cursor mid-line", () => {
  assert.equal(
    insertPromptLineBreakBeforePrompt("$ ", "$ ", 5),
    "\r\n$ ",
  );
});

test("does not insert when the output already ends with a line break", () => {
  assert.equal(
    insertPromptLineBreakBeforePrompt("hello\r\n$ ", "$ ", 0),
    "hello\r\n$ ",
  );
});

test("keeps prompt ANSI styling on the prompt side of the inserted line break", () => {
  assert.equal(
    insertPromptLineBreakBeforePrompt("\x1b[32m$ \x1b[0m", "$ ", 5),
    "\r\n\x1b[32m$ \x1b[0m",
  );
});

test("does not insert for non-prompt output", () => {
  assert.equal(
    insertPromptLineBreakBeforePrompt("hello> ", "$ ", 0),
    "hello> ",
  );
});

test("does not insert for output chunks that only end with the cached prompt text", () => {
  assert.equal(
    insertPromptLineBreakBeforePrompt("total $ ", "$ ", 0),
    "total $ ",
  );
});

test("does not insert before an ambiguous prompt suffix inside output", () => {
  assert.equal(
    insertPromptLineBreakBeforePrompt("world$ ", "$ ", 5),
    "world$ ",
  );
});

test("does not insert before prompt-like output after a line break", () => {
  assert.equal(
    insertPromptLineBreakBeforePrompt("\r\nhello$ ", "$ ", 0),
    "\r\nhello$ ",
  );
});

test("inserts before a distinct root prompt in the same output chunk", () => {
  const prompt = "[root@iZwz9ftrhzy4b3hduolf6yZ ~]# ";

  assert.equal(
    insertPromptLineBreakBeforePrompt(`file tail${prompt}`, prompt, 0),
    `file tail\r\n${prompt}`,
  );
});

test("inserts before a distinct conda prompt in the same output chunk", () => {
  const prompt = "(base) rynn@aiserver:~$ ";

  assert.equal(
    insertPromptLineBreakBeforePrompt(`file tail${prompt}`, prompt, 0),
    `file tail\r\n${prompt}`,
  );
});

test("inserts before a distinct no-space root prompt in the same output chunk", () => {
  const prompt = " root@stwo:~#";

  assert.equal(
    insertPromptLineBreakBeforePrompt(`file tail${prompt}`, prompt, 0),
    `file tail\r\n${prompt}`,
  );
});

test("does not insert before an already separated distinct prompt", () => {
  const prompt = "(base) rynn@aiserver:~$ ";

  assert.equal(
    insertPromptLineBreakBeforePrompt(`file tail\r\n${prompt}`, prompt, 0),
    `file tail\r\n${prompt}`,
  );
});

test("does not refresh cached prompt from output that only ends with the prompt text", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "$ ";
  state.pendingCommand = true;

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("", 0) as never,
      "total $ ",
      state,
      true,
    ),
    "total $ ",
  );
  assert.equal(state.suppressNextPromptCache, true);

  syncPromptLineBreakState(createFakeTerm("total $ ") as never, state);

  assert.equal(state.lastPromptText, "$ ");
  assert.equal(state.pendingCommand, true);
  assert.equal(state.suppressNextPromptCache, false);
});

test("uses a preserved PTY chunk boundary to separate a short prompt", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "$ ";
  state.pendingCommand = true;

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("", 0) as never,
      "file tail$ ",
      state,
      true,
      ["file tail".length],
    ),
    "file tail\r\n$ ",
  );
  assert.equal(state.suppressNextPromptCache, false);
});

test("keeps waiting for the real prompt after an output suffix matches the prompt text", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "$ ";
  state.pendingCommand = true;

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("", 0) as never,
      "total $ ",
      state,
      true,
    ),
    "total $ ",
  );

  syncPromptLineBreakState(createFakeTerm("total $ ") as never, state);

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("total $ ", 8) as never,
      "$ ",
      state,
      true,
    ),
    "\r\n$ ",
  );
});

test("keeps waiting after prompt-like output on a fresh line", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "$ ";
  state.pendingCommand = true;

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("", 0) as never,
      "\r\nhello$ ",
      state,
      true,
    ),
    "\r\nhello$ ",
  );

  syncPromptLineBreakState(createFakeTerm("hello$ ") as never, state);

  assert.equal(state.lastPromptText, "$ ");
  assert.equal(state.pendingCommand, true);

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("hello$ ", 7) as never,
      "$ ",
      state,
      true,
    ),
    "\r\n$ ",
  );
});

test("prepares a same-chunk cat output break for a distinct prompt", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "(base) rynn@aiserver:~$ ";
  state.pendingCommand = true;

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      createFakeTerm("", 0) as never,
      "without trailing newline(base) rynn@aiserver:~$ ",
      state,
      true,
    ),
    "without trailing newline\r\n(base) rynn@aiserver:~$ ",
  );
  assert.equal(state.suppressNextPromptCache, false);
});

test("caches a no-space root prompt from typed command alignment", () => {
  const prompt = " root@stwo:~#";
  const command = "printf ok";
  const state = createPromptLineBreakState();

  markPromptLineBreakCommandPending(
    { current: state },
    createFakeTerm(`${prompt}${command}`) as never,
    command,
  );

  assert.equal(state.lastPromptText, prompt);
  assert.equal(state.pendingCommand, true);
});

test("caches a no-space root prompt when command echo lags", () => {
  const prompt = " root@stwo:~#";
  const command = "printf ok";
  const state = createPromptLineBreakState();

  markPromptLineBreakCommandPending(
    { current: state },
    createFakeTerm(`${prompt}${command.slice(0, -1)}`) as never,
    command,
  );

  assert.equal(state.lastPromptText, prompt);
  assert.equal(state.pendingCommand, true);
});

test("caches a no-space root prompt when command echo lags by a word", () => {
  const prompt = " root@stwo:~#";
  const command = "printf ok";
  const state = createPromptLineBreakState();

  markPromptLineBreakCommandPending(
    { current: state },
    createFakeTerm(`${prompt}printf `) as never,
    command,
  );

  assert.equal(state.lastPromptText, prompt);
  assert.equal(state.pendingCommand, true);
});

test("caches a no-space root prompt when a longer command echo lags by a word", () => {
  const prompt = "root@host:~#";
  const command = "git status";
  const state = createPromptLineBreakState();

  markPromptLineBreakCommandPending(
    { current: state },
    createFakeTerm(`${prompt}git `) as never,
    command,
  );

  assert.equal(state.lastPromptText, prompt);
  assert.equal(state.pendingCommand, true);
});

test("caches a no-space root prompt when command echo lags mid-word", () => {
  const prompt = "root@host:~#";
  const command = "git status";
  const state = createPromptLineBreakState();

  markPromptLineBreakCommandPending(
    { current: state },
    createFakeTerm(`${prompt}git st`) as never,
    command,
  );

  assert.equal(state.lastPromptText, prompt);
  assert.equal(state.pendingCommand, true);
});

test("caches a standard prompt when command echo lags near completion", () => {
  const state = createPromptLineBreakState();

  markPromptLineBreakCommandPending(
    { current: state },
    createFakeTerm("$ git statu") as never,
    "git status",
  );

  assert.equal(state.lastPromptText, "$ ");
  assert.equal(state.pendingCommand, true);
});

test("caches a standard prompt when command echo lags after a word boundary", () => {
  const cases = ["$ git ", "$ git st"];

  for (const lineText of cases) {
    const state = createPromptLineBreakState();

    markPromptLineBreakCommandPending(
      { current: state },
      createFakeTerm(lineText) as never,
      "git status",
    );

    assert.equal(state.lastPromptText, "$ ", lineText);
    assert.equal(state.pendingCommand, true, lineText);
  }
});

test("caches a standard prompt when short command echo lags by one character", () => {
  const cases = [
    { lineText: "$ l", command: "ls" },
    { lineText: "$ c", command: "cd" },
    { lineText: "prod-web> l", command: "ls", promptText: "prod-web> " },
    { lineText: "prod> l", command: "ls", promptText: "prod> " },
    { lineText: "prod.web> l", command: "ls", promptText: "prod.web> " },
    { lineText: "user@host:~$ l", command: "ls", promptText: "user@host:~$ " },
    { lineText: "[user@host ~]$ l", command: "ls", promptText: "[user@host ~]$ " },
    { lineText: "➜  netcatty $ l", command: "ls", promptText: "➜  netcatty $ " },
    { lineText: "➜  git l", command: "ls", promptText: "➜  git " },
    { lineText: "➜  git np", command: "npm", promptText: "➜  git " },
  ];

  for (const { lineText, command, promptText = "$ " } of cases) {
    const state = createPromptLineBreakState();

    markPromptLineBreakCommandPending(
      { current: state },
      createFakeTerm(lineText) as never,
      command,
    );

    assert.equal(state.lastPromptText, promptText, lineText);
    assert.equal(state.pendingCommand, true, lineText);
  }
});

test("caches a no-space root prompt when a short command echo lags by a word", () => {
  const prompt = "root@host:~#";
  const cases = [
    { echoedInput: "ls ", command: "ls -la" },
    { echoedInput: "cd ", command: "cd /tmp" },
  ];

  for (const { echoedInput, command } of cases) {
    const state = createPromptLineBreakState();

    markPromptLineBreakCommandPending(
      { current: state },
      createFakeTerm(`${prompt}${echoedInput}`) as never,
      command,
    );

    assert.equal(state.lastPromptText, prompt, command);
    assert.equal(state.pendingCommand, true, command);
  }
});

test("caches a no-space root prompt when a short command echo lags by one character", () => {
  const prompt = " root@stwo:~#";
  const cases = [
    { echoedInput: "l", command: "ls" },
    { echoedInput: "c", command: "cd" },
  ];

  for (const { echoedInput, command } of cases) {
    const state = createPromptLineBreakState();

    markPromptLineBreakCommandPending(
      { current: state },
      createFakeTerm(`${prompt}${echoedInput}`) as never,
      command,
    );

    assert.equal(state.lastPromptText, prompt, command);
    assert.equal(state.pendingCommand, true, command);
  }
});

test("does not cache a stale command as prompt text", () => {
  const state = createPromptLineBreakState();

  markPromptLineBreakCommandPending(
    { current: state },
    createFakeTerm("$ ls") as never,
    "sudo",
  );

  assert.equal(state.lastPromptText, "");
  assert.equal(state.pendingCommand, true);
});

test("does not cache common interactive program prompts", () => {
  const cases = [
    { lineText: "sftp> get file", command: "get file" },
    { lineText: "ftp> ls", command: "ls" },
    { lineText: "ghci> :t map", command: ":t map" },
    { lineText: "node> .help", command: ".help" },
    { lineText: "mongo> db.stats()", command: "db.stats()" },
    { lineText: "rs0:PRIMARY> db.stats()", command: "db.stats()" },
    { lineText: "test> const x = 1", command: "const x = 1" },
    { lineText: "test> await db.users.findOne()", command: "await db.users.findOne()" },
    { lineText: "rs0 [direct: primary] test> db.stats()", command: "db.stats()" },
    { lineText: "rs0 [direct: primary] reporting> db.stats()", command: "db.stats()" },
    { lineText: "rs0 primary reporting> exit", command: "exit" },
    { lineText: "irb(main):001> puts 1", command: "puts 1" },
    { lineText: "pry(main)> whereami", command: "whereami" },
    { lineText: "[1] pry(main)> whereami", command: "whereami" },
    { lineText: "SQL> select 1", command: "select 1" },
    { lineText: "cqlsh> select * from users", command: "select * from users" },
    { lineText: "hive> select 1", command: "select 1" },
    { lineText: "spark-sql> select 1", command: "select 1" },
    { lineText: "jshell> /help", command: "/help" },
    { lineText: "   ...> System.out.println(1)", command: "System.out.println(1)" },
    { lineText: "ksql> select 1", command: "select 1" },
    { lineText: "trino> select 1", command: "select 1" },
    { lineText: "trino:tpch> select 1", command: "select 1" },
    { lineText: "presto> show catalogs", command: "show catalogs" },
    { lineText: "presto:default> show tables", command: "show tables" },
    { lineText: "duckdb> select 1", command: "select 1" },
    { lineText: "lftp user@example.com:~> ls", command: "ls" },
    { lineText: "cqlsh:cycling> select * from cyclist", command: "select * from cyclist" },
    { lineText: "hive (default)> select 1", command: "select 1" },
    { lineText: "0: jdbc:hive2://localhost:10000/default> select 1", command: "select 1" },
    { lineText: "spark-sql (default)> select 1", command: "select 1" },
    { lineText: "test> db.stats()", command: "db.stats()" },
    { lineText: "test> db", command: "db" },
    { lineText: "test> const x = 1", command: "const x = 1" },
    { lineText: "test> await db.users.findOne()", command: "await db.users.findOne()" },
    { lineText: "rs0 [direct: primary] reporting> const x = 1", command: "const x = 1" },
    { lineText: "rs0 [direct: primary] reporting> await db.users.findOne()", command: "await db.users.findOne()" },
    { lineText: "Atlas a [primary] reporting> db.stats()", command: "db.stats()" },
    { lineText: "Atlas a [primary] reporting> await db.users.findOne()", command: "await db.users.findOne()" },
    { lineText: "rs0 primary test> db.stats()", command: "db.stats()" },
    { lineText: "test> rs.status()", command: "rs.status()" },
    { lineText: "test> print(1)", command: "print(1)" },
    { lineText: "test> 1 + 1", command: "1 + 1" },
    { lineText: "admin@localhost:27017> db.stats()", command: "db.stats()" },
  ];

  for (const { lineText, command } of cases) {
    const state = createPromptLineBreakState();

    markPromptLineBreakCommandPending(
      { current: state },
      createFakeTerm(lineText) as never,
      command,
    );

    assert.equal(state.lastPromptText, "", lineText);
    assert.equal(state.pendingCommand, true, lineText);
  }
});

test("does not cache wrapped common interactive program prompts", () => {
  const cases = [
    { rows: ["sftp> get very-long-", "remote-file"], command: "get very-long-remote-file" },
    { rows: ["node> console.", "log('ok')"], command: "console.log('ok')" },
    { rows: ["mongo> db.", "stats()"], command: "db.stats()" },
    { rows: ["cqlsh> select *", " from users"], command: "select * from users" },
    { rows: ["jshell> System.out.", "println(1)"], command: "System.out.println(1)" },
    { rows: ["   ...> System.out.", "println(1)"], command: "System.out.println(1)" },
    { rows: ["trino> select", " 1"], command: "select 1" },
    { rows: ["trino:tpch> select", " 1"], command: "select 1" },
    { rows: ["duckdb> select", " 1"], command: "select 1" },
    { rows: ["cqlsh:cycling> select *", " from cyclist"], command: "select * from cyclist" },
    { rows: ["hive (default)> select", " 1"], command: "select 1" },
    { rows: ["0: jdbc:hive2://localhost:10000/default> select", " 1"], command: "select 1" },
    { rows: ["test> db.", "stats()"], command: "db.stats()" },
    { rows: ["test> d", "b"], command: "db" },
    { rows: ["rs0:PRIMARY> db.", "stats()"], command: "db.stats()" },
    { rows: ["rs0 [direct: primary] test> db.", "stats()"], command: "db.stats()" },
    { rows: ["rs0 [direct: primary]", " test> db.stats()"], command: "db.stats()" },
    { rows: ["rs0 [direct: primary]", " reporting> db.stats()"], command: "db.stats()" },
    { rows: ["rs0 [direct: primary]", " reporting> const x = 1"], command: "const x = 1" },
    { rows: ["Atlas a [primary]", " reporting> db.stats()"], command: "db.stats()" },
    { rows: ["rs0 primary test> db.", "stats()"], command: "db.stats()" },
    { rows: ["test> print", "(1)"], command: "print(1)" },
    { rows: ["test> 1 ", "+ 1"], command: "1 + 1" },
    { rows: ["admin@localhost:27017> db.", "stats()"], command: "db.stats()" },
  ];

  for (const { rows, command } of cases) {
    const state = createPromptLineBreakState();

    markPromptLineBreakCommandPending(
      { current: state },
      createWrappedFakeTerm(rows, 1, rows[1].length, 20) as never,
      command,
    );

    assert.equal(state.lastPromptText, "", rows[0]);
    assert.equal(state.pendingCommand, true, rows[0]);
  }
});

test("caches wrapped non-Mongo-looking default-name greater-than prompts", () => {
  const cases = [
    { rows: ["test> hel", "p"], command: "help", promptText: "test> " },
    { rows: ["test> show ", "dbs"], command: "show dbs", promptText: "test> " },
    { rows: ["admin> ex", "it"], command: "exit", promptText: "admin> " },
    { rows: ["local> dep", "loy"], command: "deploy", promptText: "local> " },
  ];

  for (const { rows, command, promptText } of cases) {
    const state = createPromptLineBreakState();

    markPromptLineBreakCommandPending(
      { current: state },
      createWrappedFakeTerm(rows, 1, rows[1].length, 20) as never,
      command,
    );

    assert.equal(state.lastPromptText, promptText, rows[0]);
    assert.equal(state.pendingCommand, true, rows[0]);
  }
});

test("does not cache a live command suffix as prompt text", () => {
  const state = createPromptLineBreakState();

  markPromptLineBreakCommandPending(
    { current: state },
    createFakeTerm("$ echo sudo") as never,
    "sudo",
  );

  assert.equal(state.lastPromptText, "");
  assert.equal(state.pendingCommand, true);
});

test("does not cache host prompt command symbols as prompt text", () => {
  const prompt = "user@host:~$ ";
  const cases = [
    `${prompt}echo # sudo`,
    `${prompt}printf % sudo`,
    `${prompt}echo $ sudo`,
  ];

  for (const lineText of cases) {
    const state = createPromptLineBreakState();

    markPromptLineBreakCommandPending(
      { current: state },
      createFakeTerm(lineText) as never,
      "sudo",
    );

    assert.equal(state.lastPromptText, "", lineText);
    assert.equal(state.pendingCommand, true, lineText);
  }
});

test("does not cache a themed prompt live command suffix as prompt text", () => {
  for (const lineText of [
    "➜  ~ echo sudo",
    "➜ echo sudo",
    "➜ make sudo",
    "➜ docker sudo",
    "➜ ./script sudo",
    "➜  ./script sudo",
    "➜  ~ echo # sudo",
  ]) {
    const state = createPromptLineBreakState();

    markPromptLineBreakCommandPending(
      { current: state },
      createFakeTerm(lineText) as never,
      "sudo",
    );

    assert.equal(state.lastPromptText, "", lineText);
    assert.equal(state.pendingCommand, true, lineText);
  }
});

test("caches themed prompt decorations from typed command alignment", () => {
  const cases = [
    { lineText: "➜ ~/repo do", command: "do", promptText: "➜ ~/repo " },
    {
      lineText: "➜  netcatty git:(main) ✗ ls",
      command: "ls",
      promptText: "➜  netcatty git:(main) ✗ ",
    },
    {
      lineText: "➜  netcatty git:(main) ✗ + ls",
      command: "ls",
      promptText: "➜  netcatty git:(main) ✗ + ",
    },
    { lineText: "➜  netcatty ✗ $ ls", command: "ls", promptText: "➜  netcatty ✗ $ " },
    { lineText: "➜  netcatty $ ls", command: "ls", promptText: "➜  netcatty $ " },
  ];

  for (const { lineText, command, promptText } of cases) {
    const state = createPromptLineBreakState();

    markPromptLineBreakCommandPending(
      { current: state },
      createFakeTerm(lineText) as never,
      command,
    );

    assert.equal(state.lastPromptText, promptText, lineText);
    assert.equal(state.pendingCommand, true, lineText);
  }
});

test("caches themed prompt decorations when command echo lags", () => {
  const cases = [
    { lineText: "➜  ~ git ", command: "git status", promptText: "➜  ~ " },
    { lineText: "➜  ~ git st", command: "git status", promptText: "➜  ~ " },
    {
      lineText: "➜  netcatty git:(main) ✗ git ",
      command: "git status",
      promptText: "➜  netcatty git:(main) ✗ ",
    },
    {
      lineText: "➜  netcatty git:(main) ✗ git st",
      command: "git status",
      promptText: "➜  netcatty git:(main) ✗ ",
    },
  ];

  for (const { lineText, command, promptText } of cases) {
    const state = createPromptLineBreakState();

    markPromptLineBreakCommandPending(
      { current: state },
      createFakeTerm(lineText) as never,
      command,
    );

    assert.equal(state.lastPromptText, promptText, lineText);
    assert.equal(state.pendingCommand, true, lineText);
  }
});

test("caches themed bare directory prompts for direct sends before command echo", () => {
  const cases = [
    { lineText: "➜  netcatty ", command: "ls", promptText: "➜  netcatty " },
    { lineText: "➜  git ", command: "npm", promptText: "➜  git " },
    { lineText: "➜  git ", command: "git status", promptText: "➜  git " },
    { lineText: "➜  make ", command: "sudo", promptText: "➜  make " },
    { lineText: "➜  make ", command: "make build", promptText: "➜  make " },
    { lineText: "➜  node ", command: "yarn", promptText: "➜  node " },
  ];

  for (const { lineText, command, promptText } of cases) {
    const state = createPromptLineBreakState();

    markPromptLineBreakCommandPending(
      { current: state },
      createFakeTerm(lineText) as never,
      command,
    );

    assert.equal(state.lastPromptText, promptText, lineText);
    assert.equal(state.pendingCommand, true, lineText);
  }
});

test("does not cache interactive prompts for direct sends before command echo", () => {
  const cases = [
    { lineText: "test> ", command: "const x = 1" },
    { lineText: "test> ", command: "await db.users.findOne()" },
    { lineText: "test> ", command: "db" },
    { lineText: "rs0 [direct: primary] reporting> ", command: "const x = 1" },
    { lineText: "rs0 [direct: primary] reporting> ", command: "await db.users.findOne()" },
    { lineText: "rs0 [direct: primary] reporting> ", command: "db.stats()" },
    { lineText: "Atlas a [primary] reporting> ", command: "db.stats()" },
  ];

  for (const { lineText, command } of cases) {
    const state = createPromptLineBreakState();

    markPromptLineBreakCommandPending(
      { current: state },
      createFakeTerm(lineText) as never,
      command,
    );

    assert.equal(state.lastPromptText, "", lineText);
    assert.equal(state.pendingCommand, true, lineText);
  }
});

test("clears an old cached prompt when a direct send is interactive", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "rs0 [direct: primary] reporting> ";

  markPromptLineBreakCommandPending(
    { current: state },
    createFakeTerm("rs0 [direct: primary] reporting> ") as never,
    "db.stats()",
  );

  assert.equal(state.lastPromptText, "");
  assert.equal(state.pendingCommand, true);
});

test("caches host-style greater-than prompts for direct sends before command echo", () => {
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
    const state = createPromptLineBreakState();

    markPromptLineBreakCommandPending(
      { current: state },
      createFakeTerm(lineText) as never,
      command,
    );

    assert.equal(state.lastPromptText, lineText, lineText);
    assert.equal(state.pendingCommand, true, lineText);
  }
});

test("does not cache a live path suffix as prompt text", () => {
  for (const lineText of ["$ cd ~/sudo", "$ cat > sudo", "$ echo path#sudo"]) {
    const state = createPromptLineBreakState();

    markPromptLineBreakCommandPending(
      { current: state },
      createFakeTerm(lineText) as never,
      "sudo",
    );

    assert.equal(state.lastPromptText, "", lineText);
    assert.equal(state.pendingCommand, true, lineText);
  }
});

test("does not cache a stale command from a standard prompt echo prefix", () => {
  for (const lineText of ["$ s", "$ su", "$ sud"]) {
    const state = createPromptLineBreakState();

    markPromptLineBreakCommandPending(
      { current: state },
      createFakeTerm(lineText) as never,
      "sudo",
    );

    assert.equal(state.lastPromptText, "", lineText);
    assert.equal(state.pendingCommand, true, lineText);
  }
});

test("does not cache partial stale commands after a no-space prompt", () => {
  const prompt = " root@stwo:~#";
  for (const lineText of [`${prompt}s`, `${prompt}sud`]) {
    const state = createPromptLineBreakState();

    markPromptLineBreakCommandPending(
      { current: state },
      createFakeTerm(lineText) as never,
      "sudo",
    );

    assert.equal(state.lastPromptText, "", lineText);
    assert.equal(state.pendingCommand, true, lineText);
  }
});

test("does not cache stale command suffixes after a no-space prompt", () => {
  const prompt = " root@stwo:~#";
  const cases = [
    `${prompt}cat > sudo`,
    `${prompt}echo # sudo`,
    `${prompt}echo $ sudo`,
    `${prompt}printf % sudo`,
    `${prompt}echo path#sudo`,
    `${prompt}> sudo`,
    `${prompt}# sudo`,
    `${prompt}% sudo`,
    `${prompt}$ sudo`,
  ];
  cases.push("root#echo $ sudo", "root@host:~#make $ sudo");

  for (const lineText of cases) {
    const state = createPromptLineBreakState();

    markPromptLineBreakCommandPending(
      { current: state },
      createFakeTerm(lineText) as never,
      "sudo",
    );

    assert.equal(state.lastPromptText, "", lineText);
    assert.equal(state.pendingCommand, true, lineText);
  }
});

test("syncs prompts that contain prompt-like symbols", () => {
  const prompts = [
    "user@host ~/foo# bar $ ",
    "user@host ~/foo# git $ ",
    "user@host ~/foo#git $ ",
    "root@host ~/foo# bar # ",
    "root@host ~/foo#bar # ",
    "fish@host ~/foo# bar % ",
    "fish@host ~/foo%bar % ",
    "user@host:~/foo# bar $ ",
    "user@host ~/repo # $ ",
    "➜  ~ $ ",
    "user@host ~/foo% bar $ ",
    "user@host ~/foo> bar $ ",
    "user@host ~/foo# bar> ",
    "user@host ~/foo# bar› ",
    "user@host ~/foo#bar> ",
  ];

  for (const prompt of prompts) {
    const state = createPromptLineBreakState();

    syncPromptLineBreakState(createFakeTerm(prompt) as never, state);

    assert.equal(state.lastPromptText, prompt, prompt);
    assert.equal(state.pendingCommand, false, prompt);
  }
});

test("syncs a no-space root prompt without xterm row padding", () => {
  const prompt = " root@stwo:~#";
  const state = createPromptLineBreakState();

  syncPromptLineBreakState(createFakeTerm(`${prompt}          `, prompt.length) as never, state);

  assert.equal(state.lastPromptText, prompt);
  assert.equal(state.pendingCommand, false);
});

test("refreshes cached prompt when a changed prompt arrives after a line break in the same chunk", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "old$ ";
  state.pendingCommand = true;
  const termBeforeWrite = createFakeTerm("old$ cd /tmp", 12);

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      termBeforeWrite as never,
      "\r\nnew$ ",
      state,
      true,
    ),
    "\r\nnew$ ",
  );
  assert.equal(state.suppressNextPromptCache, false);

  syncPromptLineBreakState(createFakeTerm("new$ ") as never, state);

  assert.equal(state.lastPromptText, "new$ ");
  assert.equal(state.pendingCommand, false);
});

test("caches the first valid prompt even when a command is already pending", () => {
  const state = createPromptLineBreakState();
  state.pendingCommand = true;

  syncPromptLineBreakState(createFakeTerm("$ ") as never, state);

  assert.equal(state.lastPromptText, "$ ");
  assert.equal(state.pendingCommand, false);
  assert.equal(state.suppressNextPromptCache, false);
});

test("does not refresh cached prompt from an unchanged mid-line write without a line reset", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "old$ ";
  state.pendingCommand = true;
  const termBeforeWrite = createFakeTerm("old$ run", 8);

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      termBeforeWrite as never,
      "outputnew$ ",
      state,
      true,
    ),
    "outputnew$ ",
  );
  assert.equal(state.suppressNextPromptCache, true);

  syncPromptLineBreakState(createFakeTerm("outputnew$ ") as never, state);

  assert.equal(state.lastPromptText, "old$ ");
  assert.equal(state.pendingCommand, true);
  assert.equal(state.suppressNextPromptCache, false);
});

test("does not insert a blank line after a full-width prefix that already wrapped", () => {
  const state = createPromptLineBreakState();
  state.lastPromptText = "$ ";
  state.pendingCommand = true;
  const cols = 10;
  const fullWidth = "x".repeat(cols);
  const term = createWrappedFakeTerm([fullWidth], 0, 0, cols);

  assert.equal(
    prepareTerminalDataForPromptLineBreak(
      term as never,
      `${fullWidth}$ `,
      state,
      true,
      [fullWidth.length],
    ),
    `${fullWidth}$ `,
  );
});

test("finds prompt starts on the display string after identity transforms", () => {
  const prompt = "$ ";
  const data = `file tail${prompt}`;
  const starts = findTerminalPromptSourceChunkVisibleStarts(
    data,
    prompt,
    ["file tail".length],
  );
  assert.deepEqual(starts, ["file tail".length]);
});
