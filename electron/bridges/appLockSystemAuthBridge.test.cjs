const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createAppLockSystemAuthBridge,
  normalizeSystemAuthStatus,
  normalizeSystemAuthUnlockResult,
  resolveDefaultHelperPath,
} = require("./appLockSystemAuthBridge.cjs");

test("normalizes unsupported status", () => {
  assert.deepEqual(normalizeSystemAuthStatus(null), {
    supported: false,
    available: false,
    platform: "unsupported",
    label: null,
    reason: null,
  });
});

test("macOS status and unlock use Touch ID systemPreferences", async () => {
  let promptReason = null;
  const bridge = createAppLockSystemAuthBridge({
    platform: "darwin",
    systemPreferences: {
      canPromptTouchID: () => true,
      promptTouchID: async (reason) => {
        promptReason = reason;
      },
    },
  });

  assert.deepEqual(await bridge.getStatus(), {
    supported: true,
    available: true,
    platform: "darwin",
    label: "Touch ID",
    reason: null,
  });
  assert.deepEqual(await bridge.requestUnlock(), { ok: true });
  assert.equal(promptReason, "Unlock Netcatty");
});

test("macOS cancellation maps to cancelled", async () => {
  const bridge = createAppLockSystemAuthBridge({
    platform: "darwin",
    systemPreferences: {
      canPromptTouchID: () => true,
      promptTouchID: async () => {
        throw new Error("User canceled");
      },
    },
  });

  assert.deepEqual(await bridge.requestUnlock(), { ok: false, error: "cancelled" });
});

test("Windows status and unlock call helper with HWND", async () => {
  const calls = [];
  const bridge = createAppLockSystemAuthBridge({
    platform: "win32",
    helperPath: "C:\\NetcattyWindowsHello.exe",
    getNativeWindowHandle: () => Buffer.from("8877665544332211", "hex"),
    execFile: (file, args, options, callback) => {
      calls.push({ file, args, options });
      const command = args[0];
      const stdout = command === "status"
        ? '{"supported":true,"available":true,"reason":null}'
        : '{"ok":true}';
      callback(null, stdout, "");
    },
  });

  assert.deepEqual(await bridge.getStatus(), {
    supported: true,
    available: true,
    platform: "win32",
    label: "Windows Hello",
    reason: null,
  });
  assert.deepEqual(await bridge.requestUnlock(), { ok: true });
  assert.equal(calls[0].file, "C:\\NetcattyWindowsHello.exe");
  assert.deepEqual(calls[0].args, ["status"]);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.timeout, 15000);
  assert.deepEqual(calls[1].args, ["verify", "--hwnd", "1234605616436508552", "--message", "Unlock Netcatty"]);
  assert.equal(calls[1].options.timeout, 120000);
});

test("Windows dev helper path follows the architecture-specific build output", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalArch = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", { value: "win32" });
  Object.defineProperty(process, "arch", { value: "x64" });

  try {
    const helperPath = resolveDefaultHelperPath({
      isPackaged: false,
      resourcesPath: "C:\\fake-electron-resources",
    });
    assert.match(helperPath, /windowsHelloHelper[\\/]build[\\/]x64[\\/]NetcattyWindowsHello\.exe$/);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
    Object.defineProperty(process, "arch", originalArch);
  }
});

test("Windows packaged helper path uses the app resources directory", () => {
  assert.equal(
    resolveDefaultHelperPath({
      platform: "win32",
      isPackaged: true,
      resourcesPath: "C:\\Netcatty\\resources",
      arch: "x64",
    }),
    "C:\\Netcatty\\resources\\windowsHello\\NetcattyWindowsHello.exe",
  );
});

test("macOS localized prompt rejection maps to cancelled", async () => {
  const bridge = createAppLockSystemAuthBridge({
    platform: "darwin",
    systemPreferences: {
      canPromptTouchID: () => true,
      promptTouchID: async () => {
        throw new Error("用户已取消认证");
      },
    },
  });

  assert.deepEqual(await bridge.requestUnlock(), { ok: false, error: "cancelled" });
});

test("Windows helper maps unavailable and cancelled states", async () => {
  const bridge = createAppLockSystemAuthBridge({
    platform: "win32",
    helperPath: "helper.exe",
    getNativeWindowHandle: () => Buffer.from("0100000000000000", "hex"),
    execFile: (_file, args, _options, callback) => {
      const stdout = args[0] === "status"
        ? '{"supported":true,"available":false,"reason":"DisabledByPolicy"}'
        : '{"ok":false,"error":"RetriesExhausted"}';
      callback(null, stdout, "");
    },
  });

  assert.deepEqual(await bridge.getStatus(), {
    supported: true,
    available: false,
    platform: "win32",
    label: "Windows Hello",
    reason: "DisabledByPolicy",
  });
  assert.deepEqual(await bridge.requestUnlock(), { ok: false, error: "cancelled" });
});

test("Windows helper failure maps to failed", async () => {
  const bridge = createAppLockSystemAuthBridge({
    platform: "win32",
    helperPath: "helper.exe",
    getNativeWindowHandle: () => Buffer.from("0100000000000000", "hex"),
    execFile: (_file, _args, _options, callback) => {
      callback(new Error("boom"), "", "boom");
    },
  });

  assert.deepEqual(await bridge.requestUnlock(), { ok: false, error: "failed" });
});

test("normalizes Windows helper result enums", () => {
  assert.deepEqual(normalizeSystemAuthUnlockResult({ ok: true }), { ok: true });
  assert.deepEqual(normalizeSystemAuthUnlockResult({ ok: false, error: "Canceled" }), { ok: false, error: "cancelled" });
  assert.deepEqual(normalizeSystemAuthUnlockResult({ ok: false, error: "RetriesExhausted" }), { ok: false, error: "cancelled" });
  assert.deepEqual(normalizeSystemAuthUnlockResult({ ok: false, error: "DeviceBusy" }), { ok: false, error: "unavailable" });
  assert.deepEqual(normalizeSystemAuthUnlockResult({ ok: false, error: "NotConfiguredForUser" }), { ok: false, error: "unavailable" });
  assert.deepEqual(normalizeSystemAuthUnlockResult({ ok: false, error: "unexpected" }), { ok: false, error: "failed" });
});
