import test from "node:test";
import assert from "node:assert/strict";

import {
  createPromptLineBreakState,
  insertPromptLineBreakBeforePrompt,
  markPromptLineBreakCommandPending,
  prepareTerminalDataForPromptLineBreak,
  syncPromptLineBreakState,
} from "./promptLineBreak";

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
