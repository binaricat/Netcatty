const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const { EventEmitter } = require("node:events");

const {
  createZmodemDownloadDirectorySelector,
  createZmodemUploadFileSelector,
  installWorkerProcessErrorGuards,
  normalizeParentPortMessage,
  registerExternalSessionHandlers,
} = require("./process.cjs");

function createParentPort() {
  const messages = [];
  const listeners = new Map();
  return {
    messages,
    on(channel, callback) {
      listeners.set(channel, callback);
    },
    postMessage(message) {
      messages.push(message);
    },
    emitMessage(message) {
      listeners.get("message")?.(message);
    },
  };
}

test("normalizeParentPortMessage unwraps Electron utility process MessageEvent data", () => {
  assert.deepEqual(
    normalizeParentPortMessage({ data: { kind: "zmodem-upload-dialog-result" } }),
    { kind: "zmodem-upload-dialog-result" },
  );
  assert.deepEqual(
    normalizeParentPortMessage({ kind: "request" }),
    { kind: "request" },
  );
});

test("terminal worker installs DH compatibility before SSH bridges load", () => {
  assert.equal(crypto.createDiffieHellmanGroup.__boringSslDhCompat, true);
});

test("ZMODEM upload selector resolves dialog results delivered as MessageEvent data", async () => {
  const parentPort = createParentPort();
  const selectUploadFiles = createZmodemUploadFileSelector(parentPort, {
    randomUUID: () => "dialog-1",
  });

  const promise = selectUploadFiles(7, "session-1");
  assert.deepEqual(parentPort.messages, [{
    kind: "zmodem-upload-dialog",
    requestId: "dialog-1",
    webContentsId: 7,
    sessionId: "session-1",
  }]);

  parentPort.emitMessage({
    data: {
      kind: "zmodem-upload-dialog-result",
      requestId: "dialog-1",
      result: { canceled: false, filePaths: ["/tmp/upload.txt"] },
    },
  });

  assert.deepEqual(await promise, {
    canceled: false,
    filePaths: ["/tmp/upload.txt"],
  });
});

test("ZMODEM download selector resolves directory dialog results delivered as MessageEvent data", async () => {
  const parentPort = createParentPort();
  const selectDownloadDirectory = createZmodemDownloadDirectorySelector(parentPort, {
    randomUUID: () => "download-dialog-1",
  });

  const promise = selectDownloadDirectory(7, "session-1");
  assert.deepEqual(parentPort.messages, [{
    kind: "zmodem-download-dialog",
    requestId: "download-dialog-1",
    webContentsId: 7,
    sessionId: "session-1",
  }]);

  parentPort.emitMessage({
    data: {
      kind: "zmodem-download-dialog-result",
      requestId: "download-dialog-1",
      result: { canceled: false, filePaths: ["/tmp/downloads"] },
    },
  });

  assert.deepEqual(await promise, {
    canceled: false,
    filePaths: ["/tmp/downloads"],
  });
});

test("external plugin sessions stream auto-save logs through output and lifecycle cleanup", async () => {
  const handlers = new Map();
  const sessions = new Map();
  const parentPort = createParentPort();
  const observed = [];
  const token = Symbol("plugin-session-log");
  const sessionLogStreamManager = {
    startStream(sessionId, options) {
      observed.push(["start-log", sessionId, options]);
      return token;
    },
    appendData(sessionId, data) {
      observed.push(["append-log", sessionId, data]);
    },
    async stopStream(sessionId, expectedToken) {
      observed.push(["stop-log", sessionId, expectedToken]);
    },
  };
  registerExternalSessionHandlers({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  }, {
    sessions,
    parentPort,
    sessionLogStreamManager,
  });
  const sender = {
    id: 7,
    send(channel, payload) {
      observed.push(["send", channel, payload]);
    },
  };

  assert.deepEqual(await handlers.get("netcatty:external:start")({ sender }, {
    sessionId: "plugin-log-1",
    protocol: "plugin:com.example.transport.connection",
    hostLabel: "Example transport",
    hostname: "example.test",
    columns: 80,
    rows: 24,
    sessionLog: {
      enabled: true,
      directory: "/logs",
      format: "html",
      timestampsEnabled: true,
    },
  }), { sessionId: "plugin-log-1" });
  assert.equal(observed[0][0], "start-log");
  assert.deepEqual(observed[0].slice(1, 3), [
    "plugin-log-1",
    {
      hostLabel: "Example transport",
      hostname: "example.test",
      directory: "/logs",
      format: "html",
      timestampsEnabled: true,
      startTime: observed[0][2].startTime,
    },
  ]);

  await handlers.get("netcatty:external:output")({ sender }, {
    sessionId: "plugin-log-1",
    data: "provider output",
  });
  assert.deepEqual(observed.slice(1, 3), [
    ["append-log", "plugin-log-1", "provider output"],
    ["send", "netcatty:data", {
      sessionId: "plugin-log-1",
      data: "provider output",
    }],
  ]);

  await assert.rejects(
    handlers.get("netcatty:external:output")({ sender }, {
      sessionId: "plugin-log-1",
      data: Buffer.from("not a decoded provider string"),
    }),
    /output is invalid/,
  );
  assert.equal(observed.length, 3);

  await handlers.get("netcatty:external:finish")({ sender }, {
    sessionId: "plugin-log-1",
    reason: "closed",
    diagnostics: [{ severity: "warning", message: "Provider closed after idle timeout" }],
  });
  assert.deepEqual(observed.slice(3), [
    ["stop-log", "plugin-log-1", token],
    ["send", "netcatty:exit", {
      sessionId: "plugin-log-1",
      exitCode: 0,
      reason: "closed",
      diagnostics: [{ severity: "warning", message: "Provider closed after idle timeout" }],
    }],
  ]);
  assert.equal(sessions.has("plugin-log-1"), false);

  await handlers.get("netcatty:external:start")({ sender }, {
    sessionId: "plugin-log-2",
    protocol: "plugin:com.example.transport.connection",
    hostLabel: "Example transport",
    hostname: "example.test",
    columns: 80,
    rows: 24,
    sessionLog: {
      enabled: true,
      directory: "/logs",
      format: "txt",
    },
  });
  sessions.get("plugin-log-2").stream.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    observed.some((entry) => entry[0] === "stop-log"
      && entry[1] === "plugin-log-2"
      && entry[2] === token),
    true,
  );
});

test("worker process guards keep a stray ssh2 transport error from killing every session", () => {
  const parentPort = createParentPort();
  const fakeProcess = new EventEmitter();
  const uninstall = installWorkerProcessErrorGuards(parentPort, fakeProcess);

  const err = new Error("Keepalive timeout");
  err.level = "client-timeout";
  // Before the guards existed this reached Node's default handler and exited
  // the utilityProcess with code 1, dropping every live session at once.
  assert.doesNotThrow(() => fakeProcess.emit("uncaughtException", err));

  uninstall();
});

test("worker process guards suppress generic runtime errors instead of exiting", () => {
  const parentPort = createParentPort();
  const fakeProcess = new EventEmitter();
  const uninstall = installWorkerProcessErrorGuards(parentPort, fakeProcess);

  // The worker is armed as "runtime started" the moment it is forked, so even
  // an error with no network classification must not take the process down.
  assert.doesNotThrow(() => fakeProcess.emit("uncaughtException", new Error("boom")));
  assert.doesNotThrow(() => fakeProcess.emit("unhandledRejection", new Error("rejected")));

  const reports = parentPort.messages.filter((m) => m.kind === "worker-process-error");
  assert.equal(reports.length, 2);
  assert.deepEqual(
    reports.map((r) => r.source),
    ["uncaughtException", "unhandledRejection"],
  );
  assert.equal(reports[0].message, "boom");
  assert.ok(typeof reports[0].stack === "string" && reports[0].stack.length > 0);

  uninstall();
});

test("worker process guards report socket error codes to the parent", () => {
  const parentPort = createParentPort();
  const fakeProcess = new EventEmitter();
  const uninstall = installWorkerProcessErrorGuards(parentPort, fakeProcess);

  const err = new Error("socket hang up");
  err.code = "ECONNRESET";
  fakeProcess.emit("uncaughtException", err);

  const report = parentPort.messages.find((m) => m.kind === "worker-process-error");
  assert.ok(report);
  assert.equal(report.code, "ECONNRESET");

  uninstall();
});

test("worker process guards ignore benign stream teardown without reporting", () => {
  const parentPort = createParentPort();
  const fakeProcess = new EventEmitter();
  const uninstall = installWorkerProcessErrorGuards(parentPort, fakeProcess);

  const err = new Error("write EPIPE");
  err.code = "EPIPE";
  assert.doesNotThrow(() => fakeProcess.emit("uncaughtException", err));
  assert.equal(parentPort.messages.filter((m) => m.kind === "worker-process-error").length, 0);

  uninstall();
});

test("worker process guards can be uninstalled", () => {
  const parentPort = createParentPort();
  const fakeProcess = new EventEmitter();
  const uninstall = installWorkerProcessErrorGuards(parentPort, fakeProcess);
  uninstall();

  assert.equal(fakeProcess.listenerCount("uncaughtException"), 0);
  assert.equal(fakeProcess.listenerCount("unhandledRejection"), 0);
});
