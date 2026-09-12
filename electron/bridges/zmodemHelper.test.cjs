const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createZmodemSentry,
  buildUploadPlan,
  buildModeRestores,
  handleUpload,
  handleDownload,
  waitForWritableDrain,
  createZmodemUploadDrainWaiter,
  UPLOAD_CHUNK_SIZE,
  UPLOAD_DRAIN_TIMEOUT_MS,
} = require("./zmodemHelper.cjs");

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
  assert.equal(writes[0].toString("utf8"), "rz -y\r");
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
  assert.equal(writes[0].toString("utf8"), "rz -y\r");
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

test("handleUpload does not read the next chunk until transport backpressure clears", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-drain-"));
  const filePath = path.join(tempDir, "large-upload.bin");
  fs.writeFileSync(filePath, Buffer.alloc(UPLOAD_CHUNK_SIZE + 1, 0x5a));
  const sentChunkSizes = [];
  const progress = [];
  let releaseFirstDrain;
  const firstDrain = new Promise((resolve) => {
    releaseFirstDrain = resolve;
  });
  let drainCalls = 0;

  const zsession = {
    async send_offer() {
      return {
        send(chunk) {
          sentChunkSizes.push(chunk.byteLength);
        },
        async end() {},
      };
    },
    async close() {},
  };

  const upload = handleUpload(zsession, {
    sessionId: "session-1",
    getWebContents: () => ({
      isDestroyed: () => false,
      send(channel, data) {
        if (channel === "netcatty:zmodem:progress") progress.push(data);
      },
    }),
    takeDragDropUpload: () => ({
      filePaths: [filePath],
      remoteNames: ["large-upload.bin"],
    }),
    async waitForDrain() {
      drainCalls += 1;
      if (drainCalls === 1) await firstDrain;
    },
  });

  while (drainCalls === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(sentChunkSizes, [UPLOAD_CHUNK_SIZE]);
  assert.equal(progress.at(-1).transferred, UPLOAD_CHUNK_SIZE);

  releaseFirstDrain();
  await upload;
  assert.deepEqual(sentChunkSizes, [UPLOAD_CHUNK_SIZE, 1]);
  assert.equal(progress.at(-1).finalizing, true);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("handleUpload throttles progress IPC by default for every transport", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-progress-"));
  const filePath = path.join(tempDir, "large-upload.bin");
  const size = UPLOAD_CHUNK_SIZE + 1;
  fs.writeFileSync(filePath, Buffer.alloc(size, 0x5a));
  const progress = [];
  const originalNow = Date.now;
  Date.now = () => 1000;

  try {
    const zsession = {
      async send_offer() {
        return {
          send() {},
          async end() {},
        };
      },
      async close() {},
    };

    await handleUpload(zsession, {
      sessionId: "session-1",
      getWebContents: () => ({
        isDestroyed: () => false,
        send(channel, data) {
          if (channel === "netcatty:zmodem:progress") progress.push(data);
        },
      }),
      takeDragDropUpload: () => ({
        filePaths: [filePath],
        remoteNames: ["large-upload.bin"],
      }),
    });

    assert.deepEqual(
      progress.map((event) => [event.transferred, Boolean(event.finalizing)]),
      [[0, false], [UPLOAD_CHUNK_SIZE, false], [size, true]],
    );
  } finally {
    Date.now = originalNow;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

test("handleUpload times out when the remote never answers the offer", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-"));
  const filePath = path.join(tempDir, "upload.txt");
  fs.writeFileSync(filePath, "payload");
  const writes = [];
  let timeoutNotified = false;

  // rz died before answering ZFILE: send_offer never resolves. The upload
  // loop must not park here forever — bound it like xfer.end()/close().
  const zsession = {
    send_offer: () => new Promise(() => {}),
    async abort() {},
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
      onUploadTimeout: () => {
        timeoutNotified = true;
      },
    }),
    /Remote did not respond to the offer for upload\.txt/,
  );

  assert.equal(timeoutNotified, true);
  assert.ok(writes.length > 0, "CAN abort bytes were sent to the remote");
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("handleUpload stops an unresolved offer promptly when cancelled", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-"));
  const filePath = path.join(tempDir, "upload.txt");
  fs.writeFileSync(filePath, "payload");
  const controller = new AbortController();

  const upload = handleUpload(
    {
      send_offer: () => new Promise(() => {}),
      async close() {},
    },
    {
      sessionId: "session-1",
      signal: controller.signal,
      getWebContents: () => null,
      takeDragDropUpload: () => ({
        filePaths: [filePath],
        remoteNames: ["upload.txt"],
      }),
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(
    () => upload,
    (err) => err && err.code === "NETCATTY_ZMODEM_CANCELLED",
  );
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("handleUpload does not delete an overwrite target after cancellation", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-cancel-overwrite-"));
  const filePath = path.join(tempDir, "upload.txt");
  fs.writeFileSync(filePath, "payload");
  const controller = new AbortController();
  let removeCalls = 0;
  let sendOfferCalls = 0;
  let releaseDecision;

  const upload = handleUpload(
    {
      send_offer() {
        sendOfferCalls += 1;
        return Promise.reject(new Error("send_offer should not run after cancellation"));
      },
      async close() {},
    },
    {
      sessionId: "session-1",
      signal: controller.signal,
      getWebContents: () => null,
      selectUploadFiles: async () => ({ canceled: false, filePaths: [filePath] }),
      probeReceiveConflicts: async () => ({
        dir: "/home/u",
        existing: ["upload.txt"],
        modes: { "upload.txt": "644" },
      }),
      requestOverwriteDecision: () => new Promise((resolve) => {
        releaseDecision = resolve;
      }),
      removeRemoteFiles: async () => {
        removeCalls += 1;
      },
    },
  );

  while (!releaseDecision) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  releaseDecision({ action: "overwrite", applyToRest: false });
  await assert.rejects(
    () => upload,
    (err) => err && err.code === "NETCATTY_ZMODEM_CANCELLED",
  );
  assert.equal(removeCalls, 0);
  assert.equal(sendOfferCalls, 0);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("handleUpload aborts an in-flight remote overwrite cleanup", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-cancel-remove-"));
  const filePath = path.join(tempDir, "upload.txt");
  fs.writeFileSync(filePath, "payload");
  const controller = new AbortController();
  let releaseRemove;
  let removeSignal;

  const upload = handleUpload(
    {
      async send_offer() {
        throw new Error("send_offer should not run after cancellation");
      },
      async close() {},
    },
    {
      sessionId: "session-1",
      signal: controller.signal,
      getWebContents: () => null,
      selectUploadFiles: async () => ({ canceled: false, filePaths: [filePath] }),
      probeReceiveConflicts: async () => ({ dir: "/home/u", existing: ["upload.txt"] }),
      requestOverwriteDecision: async () => ({ action: "overwrite", applyToRest: false }),
      removeRemoteFiles: (_paths, { signal } = {}) => {
        removeSignal = signal;
        return new Promise((resolve) => { releaseRemove = resolve; });
      },
    },
  );

  while (!releaseRemove) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(
    () => upload,
    (err) => err && err.code === "NETCATTY_ZMODEM_CANCELLED",
  );
  assert.equal(removeSignal, controller.signal);
  assert.equal(removeSignal.aborted, true);
  releaseRemove();
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

// Issue #2863: rz protect/skip must not look like a successful upload.
test("handleUpload fails when the remote skips an offered file", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-"));
  const filePath = path.join(tempDir, "upload.txt");
  fs.writeFileSync(filePath, "payload");
  let closed = false;

  const zsession = {
    async send_offer() {
      return undefined; // ZSKIP / protect mode
    },
    async close() {
      closed = true;
    },
  };

  await assert.rejects(
    handleUpload(zsession, {
      sessionId: "session-1",
      getWebContents: () => null,
      writeToRemote: () => true,
      takeDragDropUpload: () => ({
        filePaths: [filePath],
        remoteNames: ["upload.txt"],
      }),
    }),
    /skipped|not overwritten|protect/i,
  );

  assert.equal(closed, false);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("drag-drop upload relies on rz overwrite without probing, prompting, or pre-deleting", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-"));
  const filePath = path.join(tempDir, "upload.txt");
  fs.writeFileSync(filePath, "payload");
  let probed = false;
  let prompted = false;
  let removed = [];
  let offerNames = [];

  const zsession = {
    async send_offer(params) {
      offerNames.push(params.name);
      return {
        send() {},
        async end() {},
      };
    },
    async close() {},
  };

  await handleUpload(zsession, {
    sessionId: "session-1",
    getWebContents: () => null,
    writeToRemote: () => true,
    takeDragDropUpload: () => ({
      filePaths: [filePath],
      remoteNames: ["upload.txt"],
    }),
    probeReceiveConflicts: async () => {
      probed = true;
      return {
        dir: "/home/u",
        existing: ["upload.txt"],
        modes: { "upload.txt": "644" },
      };
    },
    requestOverwriteDecision: async () => {
      prompted = true;
      return { action: "skip", applyToRest: false };
    },
    removeRemoteFiles: async (paths) => {
      removed.push(...paths);
    },
  });

  assert.equal(probed, false);
  assert.equal(prompted, false);
  assert.deepEqual(removed, []);
  assert.deepEqual(offerNames, ["upload.txt"]);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("drag-drop offers duplicate remote names independently without pre-deleting", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-"));
  const firstPath = path.join(tempDir, "first.txt");
  const secondPath = path.join(tempDir, "second.txt");
  fs.writeFileSync(firstPath, "first");
  fs.writeFileSync(secondPath, "second");
  const offered = [];
  const removed = [];

  const zsession = {
    async send_offer(params) {
      offered.push(params.name);
      return {
        send() {},
        async end() {},
      };
    },
    async close() {},
  };

  await handleUpload(zsession, {
    sessionId: "session-1",
    getWebContents: () => null,
    writeToRemote: () => true,
    takeDragDropUpload: () => ({
      filePaths: [firstPath, secondPath],
      remoteNames: ["x.txt", "x.txt"],
    }),
    probeReceiveConflicts: async () => {
      throw new Error("drag-drop should not probe conflicts");
    },
    requestOverwriteDecision: async () => {
      throw new Error("drag-drop should not prompt for conflicts");
    },
    removeRemoteFiles: async (paths) => {
      removed.push(...paths);
    },
  });

  assert.deepEqual(offered, ["x.txt", "x.txt"]);
  assert.deepEqual(removed, []);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("failed drag-drop offer does not delete any existing conflict targets", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-"));
  const firstPath = path.join(tempDir, "a.txt");
  const secondPath = path.join(tempDir, "b.txt");
  fs.writeFileSync(firstPath, "a");
  fs.writeFileSync(secondPath, "b");
  const removed = [];

  const zsession = {
    async send_offer(params) {
      if (params.name === "a.txt") {
        throw new Error("simulated early failure");
      }
      return {
        send() {},
        async end() {},
      };
    },
    abort() {},
    async close() {},
  };

  await assert.rejects(
    handleUpload(zsession, {
      sessionId: "session-1",
      getWebContents: () => null,
      writeToRemote: () => true,
      takeDragDropUpload: () => ({
        filePaths: [firstPath, secondPath],
        remoteNames: ["a.txt", "b.txt"],
      }),
      probeReceiveConflicts: async () => ({
        dir: "/home/u",
        existing: ["a.txt", "b.txt"],
        modes: { "a.txt": "644", "b.txt": "600" },
      }),
      requestOverwriteDecision: async () => ({ action: "skip", applyToRest: false }),
      removeRemoteFiles: async (paths) => {
        removed.push(...paths);
      },
    }),
    /simulated early failure/,
  );

  assert.deepEqual(removed, []);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("handleUpload restores modes for accepted overwrites before partial ZSKIP failure", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-"));
  const acceptedPath = path.join(tempDir, "a.sh");
  const skippedPath = path.join(tempDir, "b.txt");
  fs.writeFileSync(acceptedPath, "a");
  fs.writeFileSync(skippedPath, "b");
  let offerCount = 0;
  let restored = [];

  const zsession = {
    async send_offer(params) {
      offerCount += 1;
      if (params.name === "b.txt") return undefined;
      return {
        send() {},
        async end() {},
      };
    },
    abort() {},
    async close() {},
  };

  await assert.rejects(
    handleUpload(zsession, {
      sessionId: "session-1",
      getWebContents: () => null,
      writeToRemote: () => true,
      selectUploadFiles: async () => ({
        canceled: false,
        filePaths: [acceptedPath, skippedPath],
      }),
      probeReceiveConflicts: async () => ({
        dir: "/home/u",
        existing: ["a.sh", "b.txt"],
        modes: { "a.sh": "755", "b.txt": "644" },
      }),
      requestOverwriteDecision: async () => ({ action: "overwrite", applyToRest: true }),
      removeRemoteFiles: async () => {},
      restoreRemoteModes: async (entries) => {
        restored = entries;
      },
    }),
    /Remote skipped some files/,
  );

  assert.equal(offerCount, 2);
  assert.deepEqual(restored, [{ path: "/home/u/a.sh", mode: "755" }]);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("mode restore tracks skipped offers by index for duplicate basenames", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-zmodem-"));
  const firstDir = path.join(tempDir, "first");
  const secondDir = path.join(tempDir, "second");
  fs.mkdirSync(firstDir);
  fs.mkdirSync(secondDir);
  const firstPath = path.join(firstDir, "x.txt");
  const secondPath = path.join(secondDir, "x.txt");
  fs.writeFileSync(firstPath, "first");
  fs.writeFileSync(secondPath, "second");
  let offerCount = 0;
  let restored = [];

  const zsession = {
    async send_offer() {
      offerCount += 1;
      // Accept the first duplicate-name offer; ZSKIP the second.
      if (offerCount > 1) return undefined;
      return {
        send() {},
        async end() {},
      };
    },
    abort() {},
    async close() {},
  };

  await assert.rejects(
    handleUpload(zsession, {
      sessionId: "session-1",
      getWebContents: () => null,
      writeToRemote: () => true,
      selectUploadFiles: async () => ({
        canceled: false,
        filePaths: [firstPath, secondPath],
      }),
      probeReceiveConflicts: async () => ({
        dir: "/home/u",
        existing: ["x.txt"],
        modes: { "x.txt": "600" },
      }),
      requestOverwriteDecision: async () => ({ action: "overwrite", applyToRest: true }),
      removeRemoteFiles: async () => {},
      restoreRemoteModes: async (entries) => {
        restored = entries;
      },
    }),
    /Remote skipped some files/,
  );

  assert.equal(offerCount, 2);
  // Filename-based skip filtering would drop this restore; index-based keeps it.
  assert.deepEqual(restored, [{ path: "/home/u/x.txt", mode: "600" }]);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// Issue #2967: large rz uploads must wait for real transport drain, not one
// setImmediate tick. Flooding the SSH channel completes UI progress early,
// drops the session, and leaves a truncated remote file.

test("waitForWritableDrain resolves immediately when the stream does not need drain", async () => {
  const stream = {
    writableNeedDrain: false,
    once() {
      throw new Error("should not wait for drain");
    },
    off() {},
  };
  await waitForWritableDrain(stream);
});

test("waitForWritableDrain waits until the stream emits drain", async () => {
  const listeners = new Map();
  const stream = {
    writableNeedDrain: true,
    once(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
    off(event, cb) {
      const list = listeners.get(event) || [];
      listeners.set(event, list.filter((fn) => fn !== cb));
    },
  };

  let resolved = false;
  const pending = waitForWritableDrain(stream).then(() => {
    resolved = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.equal((listeners.get("drain") || []).length, 1);

  stream.writableNeedDrain = false;
  for (const cb of listeners.get("drain") || []) cb();
  await pending;
  assert.equal(resolved, true);
});

test("waitForWritableDrain rejects when the transport never drains", async () => {
  const listeners = new Map();
  const stream = {
    writableNeedDrain: true,
    once(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
    off(event, cb) {
      const list = listeners.get(event) || [];
      listeners.set(event, list.filter((fn) => fn !== cb));
    },
  };

  await assert.rejects(
    () => waitForWritableDrain(stream, { timeoutMs: 20 }),
    (err) => err && err.code === "NETCATTY_ZMODEM_TIMEOUT",
  );
  assert.equal((listeners.get("drain") || []).length, 0);
});

test("waitForWritableDrain keeps waiting while a slow SSH channel makes progress", async () => {
  const listeners = new Map();
  const stream = {
    writableNeedDrain: true,
    writableLength: 2 * 1024 * 1024,
    pendingChunkLength: 8 * 1024,
    once(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
    off(event, cb) {
      const list = listeners.get(event) || [];
      listeners.set(event, list.filter((fn) => fn !== cb));
    },
  };

  let settled = false;
  const pending = waitForWritableDrain(stream, {
    timeoutMs: 20,
    progressIntervalMs: 5,
    getProgressValue: () => stream.writableLength + stream.pendingChunkLength,
  }).then(() => {
    settled = true;
  });
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    // ssh2 can advance part of its current frame without completing the
    // corresponding Node write, so writableLength remains unchanged.
    stream.pendingChunkLength -= 1024;
  }
  assert.equal(settled, false);

  stream.writableNeedDrain = false;
  for (const cb of listeners.get("drain") || []) cb();
  await pending;
  assert.equal(settled, true);
});

test("waitForWritableDrain rejects when an SSH channel stops making progress", async () => {
  const listeners = new Map();
  const stream = {
    writableNeedDrain: true,
    writableLength: 2 * 1024 * 1024,
    once(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
    off(event, cb) {
      const list = listeners.get(event) || [];
      listeners.set(event, list.filter((fn) => fn !== cb));
    },
  };

  await assert.rejects(
    () => waitForWritableDrain(stream, { timeoutMs: 20, progressIntervalMs: 5 }),
    (err) => err && err.code === "NETCATTY_ZMODEM_TIMEOUT",
  );
});

test("waitForWritableDrain rejects when the transport closes before drain", async () => {
  const listeners = new Map();
  const stream = {
    writableNeedDrain: true,
    once(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
    off(event, cb) {
      const list = listeners.get(event) || [];
      listeners.set(event, list.filter((fn) => fn !== cb));
    },
  };

  const pending = waitForWritableDrain(stream, { timeoutMs: 5_000 });
  await new Promise((resolve) => setImmediate(resolve));
  for (const cb of listeners.get("close") || []) cb();
  await assert.rejects(
    () => pending,
    (err) => err && err.code === "NETCATTY_ZMODEM_TRANSPORT_CLOSED",
  );
  assert.equal((listeners.get("drain") || []).length, 0);
});

test("waitForWritableDrain rejects with the transport error event", async () => {
  const listeners = new Map();
  const stream = {
    writableNeedDrain: true,
    once(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
    off(event, cb) {
      const list = listeners.get(event) || [];
      listeners.set(event, list.filter((fn) => fn !== cb));
    },
  };

  const pending = waitForWritableDrain(stream, { timeoutMs: 5_000 });
  await new Promise((resolve) => setImmediate(resolve));
  const boom = new Error("socket hang up");
  boom.code = "ECONNRESET";
  for (const cb of listeners.get("error") || []) cb(boom);
  await assert.rejects(
    () => pending,
    (err) => err === boom,
  );
});

test("waitForWritableDrain rejects promptly when the transfer AbortSignal aborts", async () => {
  const listeners = new Map();
  const stream = {
    writableNeedDrain: true,
    once(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
    off(event, cb) {
      const list = listeners.get(event) || [];
      listeners.set(event, list.filter((fn) => fn !== cb));
    },
  };
  const controller = new AbortController();

  const pending = waitForWritableDrain(stream, {
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((listeners.get("drain") || []).length, 1);

  controller.abort();
  await assert.rejects(
    () => pending,
    (err) => err && err.code === "NETCATTY_ZMODEM_CANCELLED",
  );
  assert.equal((listeners.get("drain") || []).length, 0);
});

test("createZmodemUploadDrainWaiter waits on transport drain after backpressure", async () => {
  let needsDrain = true;
  let transportWaits = 0;
  let releaseTransport;
  const transportPending = new Promise((resolve) => {
    releaseTransport = resolve;
  });

  const waitForDrain = createZmodemUploadDrainWaiter({
    getNeedsDrain: () => needsDrain,
    clearNeedsDrain: () => {
      needsDrain = false;
    },
    waitForTransportDrain: async () => {
      transportWaits += 1;
      await transportPending;
    },
  });

  let resolved = false;
  const pending = waitForDrain().then(() => {
    resolved = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.equal(transportWaits, 1);
  assert.equal(needsDrain, true);

  releaseTransport();
  await pending;
  assert.equal(resolved, true);
  assert.equal(needsDrain, false);
});

test("createZmodemUploadDrainWaiter recovers remote rz on transport drain timeout", async () => {
  let needsDrain = true;
  let timeoutNotified = false;
  const writes = [];

  const waitForDrain = createZmodemUploadDrainWaiter({
    getNeedsDrain: () => needsDrain,
    clearNeedsDrain: () => {
      needsDrain = false;
    },
    waitForTransportDrain: async () => {
      const err = new Error("Transport drain timeout");
      err.code = "NETCATTY_ZMODEM_TIMEOUT";
      throw err;
    },
    onUploadTimeout: () => {
      timeoutNotified = true;
    },
    writeToRemote: (buf) => {
      writes.push(Buffer.from(buf));
    },
  });

  await assert.rejects(
    () => waitForDrain(),
    (err) => err && err.code === "NETCATTY_ZMODEM_TIMEOUT",
  );

  assert.equal(timeoutNotified, true);
  assert.equal(needsDrain, false);
  assert.deepEqual([...writes[0]], [0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18]);
});

test("createZmodemUploadDrainWaiter rejects on transfer cancel without timeout recovery", async () => {
  let needsDrain = true;
  let timeoutNotified = false;
  let releaseTransport;
  const transportPending = new Promise((resolve) => {
    releaseTransport = resolve;
  });
  const controller = new AbortController();

  const waitForDrain = createZmodemUploadDrainWaiter({
    getNeedsDrain: () => needsDrain,
    clearNeedsDrain: () => {
      needsDrain = false;
    },
    signal: controller.signal,
    waitForTransportDrain: async ({ signal } = {}) => waitForWritableDrain({
      writableNeedDrain: true,
      once(event, cb) {
        if (event === "drain") {
          transportPending.then(() => cb());
        }
      },
      off() {},
    }, { timeoutMs: 60_000, signal }),
    onUploadTimeout: () => {
      timeoutNotified = true;
    },
    writeToRemote: () => {
      throw new Error("cancel must not abort remote via timeout recovery");
    },
  });

  const pending = waitForDrain();
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(
    () => pending,
    (err) => err && err.code === "NETCATTY_ZMODEM_CANCELLED",
  );
  assert.equal(timeoutNotified, false);
  assert.equal(needsDrain, false);
  releaseTransport();
});

test("createZmodemUploadDrainWaiter falls back to a single yield without transport drain", async () => {
  let needsDrain = true;
  const waitForDrain = createZmodemUploadDrainWaiter({
    getNeedsDrain: () => needsDrain,
    clearNeedsDrain: () => {
      needsDrain = false;
    },
  });

  await waitForDrain();
  assert.equal(needsDrain, false);
});
