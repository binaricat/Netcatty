const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { getReusableMainWindow } = require("./mainWindowReuse.cjs");

test("getReusableMainWindow returns the tracked healthy main window", () => {
  const win = {
    isDestroyed() {
      return false;
    },
    webContents: {
      isCrashed() {
        return false;
      },
    },
  };

  assert.equal(
    getReusableMainWindow({
      getWindowManager: () => ({
        getMainWindow: () => win,
      }),
    }),
    win,
  );
});

test("getReusableMainWindow uses the window manager health check before reusing", () => {
  const checked = [];
  const win = {
    isDestroyed() {
      return false;
    },
    webContents: {
      isCrashed() {
        return false;
      },
    },
  };

  assert.equal(
    getReusableMainWindow({
      getWindowManager: () => ({
        getMainWindow: () => win,
        isWindowUsable(candidate) {
          checked.push(candidate);
          return true;
        },
      }),
    }),
    win,
  );
  assert.deepEqual(checked, [win]);
});

test("getReusableMainWindow ignores windows rejected by the window manager health check", () => {
  const win = {
    isDestroyed() {
      return false;
    },
    webContents: {
      isCrashed() {
        return false;
      },
    },
  };

  assert.equal(
    getReusableMainWindow({
      getWindowManager: () => ({
        getMainWindow: () => win,
        isWindowUsable() {
          return false;
        },
      }),
    }),
    null,
  );
});

test("getReusableMainWindow ignores destroyed windows", () => {
  const win = {
    isDestroyed() {
      return true;
    },
  };

  assert.equal(
    getReusableMainWindow({
      getWindowManager: () => ({
        getMainWindow: () => win,
      }),
    }),
    null,
  );
});

test("getReusableMainWindow destroys and ignores crashed windows", () => {
  const calls = [];
  const win = {
    isDestroyed() {
      return false;
    },
    destroy() {
      calls.push("destroy");
    },
    webContents: {
      isCrashed() {
        return true;
      },
    },
  };

  assert.equal(
    getReusableMainWindow({
      getWindowManager: () => ({
        getMainWindow: () => win,
      }),
      logWarn: (...args) => calls.push(["warn", ...args]),
    }),
    null,
  );
  assert.equal(calls[0][0], "warn");
  assert.deepEqual(calls.slice(1), ["destroy"]);
});

test("getReusableMainWindow returns null when the window manager is unavailable", () => {
  assert.equal(
    getReusableMainWindow({
      getWindowManager: () => {
        throw new Error("not ready");
      },
    }),
    null,
  );
  assert.equal(getReusableMainWindow(), null);
});

test("createAndShowMainWindow reuses a main window before creating another one", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const functionStart = source.indexOf("async function createAndShowMainWindow()");
  const reuseIndex = source.indexOf("const existingWin = getReusableMainWindow", functionStart);
  const createIndex = source.indexOf("mainWindowStartupPromise = (async () =>", functionStart);

  assert.notEqual(functionStart, -1);
  assert.ok(reuseIndex > functionStart);
  assert.ok(createIndex > functionStart);
  assert.ok(reuseIndex < createIndex);
  assert.match(source.slice(reuseIndex, createIndex), /return existingWin;/);
});
