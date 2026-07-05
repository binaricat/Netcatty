const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const terminalBridge = require("./terminalBridge.cjs");
const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");

const TEMP_ROOT = path.join(__dirname, ".tmp-terminal-bridge-worker-log-mirror-tests");

function registerWorkerHandlers(sent) {
  const listeners = new Map();
  const handlers = new Map();
  terminalBridge.registerHandlers(
    {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      on(channel, listener) {
        listeners.set(channel, listener);
      },
    },
    {
      terminalWorkerManager: {
        request: async () => ({}),
        send(channel, payload, options) {
          sent.push([channel, payload, options]);
        },
      },
    },
  );
  return { listeners, handlers };
}

test("worker-mode write forward still delivers the payload to the worker", () => {
  const sent = [];
  const { listeners } = registerWorkerHandlers(sent);
  const write = listeners.get("netcatty:write");

  write({ sender: { id: 7 } }, { sessionId: "session-x", data: "ls\r" });

  assert.deepEqual(sent, [
    ["netcatty:write", { sessionId: "session-x", data: "ls\r" }, { webContentsId: 7 }],
  ]);
});

test("worker-mode write forward mirrors sudo autofill rewrites into main-process session logs", async () => {
  const directory = path.join(TEMP_ROOT, `sudo-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = path.join(directory, "manual.log");
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sent = [];
  const { listeners } = registerWorkerHandlers(sent);
  const write = listeners.get("netcatty:write");

  try {
    const startResult = sessionLogStreamManager.startStreamToFile(sessionId, {
      filePath,
      format: "raw",
      hostLabel: "manual",
      stopRequiresToken: true,
    });
    assert.equal(startResult.ok, true);

    const prepared = "sudo -p '[sudo] password for %p: __NETCATTY_SUDO_abc123__' apt update\r";
    write({ sender: { id: 7 } }, { sessionId, data: prepared });
    assert.equal(sent.length, 1);

    // The remote echo of the prepared command arrives as terminal output.
    sessionLogStreamManager.appendData(sessionId, `${prepared}\n`);
    const finalPath = await sessionLogStreamManager.stopStream(sessionId, startResult.token);

    assert.equal(finalPath, filePath);
    assert.equal(fs.readFileSync(filePath, "utf8"), "sudo apt update\r\n");
  } finally {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("worker-mode write forward mirrors programmatic command rewrites into main-process session logs", async () => {
  const directory = path.join(TEMP_ROOT, `programmatic-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const filePath = path.join(directory, "manual.log");
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sent = [];
  const { listeners } = registerWorkerHandlers(sent);
  const write = listeners.get("netcatty:write");

  try {
    const startResult = sessionLogStreamManager.startStreamToFile(sessionId, {
      filePath,
      format: "raw",
      hostLabel: "manual",
      stopRequiresToken: true,
    });
    assert.equal(startResult.ok, true);

    write({ sender: { id: 7 } }, {
      sessionId,
      data: " netcatty-internal-reload\r",
      logRewrite: { sentCommand: " netcatty-internal-reload", displayCommand: "" },
    });

    sessionLogStreamManager.appendData(sessionId, " netcatty-internal-reload\r\nuser@host:~$ ");
    const finalPath = await sessionLogStreamManager.stopStream(sessionId, startResult.token);

    assert.equal(finalPath, filePath);
    assert.equal(fs.readFileSync(filePath, "utf8"), "\r\nuser@host:~$ ");
  } finally {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
