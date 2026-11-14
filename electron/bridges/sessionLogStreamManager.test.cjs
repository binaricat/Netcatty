const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  appendData,
  hasStream,
  hasSessionLog,
  prepareSessionLog,
  forgetSessionLog,
  getSessionLogToken,
  forgetInactiveSessionLog,
  withSessionLogRestart,
  registerProgrammaticCommandLogRewrite,
  registerSudoAutofillInput,
  startStream,
  startStreamToFile,
  stopStream,
  cleanupAll,
} = require("./sessionLogStreamManager.cjs");

const TEMP_ROOT = path.join(__dirname, ".tmp-session-log-stream-tests");

test("quit cleanup finishes all pending file captures before resolving", async () => {
  const directory = path.join(TEMP_ROOT, `quit-${Date.now()}`);
  try {
    for (const sessionId of ["quit-one", "quit-two"]) {
      startStreamToFile(sessionId, { filePath: path.join(directory, `${sessionId}.log`), format: "raw" });
      appendData(sessionId, `output before quit: ${sessionId}\r\n`);
    }
    await cleanupAll();
    for (const sessionId of ["quit-one", "quit-two"]) {
      assert.equal(hasStream(sessionId), false);
      assert.equal(fs.readFileSync(path.join(directory, `${sessionId}.log`), "utf8"), `output before quit: ${sessionId}\r\n`);
    }
  } finally {
    await cleanupAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("txt stream live snapshots include pending ED2 cleared screens", async () => {
  const directory = path.join(TEMP_ROOT, `stream-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "txt",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    appendData(sessionId, "before tui\n\x1b[H\x1b[2Jframe one\n\x1b[H\x1b[2Jframe two\n");

    const filePath = await waitForFileContent(directory, "before tui\n\nframe one\n\nframe two");
    assert.equal(fs.readFileSync(filePath, "utf8"), "before tui\n\nframe one\n\nframe two");
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("txt stream finalization commits pending ED2 cleared screens", async () => {
  const directory = path.join(TEMP_ROOT, `stream-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "txt",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    appendData(sessionId, "before tui\n\x1b[H\x1b[2Jframe one\n\x1b[H\x1b[2Jframe two\n");

    const filePath = await stopStream(sessionId);

    assert.equal(fs.readFileSync(filePath, "utf8"), "before tui\n\nframe one\n\nframe two");
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startStream returns a token; stopStream with stale token leaves the active stream alone (issue #916)", async () => {
  // Reproduces the bug shape where the user clicks "Restart" after a
  // session disconnect. The renderer reuses the same sessionId, so the
  // bridges call startStream(sessionId, ...) again. If a stale close
  // handler from the previous incarnation later fires
  // stopStream(sessionId), it must NOT clobber the freshly-started stream.
  const directory = path.join(TEMP_ROOT, `stream-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    // First connection.
    const firstToken = startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "raw",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    assert.ok(firstToken, "first startStream should return a token");
    appendData(sessionId, "first-session\n");
    const firstPath = await stopStream(sessionId, firstToken);
    assert.ok(firstPath, "first stopStream should return its file path");

    // User clicks "Restart" - same sessionId, fresh stream.
    const secondToken = startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "raw",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 10),
    });
    assert.ok(secondToken, "second startStream should return a token");
    assert.notEqual(firstToken, secondToken, "tokens must be unique across starts");
    appendData(sessionId, "second-session-before-stale\n");

    // SIMULATE THE BUG: a stale close handler from the previous SSH
    // connection finally fires and calls stopStream with the OLD token.
    // The current implementation must ignore it.
    const staleResult = await stopStream(sessionId, firstToken);
    assert.equal(staleResult, null, "stale stopStream must be a no-op");
    assert.equal(hasStream(sessionId), true, "second stream must still be active after stale stop");

    // More output for the new session — must reach the file.
    appendData(sessionId, "second-session-after-stale\n");
    const secondPath = await stopStream(sessionId, secondToken);
    assert.ok(secondPath, "second stopStream should return its file path");
    assert.notEqual(firstPath, secondPath, "second connection should write to a new file");

    // Both files exist and contain the expected output.
    assert.equal(fs.readFileSync(firstPath, "utf8"), "first-session\n");
    assert.equal(
      fs.readFileSync(secondPath, "utf8"),
      "second-session-before-stale\nsecond-session-after-stale\n",
    );
  } finally {
    // Belt-and-suspenders cleanup; both streams are normally already stopped.
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("stopStream without a token still tears down the current stream (back-compat)", async () => {
  const directory = path.join(TEMP_ROOT, `stream-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "raw",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    appendData(sessionId, "data\n");
    const finalPath = await stopStream(sessionId);
    assert.ok(finalPath);
    assert.equal(fs.readFileSync(finalPath, "utf8"), "data\n");
    assert.equal(hasStream(sessionId), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("token-required explicit file streams ignore tokenless stale stops", async () => {
  const directory = path.join(TEMP_ROOT, `manual-token-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = path.join(directory, "manual.log");
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let token;

  try {
    const result = startStreamToFile(sessionId, {
      filePath,
      format: "raw",
      hostLabel: "manual",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
      stopRequiresToken: true,
    });
    assert.equal(result.ok, true);
    token = result.token;

    appendData(sessionId, "before-stale\n");
    const staleResult = await stopStream(sessionId);
    assert.equal(staleResult, null);
    assert.equal(hasStream(sessionId), true);

    appendData(sessionId, "after-stale\n");
    const finalPath = await stopStream(sessionId, token);

    assert.equal(finalPath, filePath);
    assert.equal(fs.readFileSync(filePath, "utf8"), "before-stale\nafter-stale\n");
  } finally {
    if (hasStream(sessionId)) {
      await stopStream(sessionId, token);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startStreamToFile writes to an explicit raw log file path", async () => {
  const directory = path.join(TEMP_ROOT, `manual-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = path.join(directory, "manual.log");
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const result = startStreamToFile(sessionId, {
      filePath,
      format: "raw",
      hostLabel: "manual",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
      initialLine: "header\n",
    });

    assert.equal(result.ok, true);
    appendData(sessionId, "body\n");
    const finalPath = await stopStream(sessionId);

    assert.equal(finalPath, filePath);
    assert.equal(fs.readFileSync(filePath, "utf8"), "header\nbody\n");
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startStreamToFile keeps unterminated initial line joined to ordinary raw output", async () => {
  const directory = path.join(TEMP_ROOT, `manual-ordinary-raw-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = path.join(directory, "manual.log");
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const result = startStreamToFile(sessionId, {
      filePath,
      format: "raw",
      hostLabel: "manual",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
      initialLine: "root@host:~# ",
      separateInitialLineBeforeLeadingCarriageReturn: true,
    });

    assert.equal(result.ok, true);
    appendData(sessionId, "ls\r\nfile\r\n");
    const finalPath = await stopStream(sessionId);

    assert.equal(finalPath, filePath);
    assert.equal(fs.readFileSync(filePath, "utf8"), "root@host:~# ls\r\nfile\r\n");
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startStreamToFile separates unterminated initial line before leading carriage return", async () => {
  const directory = path.join(TEMP_ROOT, `manual-leading-cr-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = path.join(directory, "manual.log");
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const result = startStreamToFile(sessionId, {
      filePath,
      format: "raw",
      hostLabel: "manual",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
      initialLine: "H3C>",
      separateInitialLineBeforeLeadingCarriageReturn: true,
    });

    assert.equal(result.ok, true);
    appendData(sessionId, "\rdisplay version\r\n");
    const finalPath = await stopStream(sessionId);

    assert.equal(finalPath, filePath);
    assert.equal(fs.readFileSync(filePath, "utf8"), "H3C>\n\rdisplay version\r\n");
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startStreamToFile does not add a separator before leading CRLF", async () => {
  const directory = path.join(TEMP_ROOT, `manual-leading-crlf-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = path.join(directory, "manual.log");
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const result = startStreamToFile(sessionId, {
      filePath,
      format: "raw",
      hostLabel: "manual",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
      initialLine: "root@host:~# command",
      separateInitialLineBeforeLeadingCarriageReturn: true,
    });

    assert.equal(result.ok, true);
    appendData(sessionId, "\r\noutput\r\n");
    const finalPath = await stopStream(sessionId);

    assert.equal(finalPath, filePath);
    assert.equal(fs.readFileSync(filePath, "utf8"), "root@host:~# command\r\noutput\r\n");
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startStreamToFile does not add a separator before split leading CRLF", async () => {
  const directory = path.join(TEMP_ROOT, `manual-split-leading-crlf-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = path.join(directory, "manual.log");
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const result = startStreamToFile(sessionId, {
      filePath,
      format: "raw",
      hostLabel: "manual",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
      initialLine: "root@host:~# command",
      separateInitialLineBeforeLeadingCarriageReturn: true,
    });

    assert.equal(result.ok, true);
    appendData(sessionId, "\r");
    appendData(sessionId, "\noutput\r\n");
    const finalPath = await stopStream(sessionId);

    assert.equal(finalPath, filePath);
    assert.equal(fs.readFileSync(filePath, "utf8"), "root@host:~# command\r\noutput\r\n");
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startStreamToFile flushes a pending leading carriage return on stop", async () => {
  const directory = path.join(TEMP_ROOT, `manual-pending-leading-cr-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = path.join(directory, "manual.log");
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const result = startStreamToFile(sessionId, {
      filePath,
      format: "raw",
      hostLabel: "manual",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
      initialLine: "H3C>",
      separateInitialLineBeforeLeadingCarriageReturn: true,
    });

    assert.equal(result.ok, true);
    appendData(sessionId, "\r");
    const finalPath = await stopStream(sessionId);

    assert.equal(finalPath, filePath);
    assert.equal(fs.readFileSync(filePath, "utf8"), "H3C>\n\r");
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startStreamToFile can write human-readable text logs from ANSI terminal output", async () => {
  const directory = path.join(TEMP_ROOT, `manual-txt-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = path.join(directory, "manual.log");
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const result = startStreamToFile(sessionId, {
      filePath,
      format: "txt",
      hostLabel: "manual",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
    });

    assert.equal(result.ok, true);
    appendData(
      sessionId,
      "\x1b[01;32mroot@MyNAS\x1b[00m:\x1b[01;34m~\x1b[00m# ip a\r\n1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536\r\n\x1b[01;32mroot@MyNAS\x1b[00m:\x1b[01;34m~\x1b[00m# ",
    );
    const finalPath = await stopStream(sessionId);

    assert.equal(finalPath, filePath);
    assert.equal(
      fs.readFileSync(filePath, "utf8"),
      "root@MyNAS:~# ip a\n1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536\nroot@MyNAS:~#",
    );
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startStreamToFile seeds alternate-screen omission for late-started txt logs", async () => {
  const directory = path.join(TEMP_ROOT, `manual-alt-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = path.join(directory, "manual.txt");
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const result = startStreamToFile(sessionId, {
      filePath,
      format: "txt",
      hostLabel: "manual",
      alternateScreenActive: true,
    });

    assert.equal(result.ok, true);
    appendData(sessionId, "~\nstatus line\n\x1b[?1049l$ done\n");
    const finalPath = await stopStream(sessionId);

    assert.equal(finalPath, filePath);
    assert.equal(fs.readFileSync(filePath, "utf8"), "$ done");
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("raw stream hides sudo autofill prompt markers and rewritten command echoes", async () => {
  const directory = path.join(TEMP_ROOT, `stream-sudo-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const marker = "__NETCATTY_SUDO_test__";
  const prepared = `sudo -p '[sudo] password for %p: ${marker}' whoami`;

  try {
    startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "raw",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    registerSudoAutofillInput(sessionId, `\x15${prepared}\r`);
    appendData(sessionId, `${prepared}\r\n`);
    appendData(sessionId, `[sudo] password for alice: ${marker}`);
    appendData(sessionId, "\r\nroot\n");

    const finalPath = await stopStream(sessionId);
    const content = fs.readFileSync(finalPath, "utf8");

    assert.equal(content, "sudo whoami\r\n[sudo] password for alice: \r\nroot\n");
    assert.ok(!content.includes("NETCATTY_SUDO"));
    assert.ok(!content.includes("sudo -p"));
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("raw stream rewrites protected snippet command echoes", async () => {
  const directory = path.join(TEMP_ROOT, `stream-protected-snippet-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sentCommand = "sh -c 'private setup' && eval 'wrapped command'";
  const displayCommand = "sudo apt update && sudo apt upgrade -y";

  try {
    startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "raw",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    registerProgrammaticCommandLogRewrite(sessionId, { sentCommand, displayCommand });
    appendData(sessionId, sentCommand.slice(0, 12));
    appendData(sessionId, `${sentCommand.slice(12)}\r\nok\r\n`);

    const finalPath = await stopStream(sessionId);
    const content = fs.readFileSync(finalPath, "utf8");

    assert.equal(content, `${displayCommand}\r\nok\r\n`);
    assert.ok(!content.includes("private setup"));
    assert.ok(!content.includes("wrapped command"));
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("raw stream keeps programmatic command rewrites isolated per session", async () => {
  const directory = path.join(TEMP_ROOT, `stream-protected-snippet-isolated-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const rewrittenSessionId = `session-a-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const plainSessionId = `session-b-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sentCommand = "sh -c 'private setup' && eval 'wrapped command'";
  const displayCommand = "sudo apt update && sudo apt upgrade -y";

  try {
    startStream(rewrittenSessionId, {
      hostLabel: "host-a",
      hostname: "host-a.example",
      directory,
      format: "raw",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    startStream(plainSessionId, {
      hostLabel: "host-b",
      hostname: "host-b.example",
      directory,
      format: "raw",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 6),
    });
    registerProgrammaticCommandLogRewrite(rewrittenSessionId, { sentCommand, displayCommand });

    appendData(rewrittenSessionId, `${sentCommand}\r\nok-a\r\n`);
    appendData(plainSessionId, `${sentCommand}\r\nok-b\r\n`);

    const rewrittenPath = await stopStream(rewrittenSessionId);
    const plainPath = await stopStream(plainSessionId);
    const rewrittenContent = fs.readFileSync(rewrittenPath, "utf8");
    const plainContent = fs.readFileSync(plainPath, "utf8");

    assert.equal(rewrittenContent, `${displayCommand}\r\nok-a\r\n`);
    assert.equal(plainContent, `${sentCommand}\r\nok-b\r\n`);
  } finally {
    await stopStream(rewrittenSessionId);
    await stopStream(plainSessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("raw stream hides split sudo autofill markers", async () => {
  const directory = path.join(TEMP_ROOT, `stream-sudo-split-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const marker = "__NETCATTY_SUDO_split__";
  const prepared = `sudo -p '[sudo] password for %p: ${marker}' id`;

  try {
    startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "raw",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    registerSudoAutofillInput(sessionId, `\x15${prepared}\r`);
    appendData(sessionId, "sudo -p '[sudo] password for %p: __NET");
    appendData(sessionId, "CATTY_SUDO_split__' id\r\n[sudo] password for alice: __NET");
    appendData(sessionId, "CATTY_SUDO_split__\r\nuid=0\n");

    const finalPath = await stopStream(sessionId);
    const content = fs.readFileSync(finalPath, "utf8");

    assert.equal(content, "sudo id\r\n[sudo] password for alice: \r\nuid=0\n");
    assert.ok(!content.includes("NETCATTY_SUDO"));
    assert.ok(!content.includes("sudo -p"));
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("raw stream hides sudo autofill rewrites for long commands", async () => {
  const directory = path.join(TEMP_ROOT, `stream-sudo-long-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const marker = "__NETCATTY_SUDO_long__";
  const longArg = "a".repeat(6000);
  const original = `sudo printf '${longArg}'`;
  const prepared = `sudo -p '[sudo] password for %p: ${marker}' printf '${longArg}'`;

  try {
    startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "raw",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    registerSudoAutofillInput(sessionId, `\x15${prepared}\r`);
    appendData(sessionId, prepared.slice(0, 2500));
    appendData(sessionId, prepared.slice(2500, 5200));
    appendData(sessionId, `${prepared.slice(5200)}\r\n`);
    appendData(sessionId, `[sudo] password for alice: ${marker}\r\n`);

    const finalPath = await stopStream(sessionId);
    const content = fs.readFileSync(finalPath, "utf8");

    assert.equal(content, `${original}\r\n[sudo] password for alice: \r\n`);
    assert.ok(!content.includes("NETCATTY_SUDO"));
    assert.ok(!content.includes("sudo -p"));
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("raw stream releases non-prompt output after sudo autofill rewrite", async () => {
  const directory = path.join(TEMP_ROOT, `stream-sudo-warm-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const marker = "__NETCATTY_SUDO_warm__";
  const prepared = `sudo -p '[sudo] password for %p: ${marker}' printf ok`;

  try {
    startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "raw",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    registerSudoAutofillInput(sessionId, `\x15${prepared}\r`);
    appendData(sessionId, `${prepared}\r\n`);
    appendData(sessionId, "ok");

    const finalPath = await stopStream(sessionId);
    const content = fs.readFileSync(finalPath, "utf8");

    assert.equal(content, "sudo printf ok\r\nok");
    assert.ok(!content.includes("NETCATTY_SUDO"));
    assert.ok(!content.includes("sudo -p"));
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("raw stream keeps sudo autofill rewrite after ordinary output before prompt", async () => {
  const directory = path.join(TEMP_ROOT, `stream-sudo-notice-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const marker = "__NETCATTY_SUDO_notice__";
  const prepared = `sudo -p '[sudo] password for %p: ${marker}' whoami`;

  try {
    startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "raw",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    registerSudoAutofillInput(sessionId, `\x15${prepared}\r`);
    appendData(sessionId, "sudo: this is the first time notice");
    appendData(sessionId, `[sudo] password for alice: ${marker}\r\nroot\n`);

    const finalPath = await stopStream(sessionId);
    const content = fs.readFileSync(finalPath, "utf8");

    assert.equal(content, "sudo: this is the first time notice[sudo] password for alice: \r\nroot\n");
    assert.ok(!content.includes("NETCATTY_SUDO"));
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("raw stream releases prompt-shaped warm sudo output", async () => {
  const directory = path.join(TEMP_ROOT, `stream-sudo-warm-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const marker = "__NETCATTY_SUDO_warm_prompt__";
  const prepared = `sudo -p '[sudo] password for %p: ${marker}' printf '[sudo] password for alice: '`;

  try {
    startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "raw",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    registerSudoAutofillInput(sessionId, `\x15${prepared}\r`);
    appendData(sessionId, "[sudo] password for alice: ");

    const finalPath = await stopStream(sessionId);
    const content = fs.readFileSync(finalPath, "utf8");

    assert.equal(content, "[sudo] password for alice: ");
    assert.ok(!content.includes("NETCATTY_SUDO"));
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("raw stream sanitizes later shell-history echoes after sudo autofill completes", async () => {
  const directory = path.join(TEMP_ROOT, `stream-sudo-history-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const marker = "__NETCATTY_SUDO_history__";
  const prepared = `sudo -p '[sudo] password for %p: ${marker}' whoami`;

  try {
    startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "raw",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    registerSudoAutofillInput(sessionId, `\x15${prepared}\r`);
    appendData(sessionId, `[sudo] password for alice: ${marker}\r\nroot\n`);
    appendData(sessionId, `${prepared}\r\n`);

    const finalPath = await stopStream(sessionId);
    const content = fs.readFileSync(finalPath, "utf8");

    assert.equal(content, "[sudo] password for alice: \r\nroot\nsudo whoami\r\n");
    assert.ok(!content.includes("NETCATTY_SUDO"));
    assert.ok(!content.includes("sudo -p"));
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("startStream host directory preserves valid Unicode labels and replaces path-unsafe characters", async () => {
  const directory = path.join(TEMP_ROOT, `stream-unicode-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const token = startStream(sessionId, {
      hostLabel: "生产/服务器:东京*?<>|\0",
      hostname: "fallback.example",
      directory,
      format: "raw",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
    });

    assert.ok(token, "startStream should return a token");
    appendData(sessionId, "data\n");
    const finalPath = await stopStream(sessionId, token);

    assert.equal(path.basename(path.dirname(finalPath)), "生产_服务器_东京______");
    assert.equal(fs.readFileSync(finalPath, "utf8"), "data\n");
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("txt stream timestamps complete lines without duplicating split chunks", async () => {
  const directory = path.join(TEMP_ROOT, `stream-timestamps-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const times = [
    new Date(2026, 0, 2, 3, 4, 5, 123).getTime(),
    new Date(2026, 0, 2, 3, 4, 6, 456).getTime(),
    new Date(2026, 0, 2, 3, 4, 7, 89).getTime(),
  ];

  try {
    startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "txt",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
      timestampsEnabled: true,
      timestampProvider: () => times.shift(),
    });
    appendData(sessionId, "first ");
    appendData(sessionId, "line\nsecond line\npartial");

    const filePath = await stopStream(sessionId);

    assert.equal(
      fs.readFileSync(filePath, "utf8"),
      "[2026-01-02 03:04:06.456] first line\n[2026-01-02 03:04:06.456] second line\n[2026-01-02 03:04:06.456] partial",
    );
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("txt stream timestamps rendered lines after carriage-return rewrites", async () => {
  const directory = path.join(TEMP_ROOT, `stream-timestamps-cr-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "txt",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
      timestampsEnabled: true,
      timestampProvider: () => new Date(2026, 0, 2, 3, 4, 5).getTime(),
    });
    appendData(sessionId, "old prompt\rdocker denied\n");

    const filePath = await stopStream(sessionId);

    assert.equal(
      fs.readFileSync(filePath, "utf8"),
      "[2026-01-02 03:04:05.000] docker denied",
    );
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("txt stream updates a line timestamp when a later snapshot rewrites that line", async () => {
  const directory = path.join(TEMP_ROOT, `stream-timestamps-live-cr-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const times = [
    new Date(2026, 0, 2, 3, 4, 5).getTime(),
    new Date(2026, 0, 2, 3, 4, 6).getTime(),
  ];

  try {
    startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "txt",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
      timestampsEnabled: true,
      timestampProvider: () => times.shift(),
    });
    appendData(sessionId, "old prompt");
    await waitForFileContent(directory, "[2026-01-02 03:04:05.000] old prompt");
    appendData(sessionId, "\rdocker denied");

    const filePath = await stopStream(sessionId);

    assert.equal(
      fs.readFileSync(filePath, "utf8"),
      "[2026-01-02 03:04:06.000] docker denied",
    );
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("html stream includes line timestamps in rendered content", async () => {
  const directory = path.join(TEMP_ROOT, `stream-html-timestamps-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "html",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
      timestampsEnabled: true,
      timestampProvider: () => new Date(2026, 0, 2, 3, 4, 5).getTime(),
    });
    appendData(sessionId, "line\n");

    const filePath = await stopStream(sessionId);
    const html = fs.readFileSync(filePath, "utf8");

    assert.match(html, /\[2026-01-02 03:04:05\.000\] line/);
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("html stream timestamps rendered lines after carriage-return rewrites", async () => {
  const directory = path.join(TEMP_ROOT, `stream-html-timestamps-cr-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "html",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
      timestampsEnabled: true,
      timestampProvider: () => new Date(2026, 0, 2, 3, 4, 5).getTime(),
    });
    appendData(sessionId, "old prompt\rdocker denied\n");

    const filePath = await stopStream(sessionId);
    const html = fs.readFileSync(filePath, "utf8");

    assert.match(html, /\[2026-01-02 03:04:05\.000\] docker denied/);
    assert.doesNotMatch(html, /old prompt/);
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("raw stream keeps original bytes when timestamps are enabled", async () => {
  const directory = path.join(TEMP_ROOT, `stream-raw-timestamps-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    startStream(sessionId, {
      hostLabel: "host",
      hostname: "host.example",
      directory,
      format: "raw",
      startTime: Date.UTC(2026, 0, 2, 3, 4, 5),
      timestampsEnabled: true,
      timestampProvider: () => new Date(2026, 0, 2, 3, 4, 5).getTime(),
    });
    appendData(sessionId, "line\n");

    const filePath = await stopStream(sessionId);

    assert.equal(fs.readFileSync(filePath, "utf8"), "line\n");
  } finally {
    await stopStream(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function waitForFileContent(directory, expectedContent) {
  const deadline = Date.now() + 3000;
  let lastContent = "";

  while (Date.now() < deadline) {
    const filePath = findFirstTxtFile(directory);
    if (filePath && fs.existsSync(filePath)) {
      lastContent = fs.readFileSync(filePath, "utf8");
      if (lastContent === expectedContent) return filePath;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.fail(`Timed out waiting for live snapshot content. Last content: ${JSON.stringify(lastContent)}`);
}

function findFirstTxtFile(directory) {
  if (!fs.existsSync(directory)) return null;
  for (const hostDirName of fs.readdirSync(directory)) {
    const hostDir = path.join(directory, hostDirName);
    if (!fs.statSync(hostDir).isDirectory()) continue;
    const fileName = fs.readdirSync(hostDir).find((name) => name.endsWith(".txt"));
    if (fileName) return path.join(hostDir, fileName);
  }
  return null;
}

for (const format of ["txt", "html"]) {
  test(`${format} timestamps preserve arrival gaps inside one flush interval`, async () => {
    const directory = path.join(TEMP_ROOT, `arrival-${format}-${Date.now()}`);
    const sessionId = `arrival-${format}`;
    let now = new Date(2026, 0, 2, 3, 4, 5, 89).getTime();
    try {
      startStream(sessionId, {
        hostLabel: "host", directory, format, timestampsEnabled: true,
        timestampProvider: () => now,
      });
      appendData(sessionId, "first\r\n");
      now += 300;
      appendData(sessionId, "second\r\n");
      now += 100;
      const filePath = await stopStream(sessionId);
      const content = fs.readFileSync(filePath, "utf8");
      assert.match(content, /\[2026-01-02 03:04:05\.089\] first/);
      assert.match(content, /\[2026-01-02 03:04:05\.389\] second/);
    } finally {
      await stopStream(sessionId);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const format of ["txt", "html", "raw"]) {
  test(`prepare ${format} log flushes current output and leaves recording active`, async (t) => {
    const directory = path.join(TEMP_ROOT, `prepare-${format}-${Date.now()}`);
    const filePath = path.join(directory, `session.${format}`);
    const sessionId = `prepare-${format}`;
    t.after(async () => {
      await stopStream(sessionId);
      forgetSessionLog(sessionId);
      fs.rmSync(directory, { recursive: true, force: true });
    });
    startStreamToFile(sessionId, { filePath, format });
    assert.equal(await prepareSessionLog(sessionId), filePath, "empty logs must exist before opening");
    assert.equal(fs.statSync(filePath).isFile(), true);
    appendData(sessionId, "first\r\n");
    assert.equal(await prepareSessionLog(sessionId), filePath);
    assert.match(fs.readFileSync(filePath, "utf8"), /first/);
    assert.equal(hasStream(sessionId), true);
    appendData(sessionId, "second\r\n");
    await prepareSessionLog(sessionId);
    assert.match(fs.readFileSync(filePath, "utf8"), /first[\s\S]*second/);
    const stopping = stopStream(sessionId);
    assert.equal(await prepareSessionLog(sessionId), filePath, "prepare waits for finalization");
    assert.equal(await stopping, filePath);
    assert.equal(hasStream(sessionId), false);
    assert.equal(await prepareSessionLog(sessionId), filePath, "stopped logs remain accessible");
    assert.equal(await prepareSessionLog(`${sessionId}-wrong`), null);
    fs.unlinkSync(filePath);
    await assert.rejects(prepareSessionLog(sessionId), /ENOENT/);
  });
}

test("prepare raw log waits for the write callback, including already-queued writes", async (t) => {
  const { Writable } = require("node:stream");
  const directory = path.join(TEMP_ROOT, `prepare-raw-barrier-${Date.now()}`);
  const filePath = path.join(directory, "session.log");
  const sessionId = "prepare-raw-barrier";
  let completedWrites = 0;
  t.mock.method(fs, "createWriteStream", () => new Writable({
    write(chunk, _encoding, callback) {
      setTimeout(() => {
        fs.appendFileSync(filePath, chunk);
        completedWrites++;
        callback();
      }, 15);
    },
  }));
  t.after(async () => {
    await stopStream(sessionId);
    forgetSessionLog(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  startStreamToFile(sessionId, { filePath, format: "raw" });
  appendData(sessionId, "x".repeat(64 * 1024));
  const preparing = prepareSessionLog(sessionId);
  assert.equal(completedWrites, 0);
  assert.equal(await preparing, filePath);
  assert.equal(completedWrites, 2, "data write and barrier callbacks must both complete");
  assert.equal(fs.readFileSync(filePath, "utf8").length, 64 * 1024);
});

test("prepare reports snapshot failures promptly and background writes keep retrying", async (t) => {
  const directory = path.join(TEMP_ROOT, `prepare-error-${Date.now()}`);
  const filePath = path.join(directory, "session.txt");
  const sessionId = "prepare-snapshot-error";
  const writeFile = fs.promises.writeFile.bind(fs.promises);
  let fail = true;
  let attempts = 0;
  t.mock.method(fs.promises, "writeFile", async (...args) => {
    if (args[0] === filePath) {
      attempts++;
      if (fail) throw new Error("disk full");
    }
    return writeFile(...args);
  });
  t.after(async () => {
    fail = false;
    await stopStream(sessionId);
    forgetSessionLog(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  startStreamToFile(sessionId, { filePath, format: "txt" });
  appendData(sessionId, "not lost\n");
  await assert.rejects(prepareSessionLog(sessionId), /disk full/);
  const attemptsAtReport = attempts;
  assert.ok(attemptsAtReport >= 1);
  fail = false;
  const started = Date.now();
  while (!fs.existsSync(filePath) || !fs.readFileSync(filePath, "utf8").includes("not lost")) {
    if (Date.now() - started > 2000) {
      assert.fail(`snapshot retry did not persist the log (attempts=${attempts})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(attempts > attemptsAtReport, "a failed snapshot write retries without another prepare");
  assert.equal(await prepareSessionLog(sessionId), filePath);
});

test("persistent snapshot failures back off instead of retrying immediately", async (t) => {
  const directory = path.join(TEMP_ROOT, `snapshot-backoff-${Date.now()}`);
  const filePath = path.join(directory, "session.txt");
  const sessionId = "snapshot-backoff";
  const writeFile = fs.promises.writeFile.bind(fs.promises);
  let attempts = 0;
  t.mock.method(fs.promises, "writeFile", async (...args) => {
    if (args[0] === filePath) {
      attempts++;
      throw new Error("disk full");
    }
    return writeFile(...args);
  });
  t.after(async () => {
    await stopStream(sessionId);
    forgetSessionLog(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  startStreamToFile(sessionId, { filePath, format: "txt" });
  appendData(sessionId, "x".repeat(64 * 1024));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(attempts, 1, "a failed snapshot must not retry in a tight loop");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(attempts, 2, "the first retry waits for the backoff delay");
});

test("finalize ends a raw write stream that a synchronous flush already disabled", async (t) => {
  const directory = path.join(TEMP_ROOT, `finalize-disabled-${Date.now()}`);
  const filePath = path.join(directory, "session.log");
  const sessionId = "finalize-disabled-raw";
  const stream = {
    ended: false,
    on() { return this; },
    write() { throw new Error("flush failed"); },
    end(callback) {
      this.ended = true;
      if (typeof callback === "function") callback();
    },
  };
  t.mock.method(fs, "createWriteStream", () => stream);
  t.after(async () => {
    await stopStream(sessionId);
    forgetSessionLog(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const started = startStreamToFile(sessionId, { filePath, format: "raw" });
  assert.equal(started.ok, true);
  appendData(sessionId, "pending");
  assert.equal(await stopStream(sessionId), null);
  assert.equal(stream.ended, true);
});

test("prepare reports raw stream errors rather than opening an empty or stale file", async (t) => {
  const directory = path.join(TEMP_ROOT, `prepare-raw-error-${Date.now()}`);
  const filePath = path.join(directory, "directory.log");
  const sessionId = "prepare-raw-error";
  fs.mkdirSync(filePath, { recursive: true });
  t.after(async () => {
    await stopStream(sessionId);
    forgetSessionLog(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  startStreamToFile(sessionId, { filePath, format: "raw" });
  appendData(sessionId, "data");
  await assert.rejects(prepareSessionLog(sessionId), /EISDIR/);
  assert.equal(await stopStream(sessionId), null);
  await assert.rejects(prepareSessionLog(sessionId), /EISDIR/);
});

test("late finalization and stale tokens cannot replace a reconnected session's target", async (t) => {
  const directory = path.join(TEMP_ROOT, `prepare-reconnect-${Date.now()}`);
  const oldPath = path.join(directory, "old.txt");
  const newPath = path.join(directory, "new.txt");
  const sessionId = "prepare-reconnect";
  const writeFile = fs.promises.writeFile.bind(fs.promises);
  let releaseOldWrite;
  const oldWriteGate = new Promise((resolve) => { releaseOldWrite = resolve; });
  t.mock.method(fs.promises, "writeFile", async (...args) => {
    if (args[0] === oldPath) await oldWriteGate;
    return writeFile(...args);
  });
  t.after(async () => {
    releaseOldWrite();
    await stopStream(sessionId);
    forgetSessionLog(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const first = startStreamToFile(sessionId, { filePath: oldPath, format: "txt" });
  appendData(sessionId, "old\n");
  const stopping = stopStream(sessionId, first.token);
  const stalePrepare = prepareSessionLog(sessionId);
  const second = startStreamToFile(sessionId, { filePath: newPath, format: "txt" });
  assert.equal(second.ok, true);
  appendData(sessionId, "new\n");
  releaseOldWrite();
  await assert.rejects(stalePrepare, /changed/);
  assert.equal(await stopping, oldPath);
  assert.equal(await stopStream(sessionId, first.token), null);
  assert.equal(await prepareSessionLog(sessionId), newPath);
  await stopStream(sessionId, second.token);
  assert.equal(await prepareSessionLog(sessionId), newPath);
});

test("forgetting a session prevents late finalization from restoring its old path", async (t) => {
  const directory = path.join(TEMP_ROOT, `prepare-forget-${Date.now()}`);
  const filePath = path.join(directory, "old.txt");
  const sessionId = "prepare-forget";
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  startStreamToFile(sessionId, { filePath, format: "txt" });
  appendData(sessionId, "old\n");
  const stopping = stopStream(sessionId);
  forgetSessionLog(sessionId);
  await stopping;
  assert.equal(hasSessionLog(sessionId), false);
  assert.equal(await prepareSessionLog(sessionId), null);
});

test("conditional log invalidation clears only the observed inactive stream token", async (t) => {
  const directory = path.join(TEMP_ROOT, `conditional-forget-${Date.now()}`);
  const sessionId = "conditional-forget";
  const oldPath = path.join(directory, "old.txt");
  const newPath = path.join(directory, "new.txt");
  t.after(async () => {
    await stopStream(sessionId);
    forgetSessionLog(sessionId);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(getSessionLogToken(sessionId), null);
  assert.equal(forgetInactiveSessionLog(sessionId, null), false);
  const first = startStreamToFile(sessionId, { filePath: oldPath, format: "txt" });
  assert.equal(getSessionLogToken(sessionId), first.token);
  assert.equal(forgetInactiveSessionLog(sessionId, first.token), false, "active recording survives");
  await stopStream(sessionId);
  assert.equal(getSessionLogToken(sessionId), first.token, "finalization preserves record identity");
  assert.equal(forgetInactiveSessionLog(sessionId, Symbol("wrong")), false);
  assert.equal(forgetInactiveSessionLog(sessionId, first.token), true);
  assert.equal(await prepareSessionLog(sessionId), null);
  const second = startStreamToFile(sessionId, { filePath: newPath, format: "txt" });
  assert.notEqual(second.token, first.token);
  assert.equal(forgetInactiveSessionLog(sessionId, first.token), false);
  await stopStream(sessionId);
  assert.equal(forgetInactiveSessionLog(sessionId, first.token), false, "a new finalized log survives");
  assert.equal(await prepareSessionLog(sessionId), newPath);
});

for (const outcome of ["success", "throw", "failure", "different-session", "new-active", "new-finalized", "manual"]) {
  test(`fallback restart wrapper preserves the correct saved log (${outcome})`, async (t) => {
    const directory = path.join(TEMP_ROOT, `fallback-${outcome}-${Date.now()}`);
    const sessionId = `fallback-${outcome}`;
    const oldPath = path.join(directory, "old.txt");
    const newPath = path.join(directory, "new.txt");
    const event = { sender: { id: 9 } };
    const payload = { sessionId, sessionLog: { enabled: false } };
    t.after(async () => {
      await stopStream(sessionId, getSessionLogToken(sessionId));
      forgetSessionLog(sessionId);
      fs.rmSync(directory, { recursive: true, force: true });
    });
    startStreamToFile(sessionId, { filePath: oldPath, format: "txt", stopRequiresToken: outcome === "manual" });
    appendData(sessionId, "previous output\n");
    if (outcome !== "manual") await stopStream(sessionId);
    const previousToken = getSessionLogToken(sessionId);
    const start = withSessionLogRestart(async (receivedEvent, receivedPayload) => {
      assert.equal(receivedEvent, event);
      assert.equal(receivedPayload, payload);
      assert.equal(await prepareSessionLog(sessionId), oldPath, "pending starts retain the old target");
      if (outcome === "throw") throw new Error("authentication failed");
      if (outcome === "failure") return { sessionId, success: false, error: "connection refused" };
      if (outcome === "different-session") return { sessionId: "different" };
      if (outcome.startsWith("new-")) {
        startStreamToFile(sessionId, { filePath: newPath, format: "txt" });
        appendData(sessionId, "new output\n");
        if (outcome === "new-finalized") await stopStream(sessionId);
      }
      return { sessionId };
    });
    if (outcome === "throw") await assert.rejects(start(event, payload), /authentication failed/);
    else {
      const result = await start(event, payload);
      assert.equal(result.sessionId, outcome === "different-session" ? "different" : sessionId);
    }
    if (outcome === "success") {
      assert.equal(await prepareSessionLog(sessionId), null);
    } else {
      const newLog = outcome.startsWith("new-");
      assert.equal(await prepareSessionLog(sessionId), newLog ? newPath : oldPath);
      if (newLog) assert.notEqual(getSessionLogToken(sessionId), previousToken);
      else assert.equal(getSessionLogToken(sessionId), previousToken);
      assert.equal(hasStream(sessionId), outcome === "manual" || outcome === "new-active");
    }
  });
}
