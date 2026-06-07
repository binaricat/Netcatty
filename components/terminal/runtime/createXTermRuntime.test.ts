import test from "node:test";
import assert from "node:assert/strict";

import {
  createSudoPasswordAutofill,
  prepareSudoAutofillInput,
} from "./terminalSudoAutofill";
import { recordTerminalCommandExecution } from "./terminalCommandExecution";
import { createPromptLineBreakState } from "./promptLineBreak";

function createFakeTerm(lineText = "$ echo ok", cursorX = lineText.length) {
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
