const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  appendData,
  hasStream,
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
