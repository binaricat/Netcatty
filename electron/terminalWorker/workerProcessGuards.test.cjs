const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { installTerminalWorkerErrorGuards } = require("./workerProcessGuards.cjs");

function createFakeProcess() {
  const listeners = new Map();
  return {
    on(name, callback) {
      listeners.set(name, callback);
    },
    removeListener(name, callback) {
      if (listeners.get(name) === callback) listeners.delete(name);
    },
    emit(name, err) {
      const callback = listeners.get(name);
      if (!callback) throw new Error(`no listener for ${name}`);
      callback(err);
    },
  };
}

test("worker guards suppress uncaught exceptions and report them", () => {
  const fakeProcess = createFakeProcess();
  const reports = [];
  const logs = [];
  installTerminalWorkerErrorGuards({
    processObject: fakeProcess,
    report: (origin, err, decision) => reports.push({ origin, err, reason: decision.reason }),
    logError: (...args) => logs.push(args),
  });

  const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  fakeProcess.emit("uncaughtException", err);

  assert.equal(reports.length, 1);
  assert.equal(reports[0].origin, "uncaughtException");
  assert.equal(reports[0].err, err);
  assert.equal(reports[0].reason, "non-fatal network error");
  assert.equal(logs.length, 1);
});

test("worker guards suppress unhandled rejections with non-Error reasons", () => {
  const fakeProcess = createFakeProcess();
  const reports = [];
  installTerminalWorkerErrorGuards({
    processObject: fakeProcess,
    report: (origin, err) => reports.push({ origin, err }),
    logError: () => {},
  });

  assert.doesNotThrow(() => fakeProcess.emit("unhandledRejection", "plain string reason"));
  assert.equal(reports.length, 1);
  assert.equal(reports[0].origin, "unhandledRejection");
  assert.equal(reports[0].err, "plain string reason");
});

test("worker guards absorb report failures instead of rethrowing", () => {
  const fakeProcess = createFakeProcess();
  installTerminalWorkerErrorGuards({
    processObject: fakeProcess,
    report: () => {
      throw new Error("report route is dead");
    },
    logError: () => {},
  });

  assert.doesNotThrow(() => fakeProcess.emit("uncaughtException", new Error("boom")));
});

test("uninstall removes the installed handlers", () => {
  const fakeProcess = createFakeProcess();
  const uninstall = installTerminalWorkerErrorGuards({
    processObject: fakeProcess,
    logError: () => {},
  });
  assert.doesNotThrow(() => fakeProcess.emit("uncaughtException", new Error("before")));
  uninstall();
  assert.throws(
    () => fakeProcess.emit("uncaughtException", new Error("after")),
    /no listener for uncaughtException/u,
  );
});

test("guards require a process-like EventEmitter", () => {
  assert.throws(
    () => installTerminalWorkerErrorGuards({ processObject: {} }),
    /process-like EventEmitter/u,
  );
});

const startupErrors = [
  { label: "generic", properties: {} },
  { label: "network", properties: { code: "ECONNRESET" } },
  { label: "permissions", properties: { code: "EPERM" } },
  { label: "broken pipe", properties: { code: "EPIPE" } },
  { label: "destroyed stream", properties: { code: "ERR_STREAM_DESTROYED" } },
  { label: "SSH", properties: { level: "client-timeout" } },
];

test("every startup error is fatal, including normally recoverable errors", () => {
  for (const origin of ["uncaughtException", "unhandledRejection"]) {
    for (const { label, properties } of startupErrors) {
      const fakeProcess = createFakeProcess();
      const reports = [];
      installTerminalWorkerErrorGuards({
        processObject: fakeProcess,
        isRuntimeStarted: () => false,
        logError() {},
        report: (_origin, err, decision) => reports.push({ err, decision }),
      });
      const err = Object.assign(new Error(`startup ${label}`), properties);
      assert.throws(() => fakeProcess.emit(origin, err), err, `${origin}: ${label}`);
      assert.equal(reports.length, 1);
      assert.equal(reports[0].decision.action, "fatal");
    }
  }
});

test("protection becomes active only after successful startup", () => {
  const fakeProcess = createFakeProcess();
  const reports = [];
  let started = false;
  installTerminalWorkerErrorGuards({
    processObject: fakeProcess,
    isRuntimeStarted: () => started,
    logError() {},
    report: (_origin, _err, decision) => reports.push(decision.action),
  });
  assert.throws(() => fakeProcess.emit("uncaughtException", new Error("startup")));
  started = true;
  for (const { properties } of startupErrors) {
    assert.doesNotThrow(() => fakeProcess.emit(
      "uncaughtException",
      Object.assign(new Error("runtime"), properties),
    ));
  }
  assert.equal(reports[0], "fatal");
  assert.ok(reports.slice(1).every((action) => action !== "fatal"));
});

test("a failed bridge load exits the worker instead of leaving requests hanging", () => {
  for (const { label, properties } of startupErrors) {
    const child = spawnSync(process.execPath, ["-e", `
      const { EventEmitter } = require("node:events");
      const Module = require("node:module");
      const worker = require(${JSON.stringify(require.resolve("./process.cjs"))});
      process.parentPort = new EventEmitter();
      process.parentPort.postMessage = (message) => {
        if (message.kind === "worker-error") {
          process.stdout.write(JSON.stringify(message) + "\\n");
        }
      };
      const originalLoad = Module._load;
      Module._load = function(request, ...args) {
        if (request === "./terminalDataPipeline.cjs") {
          throw Object.assign(new Error("injected bridge startup failure"), ${JSON.stringify(properties)});
        }
        return originalLoad.call(this, request, ...args);
      };
      // Retain the event loop, as the Electron parent port does in production.
      setTimeout(() => process.exit(0), 200);
      setImmediate(() => worker.main());
    `], { encoding: "utf8", timeout: 5_000 });
    assert.ifError(child.error);
    assert.notEqual(child.status, 0, `${label}: an unusable worker must not survive startup`);
    const report = JSON.parse(child.stdout.trim());
    assert.equal(report.kind, "worker-error");
    assert.match(report.message, /injected bridge startup failure/);
    assert.match(report.reason, /startup/);
  }
});

test("startup rejection terminates a real process even for benign stream errors", () => {
  const child = spawnSync(process.execPath, ["-e", `
    const { installTerminalWorkerErrorGuards } = require(${JSON.stringify(require.resolve("./workerProcessGuards.cjs"))});
    installTerminalWorkerErrorGuards({ isRuntimeStarted: () => false, logError() {} });
    setTimeout(() => process.exit(0), 200);
    Promise.reject(Object.assign(new Error("injected startup rejection"), { code: "EPIPE" }));
  `], { encoding: "utf8", timeout: 5_000 });
  assert.ifError(child.error);
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /injected startup rejection/);
});
