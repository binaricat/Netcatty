const path = require("node:path");
const { execFile: defaultExecFile } = require("node:child_process");

const SYSTEM_AUTH_STATUS_TIMEOUT_MS = 15000;
const SYSTEM_AUTH_VERIFY_TIMEOUT_MS = 120000;
const UNAVAILABLE_ERRORS = new Set([
  "DeviceNotPresent",
  "NotConfiguredForUser",
  "DisabledByPolicy",
  "DeviceBusy",
  "unavailable",
]);
const CANCELLED_ERRORS = new Set([
  "Canceled",
  "cancelled",
  "RetriesExhausted",
]);

function unsupportedStatus() {
  return {
    supported: false,
    available: false,
    platform: "unsupported",
    label: null,
    reason: null,
  };
}

function normalizeSystemAuthStatus(input, platform = "unsupported") {
  if (!input || typeof input !== "object") return unsupportedStatus();
  const normalizedPlatform = platform === "darwin" || platform === "win32" ? platform : "unsupported";
  if (normalizedPlatform === "unsupported") return unsupportedStatus();
  return {
    supported: input.supported === true,
    available: input.available === true,
    platform: normalizedPlatform,
    label: normalizedPlatform === "darwin" ? "Touch ID" : "Windows Hello",
    reason: typeof input.reason === "string" && input.reason ? input.reason : null,
  };
}

function normalizeSystemAuthUnlockResult(input) {
  if (input && typeof input === "object" && input.ok === true) {
    return { ok: true };
  }
  const error = input && typeof input === "object" ? input.error : null;
  if (typeof error === "string") {
    if (CANCELLED_ERRORS.has(error)) return { ok: false, error: "cancelled" };
    if (UNAVAILABLE_ERRORS.has(error)) return { ok: false, error: "unavailable" };
    if (error === "unsupported") return { ok: false, error: "unsupported" };
    if (error === "failed") return { ok: false, error: "failed" };
  }
  return { ok: false, error: "failed" };
}

function parseHelperJson(stdout) {
  try {
    return JSON.parse(String(stdout || "").trim());
  } catch {
    return null;
  }
}

function nativeWindowHandleToDecimal(handle) {
  if (!Buffer.isBuffer(handle) || handle.length === 0) return null;
  let value = 0n;
  const byteCount = Math.min(handle.length, 8);
  for (let index = byteCount - 1; index >= 0; index -= 1) {
    value = (value << 8n) + BigInt(handle[index]);
  }
  return value > 0n ? value.toString(10) : null;
}

function runHelper(execFile, helperPath, args, timeout) {
  return new Promise((resolve) => {
    if (!helperPath) {
      resolve({ ok: false, error: "unavailable" });
      return;
    }
    execFile(helperPath, args, {
      encoding: "utf8",
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, error: "failed" });
        return;
      }
      resolve(parseHelperJson(stdout));
    });
  });
}

function resolveDefaultHelperPath({
  platform = process.platform,
  arch = process.arch,
  isPackaged = false,
  resourcesPath = process.resourcesPath,
} = {}) {
  if (platform !== "win32") return null;
  if (isPackaged) {
    return path.win32.join(resourcesPath, "windowsHello", "NetcattyWindowsHello.exe");
  }
  return path.join(__dirname, "windowsHelloHelper", "build", arch, "NetcattyWindowsHello.exe");
}

function createAppLockSystemAuthBridge({
  platform = process.platform,
  systemPreferences = null,
  execFile = defaultExecFile,
  helperPath = resolveDefaultHelperPath(),
  getNativeWindowHandle = () => null,
} = {}) {
  async function getMacStatus() {
    const canPrompt = typeof systemPreferences?.canPromptTouchID === "function"
      ? systemPreferences.canPromptTouchID()
      : false;
    return normalizeSystemAuthStatus({
      supported: true,
      available: canPrompt === true,
      reason: canPrompt === true ? null : "unavailable",
    }, "darwin");
  }

  async function requestMacUnlock() {
    if (typeof systemPreferences?.promptTouchID !== "function") {
      return { ok: false, error: "unavailable" };
    }
    try {
      await systemPreferences.promptTouchID("Unlock Netcatty");
      return { ok: true };
    } catch (err) {
      // Electron exposes only a localized rejection message here. Since the
      // status check already established availability, a rejected prompt is a
      // user-visible cancellation regardless of system language.
      void err;
      return { ok: false, error: "cancelled" };
    }
  }

  async function getWindowsStatus() {
    const result = await runHelper(execFile, helperPath, ["status"], SYSTEM_AUTH_STATUS_TIMEOUT_MS);
    return normalizeSystemAuthStatus({
      supported: true,
      available: result?.available === true,
      reason: typeof result?.reason === "string" ? result.reason : null,
    }, "win32");
  }

  async function requestWindowsUnlock() {
    const hwnd = nativeWindowHandleToDecimal(getNativeWindowHandle());
    if (!hwnd) return { ok: false, error: "unavailable" };
    const result = await runHelper(
      execFile,
      helperPath,
      ["verify", "--hwnd", hwnd, "--message", "Unlock Netcatty"],
      SYSTEM_AUTH_VERIFY_TIMEOUT_MS,
    );
    return normalizeSystemAuthUnlockResult(result);
  }

  return {
    async getStatus() {
      if (platform === "darwin") return getMacStatus();
      if (platform === "win32") return getWindowsStatus();
      return unsupportedStatus();
    },
    async requestUnlock() {
      if (platform === "darwin") return requestMacUnlock();
      if (platform === "win32") return requestWindowsUnlock();
      return { ok: false, error: "unsupported" };
    },
  };
}

module.exports = {
  createAppLockSystemAuthBridge,
  nativeWindowHandleToDecimal,
  normalizeSystemAuthStatus,
  normalizeSystemAuthUnlockResult,
  resolveDefaultHelperPath,
};
