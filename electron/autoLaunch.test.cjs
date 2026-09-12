const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HIDDEN_LAUNCH_ARG,
  isAutoLaunchSupported,
  resolveEffectiveLoginState,
  buildLoginItemQueryOptions,
  getAutoLaunchEnabled,
  setAutoLaunchEnabled,
  wasLaunchedHidden,
  registerHandlers,
} = require("./autoLaunch.cjs");

const EXEC_PATH = "C:\\Netcatty\\Netcatty.exe";

function hiddenLaunchItem(overrides = {}) {
  return { name: "Netcatty", path: EXEC_PATH, args: [HIDDEN_LAUNCH_ARG], scope: "user", enabled: true, ...overrides };
}

test("isAutoLaunchSupported is false when running unpackaged (electron .)", () => {
  assert.equal(isAutoLaunchSupported({ defaultApp: true, platform: "win32" }), false);
  assert.equal(isAutoLaunchSupported({ defaultApp: true, platform: "darwin" }), false);
});

test("isAutoLaunchSupported is true on macOS and Windows when packaged", () => {
  assert.equal(isAutoLaunchSupported({ defaultApp: false, platform: "darwin" }), true);
  assert.equal(isAutoLaunchSupported({ defaultApp: false, platform: "win32" }), true);
});

test("isAutoLaunchSupported is false on Linux — Electron's login-item API is a no-op there", () => {
  assert.equal(isAutoLaunchSupported({ defaultApp: false, platform: "linux" }), false);
});

test("resolveEffectiveLoginState uses the matching launchItems entry's enabled flag on Windows", () => {
  const settings = { openAtLogin: true, launchItems: [hiddenLaunchItem({ enabled: false })] };

  assert.equal(
    resolveEffectiveLoginState(settings, "win32", EXEC_PATH),
    false,
    "Task Manager can disable the specific --hidden entry while openAtLogin stays true",
  );
});

test("resolveEffectiveLoginState reports true when the matching launchItems entry is enabled", () => {
  const settings = { openAtLogin: true, launchItems: [hiddenLaunchItem({ enabled: true })] };

  assert.equal(resolveEffectiveLoginState(settings, "win32", EXEC_PATH), true);
});

test("resolveEffectiveLoginState ignores unrelated launchItems entries (different path or args)", () => {
  const settings = {
    openAtLogin: false,
    launchItems: [
      hiddenLaunchItem({ path: "C:\\Other\\App.exe", enabled: true }),
      hiddenLaunchItem({ args: [], enabled: true }),
    ],
  };

  assert.equal(
    resolveEffectiveLoginState(settings, "win32", EXEC_PATH),
    false,
    "a differently-scoped entry (wrong path or wrong args) must not count as our own registration",
  );
});

test("resolveEffectiveLoginState falls back to openAtLogin when no matching launchItems entry exists", () => {
  assert.equal(resolveEffectiveLoginState({ openAtLogin: true, launchItems: [] }, "win32", EXEC_PATH), true);
  assert.equal(resolveEffectiveLoginState({ openAtLogin: false, launchItems: [] }, "win32", EXEC_PATH), false);
  assert.equal(resolveEffectiveLoginState({ openAtLogin: true }, "win32", EXEC_PATH), true, "no launchItems array at all");
});

test("resolveEffectiveLoginState does not consult launchItems on non-Windows platforms", () => {
  const settings = { openAtLogin: true, launchItems: [hiddenLaunchItem({ enabled: false })] };

  assert.equal(
    resolveEffectiveLoginState(settings, "darwin", EXEC_PATH),
    true,
    "launchItems is Windows-only; macOS must read openAtLogin directly",
  );
});

test("resolveEffectiveLoginState treats a macOS pending-approval registration as enabled", () => {
  const settings = { openAtLogin: false, status: "requires-approval" };

  assert.equal(
    resolveEffectiveLoginState(settings, "darwin", EXEC_PATH),
    true,
    "openAtLogin reports false while SMAppService awaits System Settings approval, even though registration succeeded; " +
      "reporting false here would make the renderer's push effect immediately unregister the pending item",
  );
});

test("resolveEffectiveLoginState ignores the requires-approval special-case on non-macOS platforms", () => {
  const settings = { openAtLogin: false, status: "requires-approval" };

  assert.equal(resolveEffectiveLoginState(settings, "win32", EXEC_PATH), false);
});

test("resolveEffectiveLoginState reads openAtLogin normally for other macOS statuses", () => {
  assert.equal(resolveEffectiveLoginState({ openAtLogin: true, status: "enabled" }, "darwin", EXEC_PATH), true);
  assert.equal(resolveEffectiveLoginState({ openAtLogin: false, status: "not-registered" }, "darwin", EXEC_PATH), false);
  assert.equal(resolveEffectiveLoginState({ openAtLogin: false, status: "not-found" }, "darwin", EXEC_PATH), false);
});

test("buildLoginItemQueryOptions matches the path+args our own writes always register", () => {
  assert.deepEqual(
    buildLoginItemQueryOptions(EXEC_PATH),
    { path: EXEC_PATH, args: [HIDDEN_LAUNCH_ARG] },
  );
});

test("getAutoLaunchEnabled reports unsupported without touching app in dev", () => {
  let called = false;
  const app = { getLoginItemSettings: () => { called = true; return { openAtLogin: true }; } };

  const result = getAutoLaunchEnabled({ app, defaultApp: true, platform: "win32" });

  assert.deepEqual(result, { success: true, enabled: false, supported: false });
  assert.equal(called, false);
});

test("getAutoLaunchEnabled queries the same path+args the login item was registered with", () => {
  let capturedOptions = null;
  const app = {
    getLoginItemSettings: (options) => { capturedOptions = options; return { openAtLogin: true }; },
  };

  getAutoLaunchEnabled({ app, execPath: EXEC_PATH, defaultApp: false, platform: "win32" });

  assert.deepEqual(capturedOptions, { path: EXEC_PATH, args: [HIDDEN_LAUNCH_ARG] });
});

test("getAutoLaunchEnabled reports unsupported on Linux without touching app", () => {
  let called = false;
  const app = { getLoginItemSettings: () => { called = true; return { openAtLogin: true }; } };

  const result = getAutoLaunchEnabled({ app, defaultApp: false, platform: "linux" });

  assert.deepEqual(result, { success: true, enabled: false, supported: false });
  assert.equal(called, false);
});

test("getAutoLaunchEnabled reflects the current login item state on macOS", () => {
  const app = { getLoginItemSettings: () => ({ openAtLogin: true }) };

  const result = getAutoLaunchEnabled({ app, defaultApp: false, platform: "darwin" });

  assert.deepEqual(result, { success: true, enabled: true, supported: true });
});

test("getAutoLaunchEnabled reports disabled when Windows Startup Apps has disabled the matching entry", () => {
  const app = {
    getLoginItemSettings: () => ({ openAtLogin: true, launchItems: [hiddenLaunchItem({ enabled: false })] }),
  };

  const result = getAutoLaunchEnabled({ app, execPath: EXEC_PATH, defaultApp: false, platform: "win32" });

  assert.deepEqual(result, { success: true, enabled: false, supported: true });
});

test("getAutoLaunchEnabled is not fooled by an unrelated no-argument entry for the same executable", () => {
  const app = {
    getLoginItemSettings: () => ({
      openAtLogin: false,
      launchItems: [hiddenLaunchItem({ args: [], enabled: true })],
    }),
  };

  const result = getAutoLaunchEnabled({ app, execPath: EXEC_PATH, defaultApp: false, platform: "win32" });

  assert.deepEqual(
    result,
    { success: true, enabled: false, supported: true },
    "executableWillLaunchAtLogin-style any-args matching would wrongly report true here",
  );
});

test("getAutoLaunchEnabled reports success:false (not a confirmed disabled state) when the app API throws", () => {
  const app = { getLoginItemSettings: () => { throw new Error("boom"); } };

  const result = getAutoLaunchEnabled({ app, defaultApp: false, platform: "win32" });

  assert.deepEqual(
    result,
    { success: false, enabled: false, supported: true },
    "callers (renderer hydration) must be able to tell a transient read failure apart from a confirmed enabled:false, or they will overwrite a cached true and cascade into an unwanted disable write",
  );
});

test("setAutoLaunchEnabled(true) registers the hidden launch arg", () => {
  let capturedSettings = null;
  const app = {
    setLoginItemSettings: (settings) => { capturedSettings = settings; },
    getLoginItemSettings: () => ({ openAtLogin: true, launchItems: [hiddenLaunchItem({ enabled: true })] }),
  };

  const result = setAutoLaunchEnabled(true, {
    app,
    execPath: EXEC_PATH,
    defaultApp: false,
    platform: "win32",
  });

  assert.deepEqual(capturedSettings, {
    openAtLogin: true,
    openAsHidden: true,
    path: EXEC_PATH,
    args: [HIDDEN_LAUNCH_ARG],
  });
  assert.deepEqual(result, { success: true, enabled: true, supported: true });
});

test("setAutoLaunchEnabled(true) verifies with the same path+args it just wrote", () => {
  let capturedQueryOptions = null;
  const app = {
    setLoginItemSettings: () => {},
    getLoginItemSettings: (options) => {
      capturedQueryOptions = options;
      // Electron 42 contract: openAtLogin only reflects true for the exact
      // path+args queried — a bare getLoginItemSettings() call (no args)
      // would incorrectly report false right after enabling with --hidden.
      return options?.args?.includes(HIDDEN_LAUNCH_ARG)
        ? { openAtLogin: true, launchItems: [hiddenLaunchItem({ enabled: true })] }
        : { openAtLogin: false, launchItems: [] };
    },
  };

  const result = setAutoLaunchEnabled(true, {
    app,
    execPath: EXEC_PATH,
    defaultApp: false,
    platform: "win32",
  });

  assert.deepEqual(capturedQueryOptions, { path: EXEC_PATH, args: [HIDDEN_LAUNCH_ARG] });
  assert.equal(result.enabled, true, "must not report false just because the query omitted matching args");
});

test("setAutoLaunchEnabled(true) reports disabled when Windows Startup Apps blocks the matching entry", () => {
  const app = {
    setLoginItemSettings: () => {},
    getLoginItemSettings: () => ({ openAtLogin: true, launchItems: [hiddenLaunchItem({ enabled: false })] }),
  };

  const result = setAutoLaunchEnabled(true, { app, execPath: EXEC_PATH, defaultApp: false, platform: "win32" });

  assert.deepEqual(result, { success: true, enabled: false, supported: true });
});

test("setAutoLaunchEnabled(true) on macOS does not report disabled while approval is pending", () => {
  const app = {
    setLoginItemSettings: () => {},
    getLoginItemSettings: () => ({ openAtLogin: false, status: "requires-approval" }),
  };

  const result = setAutoLaunchEnabled(true, { app, defaultApp: false, platform: "darwin" });

  assert.deepEqual(
    result,
    { success: true, enabled: true, supported: true },
    "must match what the user requested, or the renderer's push effect fires an unregistering write before approval",
  );
});

test("setAutoLaunchEnabled(false) clears the hidden launch arg", () => {
  let capturedSettings = null;
  const app = {
    setLoginItemSettings: (settings) => { capturedSettings = settings; },
    getLoginItemSettings: () => ({ openAtLogin: false, launchItems: [] }),
  };

  const result = setAutoLaunchEnabled(false, { app, defaultApp: false, platform: "win32" });

  assert.deepEqual(capturedSettings.args, []);
  assert.equal(capturedSettings.openAtLogin, false);
  assert.deepEqual(result, { success: true, enabled: false, supported: true });
});

test("setAutoLaunchEnabled is a no-op in dev and does not call the app API", () => {
  let called = false;
  const app = { setLoginItemSettings: () => { called = true; } };

  const result = setAutoLaunchEnabled(true, { app, defaultApp: true, platform: "win32" });

  assert.equal(called, false);
  assert.deepEqual(
    result,
    { success: true, enabled: false, supported: false },
    "enabled:false is a confirmed fact when unsupported, not an unknown state — matches getAutoLaunchEnabled",
  );
});

test("setAutoLaunchEnabled is a no-op on Linux and does not call the app API", () => {
  let called = false;
  const app = { setLoginItemSettings: () => { called = true; } };

  const result = setAutoLaunchEnabled(true, { app, defaultApp: false, platform: "linux" });

  assert.equal(called, false);
  assert.deepEqual(result, { success: true, enabled: false, supported: false });
});

test("setAutoLaunchEnabled reports the real (unwritten) state when the write fails but a fallback read succeeds", () => {
  const app = {
    setLoginItemSettings: () => { throw new Error("registry locked"); },
    getLoginItemSettings: () => ({ openAtLogin: false, launchItems: [] }),
  };

  const result = setAutoLaunchEnabled(true, { app, execPath: EXEC_PATH, defaultApp: false, platform: "win32" });

  assert.deepEqual(
    result,
    { success: true, enabled: false, supported: true },
    "success means \"enabled is trustworthy\", not \"the write succeeded\" — the renderer's push effect relies on " +
      "this to roll an optimistic toggle back to the real state instead of leaving it stuck on a failed write",
  );
});

test("setAutoLaunchEnabled reports success:false only when the write AND the fallback read both fail", () => {
  const app = {
    setLoginItemSettings: () => { throw new Error("registry locked"); },
    getLoginItemSettings: () => { throw new Error("registry unreadable"); },
  };

  const result = setAutoLaunchEnabled(true, { app, defaultApp: false, platform: "win32" });

  assert.deepEqual(
    result,
    { success: false, enabled: false, supported: true },
    "a genuine double failure leaves the real state unknown — the renderer must preserve its last-known value",
  );
});

test("wasLaunchedHidden detects the --hidden cold-start flag", () => {
  assert.equal(wasLaunchedHidden({ argv: ["node", "main.js", "--hidden"], platform: "win32" }), true);
  assert.equal(wasLaunchedHidden({ argv: ["node", "main.js"], platform: "win32" }), false);
  assert.equal(wasLaunchedHidden({ argv: undefined, platform: "win32" }), false);
});

test("wasLaunchedHidden detects a macOS login-item launch via wasOpenedAtLogin", () => {
  const app = { getLoginItemSettings: () => ({ wasOpenedAtLogin: true }) };

  const result = wasLaunchedHidden({ argv: ["node", "main.js"], app, platform: "darwin" });

  assert.equal(
    result,
    true,
    "openAsHidden/wasOpenedAsHidden are deprecated and stop working on macOS 13+, so wasOpenedAtLogin is the only reliable signal",
  );
});

test("wasLaunchedHidden does not consult macOS login-item state on other platforms", () => {
  let called = false;
  const app = { getLoginItemSettings: () => { called = true; return { wasOpenedAtLogin: true }; } };

  const result = wasLaunchedHidden({ argv: ["node", "main.js"], app, platform: "win32" });

  assert.equal(result, false);
  assert.equal(called, false);
});

test("wasLaunchedHidden tolerates a throwing macOS login-item lookup", () => {
  const app = { getLoginItemSettings: () => { throw new Error("boom"); } };

  const result = wasLaunchedHidden({ argv: [], app, platform: "darwin" });

  assert.equal(result, false);
});

test("registerHandlers wires get/set IPC channels", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const app = {
    getLoginItemSettings: () => ({ openAtLogin: false, launchItems: [] }),
    setLoginItemSettings: () => {},
  };

  registerHandlers(ipcMain, { app, platform: "win32" });

  assert.ok(handlers.has("netcatty:autoLaunch:get"));
  assert.ok(handlers.has("netcatty:autoLaunch:set"));

  const getResult = await handlers.get("netcatty:autoLaunch:get")();
  assert.deepEqual(getResult, { success: true, enabled: false, supported: true });

  app.getLoginItemSettings = () => ({ openAtLogin: true, launchItems: [hiddenLaunchItem({ enabled: true })] });
  const setResult = await handlers.get("netcatty:autoLaunch:set")(null, { enabled: true });
  assert.deepEqual(setResult, { success: true, enabled: true, supported: true });
});

test("registerHandlers respects the real process.platform when no override is given", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const app = { getLoginItemSettings: () => ({ openAtLogin: false }) };

  registerHandlers(ipcMain, { app });
  const result = await handlers.get("netcatty:autoLaunch:get")();

  assert.equal(
    result.supported,
    process.platform === "darwin" || process.platform === "win32",
  );
});
