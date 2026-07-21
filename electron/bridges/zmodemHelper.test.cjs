const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createZmodemSentry, buildUploadPlan, buildModeRestores, handleUpload, handleDownload } = require("./zmodemHelper.cjs");

const never = () => { throw new Error("resolver should not be called"); };

test("no conflicts: all indices offered, none removed, resolver untouched", async () => {
  const plan = await buildUploadPlan(["a.txt", "b.txt"], [], never);
  assert.deepEqual(plan, { offerIndices: [0, 1], removeIndices: [], aborted: false });
});

test("overwrite a conflict: index both removed and offered", async () => {
  const plan = await buildUploadPlan(["a.txt", "b.txt"], ["b.txt"], async () => ({ action: "overwrite" }));
  assert.deepEqual(plan, { offerIndices: [0, 1], removeIndices: [1], aborted: false });
});

test("skip a conflict: index omitted from offer and remove", async () => {
  const plan = await buildUploadPlan(["a.txt", "b.txt"], ["b.txt"], async () => ({ action: "skip" }));
  assert.deepEqual(plan, { offerIndices: [0], removeIndices: [], aborted: false });
});

test("cancel aborts the whole transfer", async () => {
  const plan = await buildUploadPlan(["a.txt", "b.txt"], ["b.txt"], async () => ({ action: "cancel" }));
  assert.deepEqual(plan, { offerIndices: [], removeIndices: [], aborted: true });
});

test("applyToRest reuses the action and stops prompting", async () => {
  let calls = 0;
  const plan = await buildUploadPlan(["a", "b", "c"], ["a", "b", "c"],
    async () => { calls++; return { action: "overwrite", applyToRest: true }; });
  assert.equal(calls, 1);
  assert.deepEqual(plan, { offerIndices: [0, 1, 2], removeIndices: [0, 1, 2], aborted: false });
});

test("only conflicting files invoke the resolver; order preserved", async () => {
  const seen = [];
  const plan = await buildUploadPlan(["a", "b", "c"], ["b"],
    async (n) => { seen.push(n); return { action: "skip" }; });
  assert.deepEqual(seen, ["b"]);
  assert.deepEqual(plan.offerIndices, [0, 2]);
});

test("duplicate basenames keep independent per-file decisions", async () => {
  // Two different local files share a basename; skip the first, overwrite the second.
  const actions = ["skip", "overwrite"];
  let i = 0;
  const plan = await buildUploadPlan(["x.txt", "x.txt"], ["x.txt"],
    async () => ({ action: actions[i++] }));
  assert.deepEqual(plan, { offerIndices: [1], removeIndices: [1], aborted: false });
});

// Issue #1079: overwriting (rm + rz re-create) drops the original permission
// bits. buildModeRestores resolves which overwritten files to chmod back.

test("buildModeRestores maps overwritten files to their captured modes", () => {
  assert.deepEqual(
    buildModeRestores("/home/u", ["a.sh", "b.txt"], [0], { "a.sh": "755" }),
    [{ path: "/home/u/a.sh", mode: "755" }],
  );
});

test("buildModeRestores skips files whose mode was not captured", () => {
  assert.deepEqual(
    buildModeRestores("/srv", ["a", "b"], [0, 1], { a: "644" }),
    [{ path: "/srv/a", mode: "644" }],
  );
});

test("buildModeRestores strips trailing slashes and dedupes duplicate basenames", () => {
  assert.deepEqual(
    buildModeRestores("/srv//", ["x", "x"], [0, 1], { x: "600" }),
    [{ path: "/srv/x", mode: "600" }],
  );
});

test("queued drag-drop upload keeps temp files until cancel", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-"));
  const tempPath = path.join(tempDir, "upload.txt");
  fs.writeFileSync(tempPath, "payload");

  const sentry = createZmodemSentry({
    sessionId: "session-1",
    onData: () => {},
    writeToRemote: () => true,
    getWebContents: () => null,
  });

  sentry.queueDragDropUpload({
    filePaths: [tempPath],
    remoteNames: ["upload.txt"],
    tempPaths: [tempPath],
  });

  assert.equal(fs.existsSync(tempPath), true);
  sentry.cancel();
  assert.equal(fs.existsSync(tempPath), false);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("queued drag-drop upload interrupts the remote command when cancelled before detect", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-"));
  const tempPath = path.join(tempDir, "upload.txt");
  fs.writeFileSync(tempPath, "payload");
  const writes = [];
  let interrupted = false;

  const sentry = createZmodemSentry({
    sessionId: "session-1",
    onData: () => {},
    writeToRemote: (buf) => {
      writes.push(Buffer.from(buf));
      return true;
    },
    interruptRemote: () => {
      interrupted = true;
    },
    getWebContents: () => null,
    dragDropStartTimeoutMs: 0,
  });

  sentry.queueDragDropUpload({
    filePaths: [tempPath],
    remoteNames: ["upload.txt"],
    tempPaths: [tempPath],
  });
  sentry.cancel();

  assert.equal(fs.existsSync(tempPath), false);
  assert.equal(interrupted, true);
  assert.equal(writes[0].toString("utf8"), "rz\r");
  assert.deepEqual([...writes[1]], [0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18]);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("queued drag-drop upload cleans temp files when rz never starts", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-"));
  const tempPath = path.join(tempDir, "upload.txt");
  fs.writeFileSync(tempPath, "payload");
  const writes = [];

  const sentry = createZmodemSentry({
    sessionId: "session-1",
    onData: () => {},
    writeToRemote: (buf) => {
      writes.push(Buffer.from(buf));
      return true;
    },
    getWebContents: () => null,
    dragDropStartTimeoutMs: 1,
  });

  sentry.queueDragDropUpload({
    filePaths: [tempPath],
    remoteNames: ["upload.txt"],
    tempPaths: [tempPath],
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(tempPath), false);
  assert.equal(writes[0].toString("utf8"), "rz\r");
  assert.deepEqual([...writes[1]], [0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18]);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("queued drag-drop upload rejects a second pending upload", () => {
  const sentry = createZmodemSentry({
    sessionId: "session-1",
    onData: () => {},
    writeToRemote: () => true,
    getWebContents: () => null,
  });

  sentry.queueDragDropUpload({
    filePaths: ["/tmp/first.txt"],
    remoteNames: ["first.txt"],
  });

  assert.throws(
    () => sentry.queueDragDropUpload({
      filePaths: ["/tmp/second.txt"],
      remoteNames: ["second.txt"],
    }),
    /already pending/,
  );
  sentry.cancel({ interrupt: false });
});

test("queued drag-drop upload cleans temp files when command write fails", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-"));
  const firstTempPath = path.join(tempDir, "first.txt");
  const secondTempPath = path.join(tempDir, "second.txt");
  fs.writeFileSync(firstTempPath, "first");
  fs.writeFileSync(secondTempPath, "second");

  const sentry = createZmodemSentry({
    sessionId: "session-1",
    onData: () => {},
    writeToRemote: () => {
      throw new Error("socket closed");
    },
    getWebContents: () => null,
  });

  assert.throws(
    () => sentry.queueDragDropUpload({
      filePaths: [firstTempPath],
      remoteNames: ["first.txt"],
      tempPaths: [firstTempPath],
    }),
    /socket closed/,
  );
  assert.equal(fs.existsSync(firstTempPath), false);

  assert.throws(
    () => sentry.queueDragDropUpload({
      filePaths: [secondTempPath],
      remoteNames: ["second.txt"],
      tempPaths: [secondTempPath],
    }),
    /socket closed/,
  );
  assert.equal(fs.existsSync(secondTempPath), false);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("handleUpload completes when the remote confirms after progress reaches 100 percent", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-"));
  const filePath = path.join(tempDir, "upload.txt");
  fs.writeFileSync(filePath, "payload");
  const events = [];
  let closed = false;
  let endCalled = false;

  const zsession = {
    async send_offer() {
      return {
        send() {},
        async end() {
          endCalled = true;
        },
      };
    },
    async close() {
      closed = true;
    },
  };

  await handleUpload(zsession, {
    sessionId: "session-1",
    getWebContents: () => ({
      isDestroyed: () => false,
      send: (channel, data) => events.push({ channel, data }),
    }),
    takeDragDropUpload: () => ({
      filePaths: [filePath],
      remoteNames: ["upload.txt"],
    }),
  });

  assert.equal(endCalled, true);
  assert.equal(closed, true);
  assert.equal(
    events.some((event) => event.channel === "netcatty:zmodem:progress" && event.data.finalizing === true),
    true,
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("handleUpload progress follows a display rebind during transfer", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-rebind-"));
  const filePath = path.join(tempDir, "upload.txt");
  fs.writeFileSync(filePath, "payload");
  const events = [];
  const contents = {
    home: {
      isDestroyed: () => false,
      send: (channel, data) => events.push({ target: "home", channel, data }),
    },
    popup: {
      isDestroyed: () => false,
      send: (channel, data) => events.push({ target: "popup", channel, data }),
    },
  };
  let target = "home";
  const zsession = {
    async send_offer() {
      return {
        send() { target = "popup"; },
        async end() {},
      };
    },
    async close() {},
  };

  await handleUpload(zsession, {
    sessionId: "session-1",
    getWebContents: () => contents[target],
    takeDragDropUpload: () => ({
      filePaths: [filePath],
      remoteNames: ["upload.txt"],
    }),
  });

  const progressTargets = events
    .filter((event) => event.channel === "netcatty:zmodem:progress")
    .map((event) => event.target);
  assert.equal(progressTargets[0], "home");
  assert.deepEqual(progressTargets.slice(1), ["popup", "popup"]);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("handleUpload uses injected file picker when no drag-drop upload is queued", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-"));
  const filePath = path.join(tempDir, "picker-upload.txt");
  fs.writeFileSync(filePath, "payload");
  let pickerCalled = false;
  let endCalled = false;

  const zsession = {
    async send_offer() {
      return {
        send() {},
        async end() {
          endCalled = true;
        },
      };
    },
    async close() {},
  };

  await handleUpload(zsession, {
    sessionId: "session-1",
    getWebContents: () => ({
      isDestroyed: () => false,
      send() {},
    }),
    selectUploadFiles: async () => {
      pickerCalled = true;
      return { canceled: false, filePaths: [filePath] };
    },
  });

  assert.equal(pickerCalled, true);
  assert.equal(endCalled, true);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("handleDownload uses injected directory picker before accepting remote files", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-download-"));
  let pickerCalled = false;
  const handlers = new Map();
  let startCalled = false;

  const zsession = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    start() {
      startCalled = true;
      setImmediate(() => handlers.get("session_end")?.());
    },
  };

  await handleDownload(zsession, {
    sessionId: "session-1",
    getWebContents: () => ({
      isDestroyed: () => false,
      send() {},
    }),
    selectDownloadDirectory: async () => {
      pickerCalled = true;
      return { canceled: false, filePaths: [tempDir] };
    },
  });

  assert.equal(startCalled, true);
  assert.equal(pickerCalled, true);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("handleUpload times out when the remote never confirms after progress reaches 100 percent", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-"));
  const filePath = path.join(tempDir, "upload.txt");
  fs.writeFileSync(filePath, "payload");
  let releaseEnd;
  const writes = [];
  let timeoutNotified = false;

  const zsession = {
    async send_offer() {
      return {
        send() {},
        end() {
          return new Promise((resolve) => {
            releaseEnd = resolve;
          });
        },
      };
    },
    async close() {},
  };

  const uploadPromise = handleUpload(zsession, {
    sessionId: "session-1",
    getWebContents: () => null,
    writeToRemote: (buf) => {
      writes.push(Buffer.from(buf));
      return true;
    },
    takeDragDropUpload: () => ({
      filePaths: [filePath],
      remoteNames: ["upload.txt"],
    }),
    uploadFileEndTimeoutMs: 10,
    uploadSessionCloseTimeoutMs: 10,
    onUploadTimeout: () => {
      timeoutNotified = true;
    },
  });

  const outcome = await Promise.race([
    uploadPromise.then(
      () => "resolved",
      (err) => String(err.message || err),
    ),
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), 50)),
  ]);

  assert.match(outcome, /Remote did not confirm receiving upload\.txt/);
  assert.equal(timeoutNotified, true);
  assert.deepEqual([...writes[0]], [0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18]);
  releaseEnd();
  await uploadPromise.catch(() => {});
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("handleUpload does not run timeout recovery when the remote rejects the final confirmation", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-"));
  const filePath = path.join(tempDir, "upload.txt");
  fs.writeFileSync(filePath, "payload");
  const writes = [];
  let timeoutNotified = false;

  const zsession = {
    async send_offer() {
      return {
        send() {},
        async end() {
          throw new Error("remote cancelled upload");
        },
      };
    },
    async close() {},
  };

  await assert.rejects(
    handleUpload(zsession, {
      sessionId: "session-1",
      getWebContents: () => null,
      writeToRemote: (buf) => {
        writes.push(Buffer.from(buf));
        return true;
      },
      takeDragDropUpload: () => ({
        filePaths: [filePath],
        remoteNames: ["upload.txt"],
      }),
      uploadFileEndTimeoutMs: 50,
      uploadSessionCloseTimeoutMs: 50,
      onUploadTimeout: () => {
        timeoutNotified = true;
      },
    }),
    /remote cancelled upload/,
  );

  assert.equal(timeoutNotified, false);
  assert.equal(writes.length, 0);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("handleUpload allows a longer final wait after upload backpressure", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-"));
  const filePath = path.join(tempDir, "upload.txt");
  fs.writeFileSync(filePath, "payload");
  let closed = false;

  const zsession = {
    async send_offer() {
      return {
        send() {},
        end() {
          return new Promise((resolve) => setTimeout(resolve, 30));
        },
      };
    },
    async close() {
      closed = true;
    },
  };

  await handleUpload(zsession, {
    sessionId: "session-1",
    getWebContents: () => null,
    writeToRemote: () => true,
    takeDragDropUpload: () => ({
      filePaths: [filePath],
      remoteNames: ["upload.txt"],
    }),
    hasUploadBackpressure: () => true,
    resetUploadBackpressure: () => {},
    uploadFileEndTimeoutMs: 10,
    slowUploadFileEndTimeoutMs: 80,
    uploadSessionCloseTimeoutMs: 10,
  });

  assert.equal(closed, true);
  fs.rmSync(tempDir, { recursive: true, force: true });
});
