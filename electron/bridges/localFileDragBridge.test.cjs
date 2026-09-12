const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { validateDragPayload, createLocalFileDragHandlers, createGestureTracker } = require("./localFileDragBridge.cjs");
const tempDirBridge = require("./tempDirBridge.cjs");

function harness(options = {}) {
  const calls = [];
  const sender = { mainFrame: {}, isDestroyed: () => false, startDrag: (item) => calls.push(item) };
  const win = { isDestroyed: () => false, webContents: sender };
  const event = { sender, senderFrame: sender.mainFrame };
  const icon = { isEmpty: () => false };
  const gesture = {};
  const handlers = createLocalFileDragHandlers({
    getWindows: () => [win], getGesture: () => gesture, nativeImage: { createFromBitmap: () => icon }, ...options,
  });
  return { calls, event, handlers, icon };
}

test("drag paths reject malformed requests and handle Windows drives and UNC without trimming names", () => {
  for (const payload of [null, {}, { requestId: "x", paths: [] }, { requestId: "x", paths: ["relative"] },
    { requestId: "x", paths: ["/bad\0file"] }, { requestId: "x", paths: [42] }]) {
    assert.throws(() => validateDragPayload(payload));
  }
  assert.deepEqual(validateDragPayload({ requestId: "x", paths: ["C:/a b/file ", "C:\\a b\\file ", "\\\\server\\share\\folder"] }, path.win32),
    ["C:\\a b\\file ", "\\\\server\\share\\folder"]);
  assert.throws(() => validateDragPayload({ requestId: "x", paths: ["C:relative"] }, path.win32));
  assert.deepEqual(validateDragPayload({ requestId: "x", paths: ["/a/../b", "/b"] }, path.posix), ["/b"]);
  assert.throws(() => validateDragPayload({ requestId: "x", paths: ["/drive-relative"] }, path.win32));
  assert.throws(() => validateDragPayload({ requestId: "x", paths: ["//./pipe/device"] }, path.win32));
});

test("native drag validates every item, supports directories and preserves symlinks", async (t) => {
  tempDirBridge.ensureTempDir();
  const dir = fs.mkdtempSync(tempDirBridge.getTempFilePath("local-drag-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "certificate with spaces.txt");
  const folder = path.join(dir, "folder");
  fs.writeFileSync(file, "original");
  fs.mkdirSync(folder);
  const h = harness();
  assert.deepEqual(await h.handlers.start(h.event, { requestId: "one", paths: [file, folder, file] }), { started: true });
  assert.deepEqual(h.calls[0].files, [file, folder]);
  assert.equal(h.calls[0].icon, h.icon);
  assert.equal(fs.readFileSync(file, "utf8"), "original");
  const result = await h.handlers.start(h.event, { requestId: "two", paths: [file, path.join(dir, "missing")] });
  assert.equal(result.started, false);
  assert.ok(result.error);
  assert.equal(h.calls.length, 1, "a partly valid selection must not start");
  if (process.platform !== "win32") {
    const link = path.join(dir, "link");
    fs.symlinkSync(file, link);
    assert.equal((await h.handlers.start(h.event, { requestId: "link", paths: [link] })).started, true);
    assert.deepEqual(h.calls[1].files, [link]);
    fs.unlinkSync(file);
    assert.equal((await h.handlers.start(h.event, { requestId: "broken", paths: [link] })).started, false);
  }
});

test("unregistered windows and subframes cannot initiate filesystem inspection or drag", async () => {
  let inspected = 0;
  const h = harness({ stat: () => { inspected++; } });
  const payload = { requestId: "id", paths: [path.resolve("file")] };
  assert.equal((await h.handlers.start({ ...h.event, senderFrame: {} }, payload)).started, false);
  assert.equal((await h.handlers.start({ sender: { ...h.event.sender }, senderFrame: h.event.senderFrame }, payload)).started, false);
  assert.equal(inspected, 0);
  assert.equal(h.calls.length, 0);
});

test("mouse release, Escape and replacement gestures cannot start a delayed native drag", async () => {
  const { EventEmitter } = require("node:events");
  const tracker = createGestureTracker();
  let finish;
  const h = harness({ getGesture: tracker.getGesture,
    stat: () => new Promise(resolve => { finish = resolve; }),
  });
  Object.setPrototypeOf(h.event.sender, new EventEmitter());
  tracker.attach(h.event.sender);
  const mouse = type => h.event.sender.emit("before-mouse-event", {}, { type, button: "left" });
  const payload = { requestId: "id", paths: [path.resolve("file")] };
  assert.equal((await h.handlers.start(h.event, payload)).started, false);
  for (const end of [() => mouse("mouseUp"),
    () => h.event.sender.emit("before-input-event", {}, { key: "Escape" }),
    () => mouse("mouseDown"),
    () => h.handlers.cancel(h.event, payload)]) {
    mouse("mouseDown");
    const result = h.handlers.start(h.event, payload);
    end();
    finish({ isFile: () => true });
    assert.equal((await result).started, false);
  }
  assert.equal(h.calls.length, 0);
  mouse("mouseDown");
  const valid = h.handlers.start(h.event, payload);
  finish({ isFile: () => true });
  assert.deepEqual(await valid, { started: true });
  assert.equal(h.calls.length, 1);
});

test("special files, destroyed senders and native errors fail without claiming a completed transfer", async () => {
  const h = harness({ stat: () => ({ isFile: () => false, isDirectory: () => false }) });
  const payload = { requestId: "id", paths: [path.resolve("file")] };
  assert.equal((await h.handlers.start(h.event, payload)).started, false);
  const native = harness({ stat: () => ({ isFile: () => true }) });
  native.event.sender.startDrag = () => { throw new Error("native error"); };
  assert.deepEqual(await native.handlers.start(native.event, payload), { started: false, error: "native error" });
  native.event.sender.isDestroyed = () => true;
  assert.equal((await native.handlers.start(native.event, payload)).started, false);
});
