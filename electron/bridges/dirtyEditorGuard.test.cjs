const test = require("node:test");
const assert = require("node:assert/strict");

const { queryDirtyEditors } = require("./dirtyEditorGuard.cjs");

/**
 * Minimal ipcMain stand-in. Records on/removeListener so a test can both drive
 * a reply (by invoking the captured listener) and assert the listener was
 * cleaned up afterwards.
 */
function makeIpcMain() {
  const listeners = new Map(); // channel -> Set<fn>
  return {
    on(channel, fn) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(fn);
    },
    removeListener(channel, fn) {
      listeners.get(channel)?.delete(fn);
    },
    emit(channel, evt, payload) {
      for (const fn of listeners.get(channel) || []) fn(evt, payload);
    },
    listenerCount(channel) {
      return listeners.get(channel)?.size ?? 0;
    },
  };
}

/** Fake webContents that records sends and is alive by default. */
function makeWebContents() {
  const sent = [];
  return {
    sent,
    send(channel) {
      sent.push(channel);
    },
    isDestroyed() {
      return false;
    },
    isCrashed() {
      return false;
    },
  };
}

test("resolves true when the renderer reports dirty editors", async () => {
  const ipcMain = makeIpcMain();
  const wc = makeWebContents();

  const promise = queryDirtyEditors(wc, 5000, { ipcMain });
  // The request is sent on the queried webContents.
  assert.deepEqual(wc.sent, ["app:query-dirty-editors"]);
  // Renderer replies from the same webContents.
  ipcMain.emit("app:dirty-editors-result", { sender: wc }, { hasDirty: true });

  assert.equal(await promise, true);
  // Listener was torn down.
  assert.equal(ipcMain.listenerCount("app:dirty-editors-result"), 0);
});

test("resolves false when the renderer reports no dirty editors", async () => {
  const ipcMain = makeIpcMain();
  const wc = makeWebContents();

  const promise = queryDirtyEditors(wc, 5000, { ipcMain });
  ipcMain.emit("app:dirty-editors-result", { sender: wc }, { hasDirty: false });

  assert.equal(await promise, false);
  assert.equal(ipcMain.listenerCount("app:dirty-editors-result"), 0);
});

test("a missing hasDirty payload is treated as not-dirty (fail open)", async () => {
  const ipcMain = makeIpcMain();
  const wc = makeWebContents();

  const promise = queryDirtyEditors(wc, 5000, { ipcMain });
  ipcMain.emit("app:dirty-editors-result", { sender: wc }, undefined);

  assert.equal(await promise, false);
});

test("ignores replies from a different webContents, then times out to false", async () => {
  const ipcMain = makeIpcMain();
  const wc = makeWebContents();
  const otherWc = makeWebContents();

  const originalSetTimeout = global.setTimeout;
  let timeoutFn = null;
  global.setTimeout = (fn) => {
    timeoutFn = fn;
    return { unref() {} };
  };
  try {
    const promise = queryDirtyEditors(wc, 5000, { ipcMain });

    // A rogue reply from another window claims dirty — it must be ignored, and
    // the listener must remain installed (we use .on, not .once).
    ipcMain.emit("app:dirty-editors-result", { sender: otherWc }, { hasDirty: true });
    assert.equal(ipcMain.listenerCount("app:dirty-editors-result"), 1);

    // No real reply ever arrives → the timeout fires and resolves false.
    assert.equal(typeof timeoutFn, "function");
    timeoutFn();
    assert.equal(await promise, false);
    assert.equal(ipcMain.listenerCount("app:dirty-editors-result"), 0);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test("a falsy sender on the reply is rejected (treated as wrong window)", async () => {
  const ipcMain = makeIpcMain();
  const wc = makeWebContents();

  const originalSetTimeout = global.setTimeout;
  let timeoutFn = null;
  global.setTimeout = (fn) => {
    timeoutFn = fn;
    return { unref() {} };
  };
  try {
    const promise = queryDirtyEditors(wc, 5000, { ipcMain });
    ipcMain.emit("app:dirty-editors-result", { sender: null }, { hasDirty: true });
    // Not settled by the anomalous reply.
    assert.equal(ipcMain.listenerCount("app:dirty-editors-result"), 1);
    timeoutFn();
    assert.equal(await promise, false);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test("a late timeout cannot override an already-received reply", async () => {
  const ipcMain = makeIpcMain();
  const wc = makeWebContents();

  const originalSetTimeout = global.setTimeout;
  let timeoutFn = null;
  global.setTimeout = (fn) => {
    timeoutFn = fn;
    return { unref() {} };
  };
  try {
    const promise = queryDirtyEditors(wc, 5000, { ipcMain });
    // Real reply: dirty=true.
    ipcMain.emit("app:dirty-editors-result", { sender: wc }, { hasDirty: true });
    // A stale timeout fires afterwards — it must be a no-op (settled guard).
    timeoutFn();
    assert.equal(await promise, true);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test("resolves false without sending when there is no webContents", async () => {
  const ipcMain = makeIpcMain();
  assert.equal(await queryDirtyEditors(null, 5000, { ipcMain }), false);
  assert.equal(ipcMain.listenerCount("app:dirty-editors-result"), 0);
});

test("resolves false without sending when the webContents is destroyed", async () => {
  const ipcMain = makeIpcMain();
  const wc = {
    sent: [],
    send(channel) {
      this.sent.push(channel);
    },
    isDestroyed() {
      return true;
    },
    isCrashed() {
      return false;
    },
  };
  assert.equal(await queryDirtyEditors(wc, 5000, { ipcMain }), false);
  assert.deepEqual(wc.sent, []);
  assert.equal(ipcMain.listenerCount("app:dirty-editors-result"), 0);
});

test("resolves false without sending when the renderer is crashed", async () => {
  const ipcMain = makeIpcMain();
  const wc = {
    sent: [],
    send(channel) {
      this.sent.push(channel);
    },
    isDestroyed() {
      return false;
    },
    isCrashed() {
      return true;
    },
  };
  assert.equal(await queryDirtyEditors(wc, 5000, { ipcMain }), false);
  assert.deepEqual(wc.sent, []);
});

test("resolves false and tears down when webContents.send throws", async () => {
  const ipcMain = makeIpcMain();
  const wc = {
    send() {
      throw new Error("renderer gone");
    },
    isDestroyed() {
      return false;
    },
    isCrashed() {
      return false;
    },
  };
  assert.equal(await queryDirtyEditors(wc, 5000, { ipcMain }), false);
  // Listener must be removed even on the throw path.
  assert.equal(ipcMain.listenerCount("app:dirty-editors-result"), 0);
});

test("resolves false when no ipcMain can be resolved", async () => {
  // No ipcMain injected and electron isn't loadable in `node --test`, so
  // resolveIpcMain() returns null → fail open.
  const wc = makeWebContents();
  assert.equal(await queryDirtyEditors(wc, 5000), false);
  assert.deepEqual(wc.sent, []);
});
