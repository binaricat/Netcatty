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
