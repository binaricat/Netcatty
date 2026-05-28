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
