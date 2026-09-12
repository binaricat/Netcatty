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

test("a successful cold start always marks processErrorController runtime protection usable, hidden or not", () => {
  // hasShownMainWindow (see processErrorGuards.cjs) is a one-way latch: once
  // any completeMainWindowStartup({windowShown:true}) call happens, runtime
  // protection stays active (non-network errors stop being treated as fatal
  // startup failures) for the rest of the process's life. A hidden auto-launch
  // cold start still successfully creates and loads the window — it is a
  // deliberate, completed startup, not a failure — so the success branch must
  // report windowShown:true unconditionally rather than `!startHidden`, or a
  // tray-only session would never leave "strict" mode and any later
  // non-network error would be fatal.
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const functionStart = source.indexOf("async function createAndShowMainWindow()");
  const tryStart = source.indexOf("const win = await createWindow({ startHidden });", functionStart);
  const catchStart = source.indexOf("} catch (err) {", tryStart);
  const finallyStart = source.indexOf("} finally {", catchStart);

  assert.notEqual(functionStart, -1);
  assert.ok(tryStart > functionStart);
  assert.ok(catchStart > tryStart);
  assert.ok(finallyStart > catchStart);

  const successBranch = source.slice(tryStart, catchStart);
  assert.match(
    successBranch,
    /completeMainWindowStartup\(\{\s*windowShown:\s*true\s*\}\)/,
    "success path must not gate windowShown on !startHidden",
  );
  assert.doesNotMatch(successBranch, /windowShown:\s*!startHidden/);

  const catchBranch = source.slice(catchStart, finallyStart);
  assert.match(
    catchBranch,
    /completeMainWindowStartup\(\{\s*windowShown:\s*false\s*\}\)/,
    "a startup failure (createWindow threw) must still leave protection strict",
  );
});

test("foreground-triggered createAndShowMainWindow call sites re-focus after creation", () => {
  // consumeColdStartHiddenLaunch() is a one-time latch consumed by whichever
  // createAndShowMainWindow() call reaches it first, which is not guaranteed
  // to be the default bootstrap call: a genuine second instance or Dock
  // reopen can race ahead of it (arriving after app.whenReady() but before
  // the bootstrap's own await chain gets there). If a foreground-triggered
  // call happens to consume the --hidden flag, it must still end up visible,
  // or a user-initiated relaunch/reopen silently does nothing. The four deep
  // link / open-terminal-path delivery functions already call
  // focusMainWindow() unconditionally after awaiting createAndShowMainWindow()
  // (verified separately by exercising those functions); this test covers
  // the three fire-and-forget call sites that don't await it directly.
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const foregroundCallSites = [
    {
      name: "second-instance / open-terminal-path invalid-path fallback",
      anchor: "Failed to recreate window on open-terminal-path",
    },
    {
      name: "second-instance / plain fallback",
      anchor: "Failed to recreate window on second-instance",
    },
    {
      name: "activate handler (Dock reopen/click)",
      anchor: "Failed to create window on activate",
    },
  ];

  for (const { name, anchor } of foregroundCallSites) {
    const anchorIndex = source.indexOf(anchor);
    assert.notEqual(anchorIndex, -1, `expected to find call site: ${name}`);
    // The .then(() => { focusMainWindow(); }) must appear on the same
    // createAndShowMainWindow() call, i.e. between the nearest preceding
    // "void createAndShowMainWindow()" and this catch handler's error text.
    const callStart = source.lastIndexOf("void createAndShowMainWindow()", anchorIndex);
    assert.ok(callStart > -1 && callStart < anchorIndex, `expected a createAndShowMainWindow() call before: ${name}`);
    const callSlice = source.slice(callStart, anchorIndex);
    assert.match(
      callSlice,
      /\.then\(\(\) => \{\s*focusMainWindow\(\);\s*\}\)/,
      `${name} must re-focus after creation to guarantee visibility regardless of which flag it raced to consume`,
    );
  }
});
