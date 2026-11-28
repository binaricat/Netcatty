"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { BrowserRuntimePool } = require("./browserRuntimePool.cjs");

function createFakeElectron() {
  const createdWindows = [];
  const sessions = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.setWebRTCIPHandlingPolicy = (policy) => { this.webRtcPolicy = policy; };
      this.webContents.setWindowOpenHandler = (handler) => { this.windowOpenHandler = handler; };
      createdWindows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
    }
  }
  const electron = {
    BrowserWindow: FakeWindow,
    session: {
      fromPartition(partition, opts) {
        const sess = new EventEmitter();
        sess.partition = partition;
        sess.opts = opts;
        sess.protocol = { handle() {}, unhandle() {} };
        sess.webRequest = {
          onBeforeRequest(fn) { sess.beforeRequest = fn; },
          onErrorOccurred(fn) { sess.errorOccurred = fn; },
          onCompleted(fn) { sess.completed = fn; },
        };
        sess.setProxy = async (proxy) => { sess.proxy = proxy; };
        sess.enableNetworkEmulation = (emulation) => { sess.networkEmulation = emulation; };
        sess.setPermissionCheckHandler = (fn) => { sess.permissionCheck = fn; };
        sess.setPermissionRequestHandler = (fn) => { sess.permissionRequest = fn; };
        sess.setDevicePermissionHandler = (fn) => { sess.devicePermission = fn; };
        sessions.push(sess);
        return sess;
      },
    },
  };
  return { electron, createdWindows, sessions };
}

test("BrowserRuntimePool creates single-use locked standby windows and blocks all requests until bound", async () => {
  const { electron, createdWindows, sessions } = createFakeElectron();
  let disposedSessions = 0;
  const protocol = {
    registerSession: () => ({ dispose() { disposedSessions += 1; } }),
  };
  const pool = new BrowserRuntimePool({
    electron,
    protocol,
    preloadPath: "/runtime/browserPreload.cjs",
  });
  await pool.warm();
  assert.equal(createdWindows.length, 1);
  assert.equal(sessions.length, 1);
  assert.equal(createdWindows[0].options.webPreferences.sandbox, true);
  assert.equal(createdWindows[0].options.webPreferences.nodeIntegration, false);
  assert.equal(createdWindows[0].options.webPreferences.contextIsolation, true);
  assert.deepEqual(sessions[0].networkEmulation, { offline: true });

  // While standby, EVERY request and navigation is cancelled.
  let cancelled;
  sessions[0].beforeRequest({ url: "netcatty-plugin://any-token/index.html" }, (res) => { cancelled = res.cancel; });
  assert.equal(cancelled, true);
  let navPrevented = false;
  createdWindows[0].webContents.emit("will-navigate", { preventDefault() { navPrevented = true; } }, "netcatty-plugin://any-token/index.html");
  assert.equal(navPrevented, true);

  // Claiming removes it from the pool permanently (single-use).
  const claimed = pool.claim();
  assert.ok(claimed);
  assert.equal(pool.claim(), null);

  // Once bound to a specific runtime token, only that token/URL is permitted.
  claimed.gate.allowedToken = "bound-token";
  claimed.gate.allowedUrl = "netcatty-plugin://bound-token/index.html";
  sessions[0].beforeRequest({ url: "netcatty-plugin://bound-token/index.html" }, (res) => { cancelled = res.cancel; });
  assert.equal(cancelled, false);
  sessions[0].beforeRequest({ url: "netcatty-plugin://other-token/index.html" }, (res) => { cancelled = res.cancel; });
  assert.equal(cancelled, true);
  sessions[0].beforeRequest({ url: "https://example.com/" }, (res) => { cancelled = res.cancel; });
  assert.equal(cancelled, true);

  // Disposing the pool never touches an already-claimed window.
  pool.dispose();
  assert.equal(createdWindows[0].isDestroyed(), false);
  assert.equal(disposedSessions, 0);
});

test("BrowserRuntimePool destroys standby windows on App Lock and shutdown", async () => {
  const { electron, createdWindows } = createFakeElectron();
  let disposedSessions = 0;
  let lockListener = null;
  let locked = false;
  const pool = new BrowserRuntimePool({
    electron,
    protocol: { registerSession: () => ({ dispose() { disposedSessions += 1; } }) },
    preloadPath: "/runtime/browserPreload.cjs",
    isLocked: () => locked,
    subscribeLock: (fn) => { lockListener = fn; return () => { lockListener = null; }; },
  });
  await pool.warm();
  assert.equal(createdWindows.length, 1);
  assert.equal(createdWindows[0].isDestroyed(), false);

  locked = true;
  lockListener({ locked: true });
  assert.equal(createdWindows[0].isDestroyed(), true);
  assert.equal(disposedSessions, 1);

  // Warming while locked does nothing.
  await pool.warm();
  assert.equal(createdWindows.length, 1);

  // Unlock, warm again, then dispose.
  locked = false;
  await pool.warm();
  assert.equal(createdWindows.length, 2);
  pool.dispose();
  assert.equal(createdWindows[1].isDestroyed(), true);
  assert.equal(disposedSessions, 2);
  assert.equal(lockListener, null);
});
