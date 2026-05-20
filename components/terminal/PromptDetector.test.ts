import test from "node:test";
import assert from "node:assert/strict";

import { getAlignedPrompt } from "./autocomplete/promptDetector.ts";
import { getCommandToRecordOnEnter } from "./autocomplete/useTerminalAutocomplete.ts";

function createFakeTerm(lineText: string, cursorX: number) {
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

test("keeps raw input when a standard shell prompt echo is still behind", () => {
  const term = createFakeTerm("$ do", 4);

  const result = getAlignedPrompt(term as never, "doc", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, "$ ");
  assert.equal(result.prompt.userInput, "do");
  assert.equal(result.prompt.cursorOffset, 2);
  assert.equal(result.alignedTyped, null);
});

test("still trims prompt decorations out of the detected input", () => {
  const term = createFakeTerm("➜  ~ do", 7);

  const result = getAlignedPrompt(term as never, "do", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, "➜  ~ ");
  assert.equal(result.prompt.userInput, "do");
  assert.equal(result.prompt.cursorOffset, 2);
  assert.equal(result.alignedTyped, "do");
});

test("detects oh-my-posh Nerd Font chevron (U+F105) prompt terminator", () => {
  // Real-world PS1 captured from oh-my-posh themed bash on a server:
  //   "<U+F31B> root@oracle ~ <U+F105> " then user input
  const term = createFakeTerm(" root@oracle ~  ls", 21);

  const result = getAlignedPrompt(term as never, "ls", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, " root@oracle ~  ");
  assert.equal(result.prompt.userInput, "ls");
});

test("detects Powerline right-arrow (U+E0B0) prompt terminator", () => {
  // oh-my-posh agnoster-style: colored block ending with U+E0B0 + space
  const term = createFakeTerm(" root  ~  git", 16);

  const result = getAlignedPrompt(term as never, "git", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.userInput, "git");
  assert.ok(result.prompt.promptText.endsWith(" "));
});

test("PUA char without trailing space is not a prompt boundary", () => {
  // A bare PUA glyph mid-token (e.g. paste artifact) should not trigger detection.
  const term = createFakeTerm("echo foo", 13);

  const result = getAlignedPrompt(term as never, "", true);

  assert.equal(result.prompt.isAtPrompt, false);
});

test("keeps typed command intact when command text contains Powerline glyphs", () => {
  const typedInput = "echo  foo";
  const lineText = `$ ${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, "$ ");
  assert.equal(result.prompt.userInput, typedInput);
  assert.equal(result.alignedTyped, typedInput);
});

test("does not treat a mid-line dollar as a prompt boundary", () => {
  const lineText = "$ echo $HOME";
  const term = createFakeTerm(lineText, "$ echo $".length);

  const result = getAlignedPrompt(term as never, "", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, "$ ");
  assert.equal(result.prompt.userInput, "echo $");
  assert.equal(result.prompt.cursorOffset, "echo $".length);
});

test("does not treat a mid-line redirection as a prompt boundary", () => {
  const lineText = "$ cat >file";
  const term = createFakeTerm(lineText, "$ cat >".length);

  const result = getAlignedPrompt(term as never, "", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, "$ ");
  assert.equal(result.prompt.userInput, "cat >");
  assert.equal(result.prompt.cursorOffset, "cat >".length);
});

test("does not treat a spaced redirection as a prompt boundary", () => {
  const lineText = "$ cat > file";
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, "", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, "$ ");
  assert.equal(result.prompt.userInput, "cat > file");
});

test("does not treat common interactive program prompts as shell prompts", () => {
  const cases = [
    { lineText: "sftp> get file", typedInput: "get file" },
    { lineText: "ftp> ls", typedInput: "ls" },
    { lineText: "ghci> :t map", typedInput: ":t map" },
    { lineText: "node> .help", typedInput: ".help" },
    { lineText: "mongo> db.stats()", typedInput: "db.stats()" },
    { lineText: "rs0:PRIMARY> db.stats()", typedInput: "db.stats()" },
    { lineText: "rs0 [direct: primary] test> db.stats()", typedInput: "db.stats()" },
    { lineText: "rs0 [direct: primary] reporting> db.stats()", typedInput: "db.stats()" },
    { lineText: "rs0 [direct: primary] reporting> const x = 1", typedInput: "const x = 1" },
    { lineText: "rs0 [direct: primary] reporting> await db.users.findOne()", typedInput: "await db.users.findOne()" },
    { lineText: "Atlas a [primary] reporting> db.stats()", typedInput: "db.stats()" },
    { lineText: "Atlas a [primary] reporting> await db.users.findOne()", typedInput: "await db.users.findOne()" },
    { lineText: "rs0 primary reporting> exit", typedInput: "exit" },
    { lineText: "irb(main):001> puts 1", typedInput: "puts 1" },
    { lineText: "pry(main)> whereami", typedInput: "whereami" },
    { lineText: "[1] pry(main)> whereami", typedInput: "whereami" },
    { lineText: "SQL> select 1", typedInput: "select 1" },
    { lineText: "cqlsh> select * from users", typedInput: "select * from users" },
    { lineText: "hive> select 1", typedInput: "select 1" },
    { lineText: "spark-sql> select 1", typedInput: "select 1" },
    { lineText: "jshell> /help", typedInput: "/help" },
    { lineText: "   ...> System.out.println(1)", typedInput: "System.out.println(1)" },
    { lineText: "ksql> select 1", typedInput: "select 1" },
    { lineText: "trino> select 1", typedInput: "select 1" },
    { lineText: "trino:tpch> select 1", typedInput: "select 1" },
    { lineText: "presto> show catalogs", typedInput: "show catalogs" },
    { lineText: "presto:default> show tables", typedInput: "show tables" },
    { lineText: "duckdb> select 1", typedInput: "select 1" },
    { lineText: "lftp user@example.com:~> ls", typedInput: "ls" },
    { lineText: "cqlsh:cycling> select * from cyclist", typedInput: "select * from cyclist" },
    { lineText: "hive (default)> select 1", typedInput: "select 1" },
    { lineText: "0: jdbc:hive2://localhost:10000/default> select 1", typedInput: "select 1" },
    { lineText: "spark-sql (default)> select 1", typedInput: "select 1" },
    { lineText: "test> db.stats()", typedInput: "db.stats()" },
    { lineText: "test> const x = 1", typedInput: "const x = 1" },
    { lineText: "test> await db.users.findOne()", typedInput: "await db.users.findOne()" },
    { lineText: "test> db", typedInput: "db" },
    { lineText: "rs0 primary test> db.stats()", typedInput: "db.stats()" },
    { lineText: "test> rs.status()", typedInput: "rs.status()" },
    { lineText: "test> print(1)", typedInput: "print(1)" },
    { lineText: "test> 1 + 1", typedInput: "1 + 1" },
    { lineText: "admin@localhost:27017> db.stats()", typedInput: "db.stats()" },
  ];

  for (const { lineText, typedInput } of cases) {
    const result = getAlignedPrompt(
      createFakeTerm(lineText, lineText.length) as never,
      typedInput,
      true,
    );

    assert.equal(result.prompt.isAtPrompt, false, lineText);
    assert.equal(result.alignedTyped, null, lineText);
  }
});

test("does not treat wrapped interactive program prompts as shell prompts", () => {
  const cases = [
    { rows: ["sftp> get very-long-", "remote-file"], typedInput: "get very-long-remote-file" },
    { rows: ["node> console.", "log('ok')"], typedInput: "console.log('ok')" },
    { rows: ["mongo> db.", "stats()"], typedInput: "db.stats()" },
    { rows: ["cqlsh> select *", " from users"], typedInput: "select * from users" },
    { rows: ["jshell> System.out.", "println(1)"], typedInput: "System.out.println(1)" },
    { rows: ["   ...> System.out.", "println(1)"], typedInput: "System.out.println(1)" },
    { rows: ["trino> select", " 1"], typedInput: "select 1" },
    { rows: ["trino:tpch> select", " 1"], typedInput: "select 1" },
    { rows: ["duckdb> select", " 1"], typedInput: "select 1" },
    { rows: ["cqlsh:cycling> select *", " from cyclist"], typedInput: "select * from cyclist" },
    { rows: ["hive (default)> select", " 1"], typedInput: "select 1" },
    { rows: ["0: jdbc:hive2://localhost:10000/default> select", " 1"], typedInput: "select 1" },
    { rows: ["test> db.", "stats()"], typedInput: "db.stats()" },
    { rows: ["test> d", "b"], typedInput: "db" },
    { rows: ["rs0:PRIMARY> db.", "stats()"], typedInput: "db.stats()" },
    { rows: ["rs0 [direct: primary] test> db.", "stats()"], typedInput: "db.stats()" },
    { rows: ["rs0 [direct: primary]", " test> db.stats()"], typedInput: "db.stats()" },
    { rows: ["rs0 [direct: primary]", " reporting> db.stats()"], typedInput: "db.stats()" },
    { rows: ["rs0 [direct: primary]", " reporting> const x = 1"], typedInput: "const x = 1" },
    { rows: ["Atlas a [primary]", " reporting> db.stats()"], typedInput: "db.stats()" },
    { rows: ["rs0 primary test> db.", "stats()"], typedInput: "db.stats()" },
    { rows: ["test> print", "(1)"], typedInput: "print(1)" },
    { rows: ["test> 1 ", "+ 1"], typedInput: "1 + 1" },
    { rows: ["admin@localhost:27017> db.", "stats()"], typedInput: "db.stats()" },
  ];

  for (const { rows, typedInput } of cases) {
    const result = getAlignedPrompt(
      createWrappedFakeTerm(rows, 1, rows[1].length, 20) as never,
      typedInput,
      true,
    );

    assert.equal(result.prompt.isAtPrompt, false, rows[0]);
    assert.equal(result.alignedTyped, null, rows[0]);
  }
});

test("keeps non-Mongo-looking default-name greater-than prompts usable", () => {
  const prompts = ["test> ", "admin> ", "local> ", "config> "];
  const commands = ["deploy", "exit", "help", "show dbs"];

  for (const prompt of prompts) {
    for (const typedInput of commands) {
      const lineText = `${prompt}${typedInput}`;
      const result = getAlignedPrompt(
        createFakeTerm(lineText, lineText.length) as never,
        typedInput,
        true,
      );

      assert.equal(result.prompt.isAtPrompt, true, lineText);
      assert.equal(result.prompt.promptText, prompt, lineText);
      assert.equal(result.prompt.userInput, typedInput, lineText);
      assert.equal(result.alignedTyped, typedInput, lineText);
      assert.equal(
        getCommandToRecordOnEnter(result.prompt, result.alignedTyped, typedInput, true),
        typedInput,
        lineText,
      );
    }
  }
});

test("keeps wrapped non-Mongo-looking default-name greater-than prompts usable", () => {
  const cases = [
    { rows: ["test> hel", "p"], typedInput: "help", promptText: "test> " },
    { rows: ["test> show ", "dbs"], typedInput: "show dbs", promptText: "test> " },
    { rows: ["admin> ex", "it"], typedInput: "exit", promptText: "admin> " },
    { rows: ["local> dep", "loy"], typedInput: "deploy", promptText: "local> " },
  ];

  for (const { rows, typedInput, promptText } of cases) {
    const result = getAlignedPrompt(
      createWrappedFakeTerm(rows, 1, rows[1].length, 20) as never,
      typedInput,
      true,
    );

    assert.equal(result.prompt.isAtPrompt, true, rows[0]);
    assert.equal(result.prompt.promptText, promptText, rows[0]);
    assert.equal(result.prompt.userInput, typedInput, rows[0]);
    assert.equal(result.alignedTyped, typedInput, rows[0]);
    assert.equal(
      getCommandToRecordOnEnter(result.prompt, result.alignedTyped, typedInput, true),
      typedInput,
      rows[0],
    );
  }
});

test("keeps host-style greater-than prompts usable", () => {
  const prompts = [
    "prod-web> ",
    "prod> ",
    "prod.web> ",
    "server> ",
    "staging> ",
    "webdb> ",
    "prod.db> ",
  ];
  const commands = [
    "deploy",
    "exit",
    "show dbs",
    "use app",
    "it",
    "help",
    "print(1)",
    "db.stats()",
  ];

  for (const prompt of prompts) {
    for (const typedInput of commands) {
      const lineText = `${prompt}${typedInput}`;
      const result = getAlignedPrompt(
        createFakeTerm(lineText, lineText.length) as never,
        typedInput,
        true,
      );

      assert.equal(result.prompt.isAtPrompt, true, lineText);
      assert.equal(result.prompt.promptText, prompt, lineText);
      assert.equal(result.prompt.userInput, typedInput, lineText);
      assert.equal(result.alignedTyped, typedInput, lineText);
    }
  }
});

test("keeps strong bare Mongo prompt signals out of shell prompts", () => {
  const cases = [
    { lineText: "test> db.stats()", typedInput: "db.stats()" },
    { lineText: "test> db", typedInput: "db" },
    { lineText: "test> const x = 1", typedInput: "const x = 1" },
    { lineText: "test> await db.users.findOne()", typedInput: "await db.users.findOne()" },
    { lineText: "test> print(1)", typedInput: "print(1)" },
    { lineText: "test> 1 + 1", typedInput: "1 + 1" },
  ];

  for (const { lineText, typedInput } of cases) {
    const result = getAlignedPrompt(
      createFakeTerm(lineText, lineText.length) as never,
      typedInput,
      true,
    );

    assert.equal(result.prompt.isAtPrompt, false, lineText);
    assert.equal(result.alignedTyped, null, lineText);
  }
});

test("does not align stale typed input after themed prompt command suffixes", () => {
  const cases = [
    "➜  ~ echo sudo",
    "➜ echo sudo",
    "➜ make sudo",
    "➜ docker sudo",
    "➜ ./script sudo",
    "➜  ./script sudo",
    "➜  ~ echo # sudo",
  ];

  for (const lineText of cases) {
    const result = getAlignedPrompt(createFakeTerm(lineText, lineText.length) as never, "sudo", true);

    assert.equal(result.prompt.isAtPrompt, true, lineText);
    assert.equal(result.prompt.promptText, "➜ ", lineText);
    assert.equal(result.prompt.userInput, lineText.slice("➜ ".length), lineText);
    assert.equal(result.alignedTyped, null, lineText);
  }
});

test("aligns themed prompt decorations when command echo lags", () => {
  const typedInput = "git status";
  const cases = [
    { lineText: "➜  ~ git ", promptText: "➜  ~ " },
    { lineText: "➜  ~ git st", promptText: "➜  ~ " },
    {
      lineText: "➜  netcatty git:(main) ✗ git ",
      promptText: "➜  netcatty git:(main) ✗ ",
    },
    {
      lineText: "➜  netcatty git:(main) ✗ git st",
      promptText: "➜  netcatty git:(main) ✗ ",
    },
  ];

  for (const { lineText, promptText } of cases) {
    const result = getAlignedPrompt(
      createFakeTerm(lineText, lineText.length) as never,
      typedInput,
      true,
    );

    assert.equal(result.prompt.isAtPrompt, true, lineText);
    assert.equal(result.prompt.promptText, promptText, lineText);
    assert.equal(result.prompt.userInput, typedInput, lineText);
    assert.equal(result.alignedTyped, typedInput, lineText);
    assert.equal(
      getCommandToRecordOnEnter(result.prompt, result.alignedTyped, typedInput, true),
      typedInput,
      lineText,
    );
  }
});

test("trims single-space themed prompt decorations out of the detected input", () => {
  const cases = [
    { lineText: "➜ ~/repo do", typedInput: "do", promptText: "➜ ~/repo " },
    {
      lineText: "➜  netcatty git:(main) ✗ ls",
      typedInput: "ls",
      promptText: "➜  netcatty git:(main) ✗ ",
    },
    {
      lineText: "➜  netcatty git:(main) ✗ + ls",
      typedInput: "ls",
      promptText: "➜  netcatty git:(main) ✗ + ",
    },
    { lineText: "➜  netcatty ✗ $ ls", typedInput: "ls", promptText: "➜  netcatty ✗ $ " },
    { lineText: "➜  netcatty $ ls", typedInput: "ls", promptText: "➜  netcatty $ " },
  ];

  for (const { lineText, typedInput, promptText } of cases) {
    const term = createFakeTerm(lineText, lineText.length);

    const result = getAlignedPrompt(term as never, typedInput, true);

    assert.equal(result.prompt.isAtPrompt, true, lineText);
    assert.equal(result.prompt.promptText, promptText, lineText);
    assert.equal(result.prompt.userInput, typedInput, lineText);
    assert.equal(result.alignedTyped, typedInput, lineText);
  }
});

test("does not treat later shell symbols followed by spaces as prompt boundaries", () => {
  const cases = [
    "$ echo # comment",
    "$ printf % value",
    "$ echo $ value",
  ];

  for (const lineText of cases) {
    const result = getAlignedPrompt(createFakeTerm(lineText, lineText.length) as never, "", true);

    assert.equal(result.prompt.isAtPrompt, true, lineText);
    assert.equal(result.prompt.promptText, "$ ", lineText);
    assert.equal(result.prompt.userInput, lineText.slice(2), lineText);
  }
});

test("does not treat command-leading shell symbols as prompt boundaries", () => {
  const cases = [
    "$ # comment",
    "$ > file",
    "$ % value",
    "$ $ value",
    "root@host:~# foo $ value",
  ];

  for (const lineText of cases) {
    const result = getAlignedPrompt(createFakeTerm(lineText, lineText.length) as never, "", false);

    assert.equal(result.prompt.isAtPrompt, true, lineText);
    const expectedPrompt = lineText.startsWith("root@host:~#") ? "root@host:~# " : "$ ";
    assert.equal(result.prompt.promptText, expectedPrompt, lineText);
    assert.equal(result.prompt.userInput, lineText.slice(expectedPrompt.length), lineText);
    assert.equal(result.alignedTyped, null, lineText);
  }
});

test("keeps prompt symbols that are part of the prompt text", () => {
  const prompts = [
    "user@host ~/foo#bar $ ",
    "user@host ~/foo# bar $ ",
    "user@host:~/foo# bar $ ",
    "user@host ~/foo% bar $ ",
    "user@host ~/foo> bar $ ",
  ];
  const typedInput = "ls";

  for (const prompt of prompts) {
    const term = createFakeTerm(`${prompt}${typedInput}`, prompt.length + typedInput.length);
    const result = getAlignedPrompt(term as never, typedInput, true);

    assert.equal(result.prompt.isAtPrompt, true, prompt);
    assert.equal(result.prompt.promptText, prompt, prompt);
    assert.equal(result.prompt.userInput, typedInput, prompt);
    assert.equal(result.alignedTyped, typedInput, prompt);
  }
});

test("keeps prompt symbols in prompt text without typed-buffer alignment", () => {
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
    const lineText = `${prompt}ls`;
    const result = getAlignedPrompt(createFakeTerm(lineText, lineText.length) as never, "", false);

    assert.equal(result.prompt.isAtPrompt, true, prompt);
    assert.equal(result.prompt.promptText, prompt, prompt);
    assert.equal(result.prompt.userInput, "ls", prompt);
    assert.equal(result.alignedTyped, null, prompt);
  }
});

test("prefers standard prompt terminator over later Powerline glyphs", () => {
  const lineText = "$ echo  foo";
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, "", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, "$ ");
  assert.equal(result.prompt.userInput, "echo  foo");
});

test("ignores xterm row padding after a no-space root prompt", () => {
  const prompt = " root@stwo:~#";
  const term = createFakeTerm(`${prompt}          `, prompt.length);

  const result = getAlignedPrompt(term as never, "", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, prompt);
  assert.equal(result.prompt.userInput, "");
});

test("aligns typed input after a no-space root prompt", () => {
  const prompt = " root@stwo:~#";
  const typedInput = "printf ok";
  const lineText = `${prompt}${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, prompt);
  assert.equal(result.prompt.userInput, typedInput);
  assert.equal(result.alignedTyped, typedInput);
});

test("aligns typed input after a no-space root prompt when shell echo lags", () => {
  const prompt = " root@stwo:~#";
  const typedInput = "printf ok";
  const echoedInput = typedInput.slice(0, -1);
  const lineText = `${prompt}${echoedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, prompt);
  assert.equal(result.prompt.userInput, typedInput);
  assert.equal(result.alignedTyped, typedInput);
});

test("aligns typed input after a no-space root prompt when shell echo lags by a word", () => {
  const prompt = " root@stwo:~#";
  const typedInput = "printf ok";
  const echoedInput = "printf ";
  const lineText = `${prompt}${echoedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, prompt);
  assert.equal(result.prompt.userInput, typedInput);
  assert.equal(result.alignedTyped, typedInput);
});

test("aligns typed input after a no-space root prompt when a longer command echo lags by a word", () => {
  const prompt = "root@host:~#";
  const typedInput = "git status";
  const echoedInput = "git ";
  const lineText = `${prompt}${echoedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, prompt);
  assert.equal(result.prompt.userInput, typedInput);
  assert.equal(result.alignedTyped, typedInput);
});

test("aligns typed input after a no-space root prompt when command echo lags mid-word", () => {
  const prompt = "root@host:~#";
  const typedInput = "git status";
  const echoedInput = "git st";
  const lineText = `${prompt}${echoedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, prompt);
  assert.equal(result.prompt.userInput, typedInput);
  assert.equal(result.alignedTyped, typedInput);
});

test("aligns reliable typed input when standard prompt echo lags near completion", () => {
  const typedInput = "git status";
  const term = createFakeTerm("$ git statu", "$ git statu".length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, "$ ");
  assert.equal(result.prompt.userInput, typedInput);
  assert.equal(result.alignedTyped, typedInput);
});

test("aligns reliable typed input when standard prompt echo lags after a word boundary", () => {
  const typedInput = "git status";
  const cases = ["$ git ", "$ git st"];

  for (const lineText of cases) {
    const term = createFakeTerm(lineText, lineText.length);

    const result = getAlignedPrompt(term as never, typedInput, true);

    assert.equal(result.prompt.isAtPrompt, true, lineText);
    assert.equal(result.prompt.promptText, "$ ", lineText);
    assert.equal(result.prompt.userInput, typedInput, lineText);
    assert.equal(result.alignedTyped, typedInput, lineText);
  }
});

test("does not record partial standard prompt input while reliable typed input is still echoing", () => {
  const typedInput = "sudo";
  const term = createFakeTerm("$ s", "$ s".length);
  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, "$ ");
  assert.equal(result.prompt.userInput, "s");
  assert.equal(result.alignedTyped, null);
  assert.equal(
    getCommandToRecordOnEnter(result.prompt, result.alignedTyped, typedInput, true),
    null,
  );
});

test("records aligned short commands when standard prompt echo lags by one character", () => {
  const cases = [
    { lineText: "$ l", typedInput: "ls" },
    { lineText: "$ c", typedInput: "cd" },
    { lineText: "prod-web> l", typedInput: "ls", promptText: "prod-web> " },
    { lineText: "prod> l", typedInput: "ls", promptText: "prod> " },
    { lineText: "prod.web> l", typedInput: "ls", promptText: "prod.web> " },
    { lineText: "user@host:~$ l", typedInput: "ls", promptText: "user@host:~$ " },
    { lineText: "[user@host ~]$ l", typedInput: "ls", promptText: "[user@host ~]$ " },
    { lineText: "➜  netcatty $ l", typedInput: "ls", promptText: "➜  netcatty $ " },
    { lineText: "➜  git l", typedInput: "ls", promptText: "➜  git " },
    { lineText: "➜  git np", typedInput: "npm", promptText: "➜  git " },
  ];

  for (const { lineText, typedInput, promptText = "$ " } of cases) {
    const result = getAlignedPrompt(createFakeTerm(lineText, lineText.length) as never, typedInput, true);

    assert.equal(result.prompt.isAtPrompt, true, lineText);
    assert.equal(result.prompt.promptText, promptText, lineText);
    assert.equal(result.prompt.userInput, typedInput, lineText);
    assert.equal(result.alignedTyped, typedInput, lineText);
    assert.equal(
      getCommandToRecordOnEnter(result.prompt, result.alignedTyped, typedInput, true),
      typedInput,
      lineText,
    );
  }
});

test("records aligned typed input instead of lagging standard prompt input on Enter", () => {
  const typedInput = "git status";
  const term = createFakeTerm("$ git ", "$ git ".length);
  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(
    getCommandToRecordOnEnter(result.prompt, result.alignedTyped, typedInput, true),
    typedInput,
  );
});

test("does not record themed prompt decorations when typed input is unreliable", () => {
  const cases = [
    {
      lineText: "➜  ~ git status",
      promptText: "➜ ",
      expectedUserInput: " ~ git status",
    },
    {
      lineText: "➜  netcatty git:(main) ✗ git status",
      promptText: "➜ ",
      expectedUserInput: " netcatty git:(main) ✗ git status",
    },
    {
      lineText: "  ~ git status",
      promptText: " ",
      expectedUserInput: " ~ git status",
    },
  ];

  for (const { lineText, promptText, expectedUserInput } of cases) {
    const result = getAlignedPrompt(
      createFakeTerm(lineText, lineText.length) as never,
      "",
      false,
    );

    assert.equal(result.prompt.isAtPrompt, true, lineText);
    assert.equal(result.prompt.promptText, promptText, lineText);
    assert.equal(result.prompt.userInput, expectedUserInput, lineText);
    assert.equal(
      getCommandToRecordOnEnter(result.prompt, result.alignedTyped, "", false),
      null,
      lineText,
    );
  }
});

test("records recognized themed prompts when typed input is unreliable", () => {
  const cases = [
    "➜ git status",
    " git status",
    "➜  netcatty $ git status",
    "➜  netcatty git:(main) ✗ $ git status",
    "  ~ $ git status",
  ];

  for (const lineText of cases) {
    const result = getAlignedPrompt(
      createFakeTerm(lineText, lineText.length) as never,
      "",
      false,
    );

    assert.equal(result.prompt.isAtPrompt, true, lineText);
    assert.equal(result.prompt.userInput, "git status", lineText);
    assert.equal(
      getCommandToRecordOnEnter(result.prompt, result.alignedTyped, "", false),
      "git status",
      lineText,
    );
  }
});

test("aligns themed bare directory prompts with reliable typed input", () => {
  const cases = [
    { dir: "netcatty", typedInput: "ls" },
    { dir: "git", typedInput: "ls" },
    { dir: "git", typedInput: "npm" },
    { dir: "git", typedInput: "git status" },
    { dir: "git", typedInput: "npm test" },
    { dir: "make", typedInput: "sudo" },
    { dir: "make", typedInput: "make build" },
    { dir: "make", typedInput: "git status" },
    { dir: "node", typedInput: "yarn" },
    { dir: "node", typedInput: "npm test" },
    { dir: "docker", typedInput: "git status" },
    { dir: "go", typedInput: "test" },
    { dir: "go", typedInput: "npm test" },
    { dir: "kubectl", typedInput: "sudo" },
    { dir: "kubectl", typedInput: "git status" },
  ];

  for (const { dir, typedInput } of cases) {
    const lineText = `➜  ${dir} ${typedInput}`;
    const result = getAlignedPrompt(
      createFakeTerm(lineText, lineText.length) as never,
      typedInput,
      true,
    );

    assert.equal(result.prompt.isAtPrompt, true, dir);
    assert.equal(result.prompt.promptText, `➜  ${dir} `, dir);
    assert.equal(result.prompt.userInput, typedInput, dir);
    assert.equal(result.alignedTyped, typedInput, dir);
    assert.equal(
      getCommandToRecordOnEnter(result.prompt, result.alignedTyped, typedInput, true),
      typedInput,
      dir,
    );
  }
});

test("records reliable typed input before shell echo appears", () => {
  const cases = [
    { lineText: "$ ", typedInput: "ls" },
    { lineText: "server> ", typedInput: "exit" },
    { lineText: "staging> ", typedInput: "show dbs" },
    { lineText: "test> ", typedInput: "exit" },
    { lineText: "test> ", typedInput: "help" },
    { lineText: "test> ", typedInput: "show dbs" },
    { lineText: "➜  git ", typedInput: "npm" },
    { lineText: "➜  make ", typedInput: "sudo" },
    { lineText: "➜  node ", typedInput: "yarn" },
  ];

  for (const { lineText, typedInput } of cases) {
    const result = getAlignedPrompt(
      createFakeTerm(lineText, lineText.length) as never,
      typedInput,
      true,
    );

    assert.equal(result.prompt.isAtPrompt, true, lineText);
    assert.equal(
      getCommandToRecordOnEnter(result.prompt, result.alignedTyped, typedInput, true),
      typedInput,
      lineText,
    );
  }
});

test("does not record reliable typed input before interactive echo appears", () => {
  const cases = [
    { lineText: "test> ", typedInput: "const x = 1" },
    { lineText: "test> ", typedInput: "await db.users.findOne()" },
    { lineText: "test> ", typedInput: "db" },
    { lineText: "rs0 [direct: primary] reporting> ", typedInput: "const x = 1" },
    { lineText: "rs0 [direct: primary] reporting> ", typedInput: "await db.users.findOne()" },
    { lineText: "rs0 [direct: primary] reporting> ", typedInput: "db.stats()" },
    { lineText: "Atlas a [primary] reporting> ", typedInput: "db.stats()" },
  ];

  for (const { lineText, typedInput } of cases) {
    const result = getAlignedPrompt(
      createFakeTerm(lineText, lineText.length) as never,
      typedInput,
      true,
    );

    assert.equal(
      getCommandToRecordOnEnter(result.prompt, result.alignedTyped, typedInput, true),
      null,
      lineText,
    );
  }
});

test("detects themed bare directory prompts with standard terminators", () => {
  const cases = [
    { lineText: "➜  git $ npm test", promptText: "➜  git $ ", typedInput: "npm test" },
    { lineText: "➜  make $ git status", promptText: "➜  make $ ", typedInput: "git status" },
  ];

  for (const { lineText, promptText, typedInput } of cases) {
    const result = getAlignedPrompt(
      createFakeTerm(lineText, lineText.length) as never,
      "",
      false,
    );

    assert.equal(result.prompt.isAtPrompt, true, lineText);
    assert.equal(result.prompt.promptText, promptText, lineText);
    assert.equal(result.prompt.userInput, typedInput, lineText);
    assert.equal(
      getCommandToRecordOnEnter(result.prompt, result.alignedTyped, "", false),
      typedInput,
      lineText,
    );
  }
});

test("does not record path-decorated themed prompts when typed input is unreliable", () => {
  const cases = [
    "➜ ~/repo git status",
    " ~/repo git status",
  ];

  for (const lineText of cases) {
    const result = getAlignedPrompt(
      createFakeTerm(lineText, lineText.length) as never,
      "",
      false,
    );

    assert.equal(result.prompt.isAtPrompt, true, lineText);
    assert.equal(
      getCommandToRecordOnEnter(result.prompt, result.alignedTyped, "", false),
      null,
      lineText,
    );
  }
});

test("does not record partial themed prompt decorations when short command echo lags", () => {
  const cases = [
    { lineText: "➜  ~ l", typedInput: "ls" },
    { lineText: "➜  ~ c", typedInput: "cd" },
    { lineText: "➜  ~ s", typedInput: "sudo" },
  ];

  for (const { lineText, typedInput } of cases) {
    const result = getAlignedPrompt(
      createFakeTerm(lineText, lineText.length) as never,
      typedInput,
      true,
    );

    assert.equal(result.prompt.isAtPrompt, true, lineText);
    assert.equal(
      getCommandToRecordOnEnter(result.prompt, result.alignedTyped, typedInput, true),
      null,
      lineText,
    );
  }
});

test("aligns typed input after a no-space root prompt when a short command echo lags by a word", () => {
  const prompt = "root@host:~#";
  const cases = [
    { echoedInput: "ls ", typedInput: "ls -la" },
    { echoedInput: "cd ", typedInput: "cd /tmp" },
  ];

  for (const { echoedInput, typedInput } of cases) {
    const lineText = `${prompt}${echoedInput}`;
    const term = createFakeTerm(lineText, lineText.length);

    const result = getAlignedPrompt(term as never, typedInput, true);

    assert.equal(result.prompt.isAtPrompt, true, typedInput);
    assert.equal(result.prompt.promptText, prompt, typedInput);
    assert.equal(result.prompt.userInput, typedInput, typedInput);
    assert.equal(result.alignedTyped, typedInput, typedInput);
  }
});

test("aligns typed input after a no-space root prompt when a short command echo lags by one character", () => {
  const prompt = " root@stwo:~#";
  const cases = [
    { echoedInput: "l", typedInput: "ls" },
    { echoedInput: "c", typedInput: "cd" },
  ];

  for (const { echoedInput, typedInput } of cases) {
    const lineText = `${prompt}${echoedInput}`;
    const term = createFakeTerm(lineText, lineText.length);

    const result = getAlignedPrompt(term as never, typedInput, true);

    assert.equal(result.prompt.isAtPrompt, true, typedInput);
    assert.equal(result.prompt.promptText, prompt, typedInput);
    assert.equal(result.prompt.userInput, typedInput, typedInput);
    assert.equal(result.alignedTyped, typedInput, typedInput);
  }
});

test("does not align stale typed input against unrelated prompt text", () => {
  const term = createFakeTerm("$ ls", 4);

  const result = getAlignedPrompt(term as never, "sudo", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, "$ ");
  assert.equal(result.prompt.userInput, "ls");
  assert.equal(result.alignedTyped, null);
});

test("does not align stale typed input when the live command ends with it", () => {
  const term = createFakeTerm("$ echo sudo", "$ echo sudo".length);

  const result = getAlignedPrompt(term as never, "sudo", true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, "$ ");
  assert.equal(result.prompt.userInput, "echo sudo");
  assert.equal(result.alignedTyped, null);
});

test("does not align stale typed input after host prompt command symbols", () => {
  const prompt = "user@host:~$ ";
  const cases = [
    `${prompt}echo # sudo`,
    `${prompt}printf % sudo`,
    `${prompt}echo $ sudo`,
  ];

  for (const lineText of cases) {
    const result = getAlignedPrompt(createFakeTerm(lineText, lineText.length) as never, "sudo", true);

    assert.equal(result.prompt.isAtPrompt, true, lineText);
    assert.equal(result.prompt.promptText, prompt, lineText);
    assert.equal(result.prompt.userInput, lineText.slice(prompt.length), lineText);
    assert.equal(result.alignedTyped, null, lineText);
  }
});

test("does not align stale typed input when the live path ends with it", () => {
  const cases = [
    "$ cd ~/sudo",
    "$ echo /tmp/sudo",
    "$ printf foo:sudo",
    "$ cat ./sudo",
    "$ run [sudo",
    "$ cat > sudo",
    "$ echo path#sudo",
    "$ echo 100%sudo",
  ];

  for (const lineText of cases) {
    const result = getAlignedPrompt(createFakeTerm(lineText, lineText.length) as never, "sudo", true);

    assert.equal(result.prompt.isAtPrompt, true, lineText);
    assert.equal(result.prompt.promptText, "$ ", lineText);
    assert.equal(result.prompt.userInput, lineText.slice(2), lineText);
    assert.equal(result.alignedTyped, null, lineText);
  }
});

test("does not align stale typed input from partial echoes after a no-space prompt", () => {
  const prompt = " root@stwo:~#";
  const cases = [
    `${prompt}s`,
    `${prompt}sud`,
  ];

  for (const lineText of cases) {
    const result = getAlignedPrompt(createFakeTerm(lineText, lineText.length) as never, "sudo", true);

    assert.equal(result.prompt.isAtPrompt, false, lineText);
    assert.equal(result.alignedTyped, null, lineText);
  }
});

test("does not align stale typed input after no-space prompt command suffixes", () => {
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
    const result = getAlignedPrompt(createFakeTerm(lineText, lineText.length) as never, "sudo", true);

    assert.equal(result.prompt.isAtPrompt, false, lineText);
    assert.equal(result.alignedTyped, null, lineText);
  }
});

test("does not align stale typed input from short standard prompt prefixes", () => {
  for (const lineText of ["$ s", "$ su", "$ sud"]) {
    const result = getAlignedPrompt(createFakeTerm(lineText, lineText.length) as never, "sudo", true);

    assert.equal(result.prompt.isAtPrompt, true, lineText);
    assert.equal(result.prompt.promptText, "$ ", lineText);
    assert.equal(result.prompt.userInput, lineText.slice(2), lineText);
    assert.equal(result.alignedTyped, null, lineText);
  }
});

test("aligns wrapped typed input after a no-space root prompt", () => {
  const prompt = " root@stwo:~#";
  const typedInput = "printf 1234567890";
  const cols = 20;
  const firstInputSegmentLength = cols - prompt.length;
  const rows = [
    `${prompt}${typedInput.slice(0, firstInputSegmentLength)}`,
    typedInput.slice(firstInputSegmentLength),
  ];
  const term = createWrappedFakeTerm(rows, 1, rows[1].length, cols);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, prompt);
  assert.equal(result.prompt.userInput, typedInput);
  assert.equal(result.alignedTyped, typedInput);
});

test("aligns wrapped typed input after a no-space root prompt when shell echo lags", () => {
  const prompt = " root@stwo:~#";
  const typedInput = "printf 1234567890";
  const echoedInput = typedInput.slice(0, -2);
  const cols = 20;
  const firstInputSegmentLength = cols - prompt.length;
  const rows = [
    `${prompt}${echoedInput.slice(0, firstInputSegmentLength)}`,
    echoedInput.slice(firstInputSegmentLength),
  ];
  const term = createWrappedFakeTerm(rows, 1, rows[1].length, cols);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, prompt);
  assert.equal(result.prompt.userInput, typedInput);
  assert.equal(result.alignedTyped, typedInput);
});

test("does not resurrect python REPL prompts during fallback alignment", () => {
  const typedInput = "print('ok')";
  const lineText = `>>> ${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, false);
  assert.equal(result.alignedTyped, null);
});

test("does not resurrect mysql REPL prompts during fallback alignment", () => {
  const typedInput = "select 1";
  const lineText = `mysql> ${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, false);
  assert.equal(result.alignedTyped, null);
});

test("does not resurrect mysql continuation prompts during fallback alignment", () => {
  const prompts = [
    "    -> ",
    "    '> ",
    "    \"> ",
    "    `> ",
  ];

  for (const prompt of prompts) {
    const typedInput = "select 1";
    const term = createFakeTerm(`${prompt}${typedInput}`, prompt.length + typedInput.length);

    const result = getAlignedPrompt(term as never, typedInput, true);

    assert.equal(result.prompt.isAtPrompt, false, prompt);
    assert.equal(result.alignedTyped, null, prompt);
  }
});

test("does not resurrect redis-cli REPL prompts during fallback alignment", () => {
  const prompts = [
    "redis-cli> ",
    "redis> ",
    "127.0.0.1:6379> ",
    "127.0.0.1:6379[1]> ",
    "localhost:6379> ",
  ];

  for (const prompt of prompts) {
    const typedInput = "get key";
    const term = createFakeTerm(`${prompt}${typedInput}`, prompt.length + typedInput.length);

    const result = getAlignedPrompt(term as never, typedInput, true);

    assert.equal(result.prompt.isAtPrompt, false, prompt);
    assert.equal(result.alignedTyped, null, prompt);
  }
});

test("does not resurrect mariadb REPL prompts during fallback alignment", () => {
  const typedInput = "select 1";
  const prompt = "MariaDB [(none)]> ";
  const term = createFakeTerm(`${prompt}${typedInput}`, prompt.length + typedInput.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, false);
  assert.equal(result.alignedTyped, null);
});

test("does not resurrect postgres REPL prompts during fallback alignment", () => {
  for (const prompt of [
    "postgres=# ",
    "postgres=> ",
    "postgres-# ",
    "postgres'# ",
    "postgres(# ",
    "postgres*# ",
    "postgres!# ",
    "postgres^# ",
    "postgres$tag$# ",
    "postgres(> ",
    "postgres*> ",
    "postgres!> ",
    "postgres^> ",
    "postgres$tag$> ",
  ]) {
    const typedInput = "select 1";
    const term = createFakeTerm(`${prompt}${typedInput}`, prompt.length + typedInput.length);

    const result = getAlignedPrompt(term as never, typedInput, true);

    assert.equal(result.prompt.isAtPrompt, false, prompt);
    assert.equal(result.alignedTyped, null, prompt);
  }
});

test("keeps host-style greater-than shell prompts", () => {
  const prompt = "prod-web> ";
  for (const typedInput of ["deploy", "exit", "show dbs", "use app", "it", "help", "print(1)"]) {
    const term = createFakeTerm(`${prompt}${typedInput}`, prompt.length + typedInput.length);

    const result = getAlignedPrompt(term as never, typedInput, true);

    assert.equal(result.prompt.isAtPrompt, true, typedInput);
    assert.equal(result.prompt.promptText, prompt, typedInput);
    assert.equal(result.prompt.userInput, typedInput, typedInput);
    assert.equal(result.alignedTyped, typedInput, typedInput);
  }
});

test("does not resurrect shell continuation prompts during fallback alignment", () => {
  const typedInput = "echo ok";
  const lineText = `> ${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, false);
  assert.equal(result.alignedTyped, null);
});

test("does not resurrect no-space python REPL prompts during fallback alignment", () => {
  const typedInput = "print(1)";
  const lineText = `>>>${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, false);
  assert.equal(result.alignedTyped, null);
});

test("does not resurrect no-space mysql REPL prompts during fallback alignment", () => {
  const typedInput = "select 1";
  const lineText = `mysql>${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, false);
  assert.equal(result.alignedTyped, null);
});

test("does not resurrect host-like no-space REPL prompts during fallback alignment", () => {
  const typedInput = "select 1";
  const lineText = `user@db>${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, false);
  assert.equal(result.alignedTyped, null);
});

test("does not resurrect no-space shell continuation prompts during fallback alignment", () => {
  const typedInput = "echo ok";
  const lineText = `>${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, false);
  assert.equal(result.alignedTyped, null);
});

test("keeps typed command intact for PUA-only prompts when command text contains Powerline glyphs", () => {
  const typedInput = "echo  foo";
  const lineText = ` root  ~  ${typedInput}`;
  const term = createFakeTerm(lineText, lineText.length);

  const result = getAlignedPrompt(term as never, typedInput, true);

  assert.equal(result.prompt.isAtPrompt, true);
  assert.equal(result.prompt.promptText, " root  ~  ");
  assert.equal(result.prompt.userInput, typedInput);
  assert.equal(result.alignedTyped, typedInput);
});
