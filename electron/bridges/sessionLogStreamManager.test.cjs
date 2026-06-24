const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  appendData,
  hasStream,
  registerProgrammaticCommandLogRewrite,
  registerSudoAutofillInput,
  startStream,
  stopStream,
} = require("./sessionLogStreamManager.cjs");

const TEMP_ROOT = path.join(__dirname, ".tmp-session-log-stream-tests");

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
    new Date(2026, 0, 2, 3, 4, 5).getTime(),
    new Date(2026, 0, 2, 3, 4, 6).getTime(),
    new Date(2026, 0, 2, 3, 4, 7).getTime(),
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
      "[2026-01-02 03:04:05] first line\n[2026-01-02 03:04:06] second line\n[2026-01-02 03:04:07] partial",
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
      "[2026-01-02 03:04:05] docker denied",
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
    await waitForFileContent(directory, "[2026-01-02 03:04:05] old prompt");
    appendData(sessionId, "\rdocker denied");

    const filePath = await stopStream(sessionId);

    assert.equal(
      fs.readFileSync(filePath, "utf8"),
      "[2026-01-02 03:04:06] docker denied",
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

    assert.match(html, /\[2026-01-02 03:04:05\] line/);
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

    assert.match(html, /\[2026-01-02 03:04:05\] docker denied/);
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
