const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const {
  classifyProcessError,
  createDiagnosticLogger,
  createProcessErrorController,
  installProcessErrorHandlers,
  isNonFatalNetworkError,
} = require("./processErrorGuards.cjs");

test("treats Chromium ERR_NETWORK_CHANGED as non-fatal", () => {
  assert.equal(
    isNonFatalNetworkError(new Error("net::ERR_NETWORK_CHANGED")),
    true,
  );
});

test("treats other Chromium net::ERR_* failures as non-fatal network errors", () => {
  assert.equal(
    isNonFatalNetworkError(new Error("net::ERR_INTERNET_DISCONNECTED")),
    true,
  );
  assert.equal(
    isNonFatalNetworkError(new Error("net::ERR_NAME_NOT_RESOLVED")),
    true,
  );
});

test("treats Node socket error codes as non-fatal network errors", () => {
  const err = new Error("socket reset");
  err.code = "ECONNRESET";
  assert.equal(isNonFatalNetworkError(err), true);

  const dnsErr = new Error("dns failed");
  dnsErr.code = "ENOTFOUND";
  assert.equal(isNonFatalNetworkError(dnsErr), true);
});

test("keeps non-network errors fatal", () => {
  assert.equal(
    isNonFatalNetworkError(new Error("Something else broke")),
    false,
  );
});

test("generic startup exceptions stay fatal before the app is up", () => {
  const result = classifyProcessError(new Error("boom"), {
    runtimeStarted: false,
  });

  assert.equal(result.action, "fatal");
});

test("generic runtime exceptions are suppressed after startup", () => {
  const result = classifyProcessError(new Error("boom"), {
    runtimeStarted: true,
  });

  assert.equal(result.action, "suppress");
  assert.match(result.reason, /runtime/i);
});

test("generic runtime promise rejections are also suppressed after startup", () => {
  const result = classifyProcessError(new Error("promise boom"), {
    runtimeStarted: true,
    origin: "unhandledRejection",
  });

  assert.equal(result.action, "suppress");
  assert.match(result.reason, /runtime/i);
});

test("controller keeps startup strict until the main window is actually shown", () => {
  const controller = createProcessErrorController();

  controller.beginMainWindowStartup();
  assert.equal(controller.isRuntimeProtectionActive(), false);

  controller.completeMainWindowStartup({ windowShown: true });
  assert.equal(controller.isRuntimeProtectionActive(), true);
});

test("controller becomes strict again while recreating a missing main window", () => {
  const controller = createProcessErrorController();

  controller.beginMainWindowStartup();
  controller.completeMainWindowStartup({ windowShown: true });
  assert.equal(controller.isRuntimeProtectionActive(), true);

  controller.beginMainWindowStartup();
  assert.equal(controller.isRuntimeProtectionActive(), false);

  controller.completeMainWindowStartup({ windowShown: false });
  assert.equal(controller.isRuntimeProtectionActive(), true);
});

test("startup-period errors stay fatal while recreating the main window", () => {
  const fakeProcess = new EventEmitter();
  const fatals = [];
  const controller = createProcessErrorController({
    captureError() {},
    onFatalError(err) {
      fatals.push(err.message);
      throw err;
    },
    logError() {},
    logWarn() {},
  });

  installProcessErrorHandlers(fakeProcess, controller);
  controller.completeMainWindowStartup({ windowShown: true });
  controller.beginMainWindowStartup();

  assert.throws(() => {
    fakeProcess.emit("uncaughtException", new Error("recreate boom"));
  }, /recreate boom/);
  assert.deepEqual(fatals, ["recreate boom"]);
});

test("fatal startup failures uninstall listeners and keep throwing", () => {
  const fakeProcess = new EventEmitter();
  const captured = [];
  const fatals = [];
  let uninstall = null;
  const controller = createProcessErrorController({
    captureError(source, err) {
      captured.push([source, err.message]);
    },
    onFatalError(err) {
      fatals.push(err.message);
      uninstall?.();
      throw err;
    },
    logError() {},
    logWarn() {},
  });

  uninstall = installProcessErrorHandlers(fakeProcess, controller);

  assert.throws(() => {
    fakeProcess.emit("uncaughtException", new Error("startup boom"));
  }, /startup boom/);
  assert.deepEqual(fatals, ["startup boom"]);
  assert.deepEqual(captured, [["uncaughtException", "startup boom"]]);
  assert.equal(fakeProcess.listenerCount("uncaughtException"), 0);
  assert.equal(fakeProcess.listenerCount("unhandledRejection"), 0);
});

test("installed handlers suppress runtime failures after startup", () => {
  const fakeProcess = new EventEmitter();
  const captured = [];
  const errors = [];
  const warnings = [];
  const controller = createProcessErrorController({
    captureError(source, err) {
      captured.push([source, err.message]);
    },
    onFatalError(err) {
      throw err;
    },
    logError(...args) {
      errors.push(args.map(String).join(" "));
    },
    logWarn(...args) {
      warnings.push(args.map(String).join(" "));
    },
  });

  installProcessErrorHandlers(fakeProcess, controller);

  controller.beginMainWindowStartup();
  controller.completeMainWindowStartup({ windowShown: true });

  fakeProcess.emit("uncaughtException", new Error("runtime boom"));
  fakeProcess.emit("unhandledRejection", new Error("runtime rejection"));
  assert.deepEqual(captured, [
    ["uncaughtException", "runtime boom"],
    ["unhandledRejection", "runtime rejection"],
  ]);
  assert.equal(errors.some((line) => line.includes("runtime error after startup")), true);
  assert.equal(warnings.length, 0);
});

test("unhandled rejection marks the forwarded error so uncaught follow-up is not double-captured", () => {
  const captured = [];
  const fatals = [];
  const controller = createProcessErrorController({
    captureError(source, err) {
      captured.push([source, err.message]);
    },
    onFatalError(err) {
      fatals.push(err);
    },
    logError() {},
    logWarn() {},
  });

  controller.handleUnhandledRejection(new Error("startup rejection"));
  assert.equal(fatals.length, 1);
  assert.equal(fatals[0].__fromUnhandledRejection, true);
  assert.deepEqual(captured, [["unhandledRejection", "startup rejection"]]);

  controller.handleUncaughtException(fatals[0]);
  assert.deepEqual(captured, [["unhandledRejection", "startup rejection"]]);
});

test("benign stream teardown errors are ignored by the installed handlers", () => {
  const fakeProcess = new EventEmitter();
  let captureCount = 0;
  let fatalCount = 0;
  const controller = createProcessErrorController({
    captureError() {
      captureCount += 1;
    },
    onFatalError() {
      fatalCount += 1;
    },
    logError() {},
    logWarn() {},
  });

  installProcessErrorHandlers(fakeProcess, controller);
  const err = new Error("broken pipe");
  err.code = "EPIPE";
  fakeProcess.emit("uncaughtException", err);

  assert.equal(captureCount, 0);
  assert.equal(fatalCount, 0);
});

test("controller suppresses wrapped network errors from err.cause", () => {
  const err = new Error("request failed");
  err.cause = new Error("net::ERR_NETWORK_CHANGED");

  const result = classifyProcessError(err, {
    runtimeStarted: false,
  });

  assert.equal(isNonFatalNetworkError(err), true);
  assert.equal(result.action, "suppress");
});

test("controller suppresses ssh-style errors with a level property", () => {
  const err = new Error("connection lost before handshake");
  err.level = "client-socket";

  const result = classifyProcessError(err, {
    runtimeStarted: false,
  });

  assert.equal(isNonFatalNetworkError(err), true);
  assert.equal(result.action, "suppress");
});

test("diagnostic logger drops lines once the sink reports an error", () => {
  const sink = new EventEmitter();
  const written = [];
  const log = createDiagnosticLogger(
    (...args) => written.push(args),
    { streams: [sink] },
  );

  log("first");
  sink.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  log("second");

  assert.deepEqual(written, [["first"]]);
});

test("diagnostic logger forwards only the first sink error to onError", () => {
  const sink = new EventEmitter();
  const reports = [];
  createDiagnosticLogger(
    () => {},
    { streams: [sink], onError: (err) => reports.push(err) },
  );

  const first = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  sink.emit("error", first);
  sink.emit("error", Object.assign(new Error("write EPIPE again"), { code: "EPIPE" }));

  assert.deepEqual(reports, [first]);
});

test("diagnostic logger latches before forwarding the sink error", () => {
  const sink = new EventEmitter();
  let attempts = 0;
  let log = null;
  log = createDiagnosticLogger(
    () => {
      attempts += 1;
    },
    { streams: [sink], onError: () => log("logged from the reporter") },
  );

  sink.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

  assert.equal(attempts, 0, "the reporter must not write through the failed sink");
});

test("diagnostic logger keeps a throwing onError from escaping", () => {
  const sink = new EventEmitter();
  const written = [];
  const log = createDiagnosticLogger(
    (...args) => written.push(args),
    {
      streams: [sink],
      onError() {
        throw new Error("reporter is dead");
      },
    },
  );

  assert.doesNotThrow(() => sink.emit("error", new Error("write EPIPE")));
  log("after failure");
  assert.deepEqual(written, []);
});

test("a closed stdout pipe is reported once so the failure reaches the crash log", async () => {
  const child = spawn(process.execPath, ["-e", `
    const { createDiagnosticLogger } = require(${JSON.stringify(require.resolve("./processErrorGuards.cjs"))});
    let reports = 0;
    const log = createDiagnosticLogger(
      (...args) => console.error(...args),
      {
        streams: [process.stdout, process.stderr],
        onError() { reports += 1; },
      },
    );
    setTimeout(() => {
      log("diagnostic after the pipe closed");
      log("second diagnostic after the pipe closed");
      setTimeout(() => process.exit(reports), 200);
    }, 200);
    setTimeout(() => process.exit(reports), 3000);
  `], { stdio: ["ignore", "pipe", "pipe"] });

  child.stdout.destroy();
  child.stderr.destroy();
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));

  assert.equal(exitCode, 1, "exactly one report for the first sink failure");
});

test("diagnostic logger latches closed when the sink throws synchronously", () => {
  let attempts = 0;
  const log = createDiagnosticLogger(() => {
    attempts += 1;
    throw Object.assign(new Error("write EIO"), { code: "EIO" });
  });

  assert.doesNotThrow(() => log("boom"));
  assert.doesNotThrow(() => log("boom again"));
  assert.equal(attempts, 1);
});

test("diagnostic logger dispose releases the sink listeners", () => {
  const sink = new EventEmitter();
  const log = createDiagnosticLogger(() => {}, { streams: [sink] });

  assert.equal(sink.listenerCount("error"), 1);
  log.dispose();
  assert.equal(sink.listenerCount("error"), 0);
});

test("a broken diagnostic sink still lets runtime errors be captured", () => {
  const captured = [];
  const controller = createProcessErrorController({
    captureError(source, err) {
      captured.push([source, err.message]);
    },
    onFatalError(err) {
      throw err;
    },
    logError: createDiagnosticLogger(() => {
      throw Object.assign(new Error("write EIO"), { code: "EIO" });
    }),
    logWarn: createDiagnosticLogger(() => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    }),
  });
  controller.beginMainWindowStartup();
  controller.completeMainWindowStartup({ windowShown: true });

  assert.doesNotThrow(() => controller.handleUncaughtException(new Error("runtime boom")));
  assert.deepEqual(captured, [["uncaughtException", "runtime boom"]]);
});
