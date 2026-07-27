"use strict";

const { spawn: defaultSpawn } = require("node:child_process");
const { buildPythonInvocationArgs } = require("./sdk/pythonLauncher.cjs");

const SDK_PROBE = [
  "import importlib.metadata as m, json, os, platform",
  "from google.antigravity import Agent, LocalAgentConfig, types",
  "from google.antigravity.hooks import policy",
  "cloud_auth_source = None",
  "uses_cloud = os.environ.get('GOOGLE_GENAI_USE_VERTEXAI', '').lower() in ('true', '1') or os.environ.get('GOOGLE_GENAI_USE_ENTERPRISE', '').lower() in ('true', '1')",
  "if uses_cloud and os.environ.get('GOOGLE_CLOUD_LOCATION'):",
  "  try:",
  "    import google.auth",
  "    credentials, detected_project = google.auth.default()",
  "    if credentials and (os.environ.get('GOOGLE_CLOUD_PROJECT') or detected_project):",
  "      cloud_auth_source = 'Google Cloud'",
  "  except Exception:",
  "    pass",
  "print(json.dumps({'version': m.version('google-antigravity'), 'pythonVersion': platform.python_version(), 'authSource': cloud_auth_source}))",
].join("\n");
const MINIMUM_SDK_VERSION = [0, 1, 8];
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 750;

function isSupportedAntigravityVersion(version) {
  const parts = String(version || "").match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!parts) return false;
  const current = parts.slice(1).map(Number);
  for (let index = 0; index < MINIMUM_SDK_VERSION.length; index += 1) {
    if (current[index] > MINIMUM_SDK_VERSION[index]) return true;
    if (current[index] < MINIMUM_SDK_VERSION[index]) return false;
  }
  return true;
}

function getAntigravityAuth(env) {
  if (env?.GEMINI_API_KEY) return { authenticated: true, authSource: "GEMINI_API_KEY" };
  return { authenticated: false, authSource: null };
}

async function probeAntigravitySdk(pythonPath, env = {}, deps = {}) {
  const auth = deps.apiKeyPresent
    ? { authenticated: true, authSource: "settings" }
    : getAntigravityAuth(env);
  if (!pythonPath) {
    return {
      path: null,
      binPath: null,
      version: null,
      installed: false,
      sdkReady: false,
      available: false,
      ...auth,
    };
  }
  const spawn = deps.spawn || defaultSpawn;
  return await new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let closed = false;
    let killTimer = null;
    const unavailable = () => ({
      path: pythonPath,
      binPath: pythonPath,
      version: null,
      installed: false,
      sdkReady: false,
      available: false,
      ...auth,
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolve(result);
    };
    const child = spawn(pythonPath, buildPythonInvocationArgs(
      pythonPath,
      ["-c", SDK_PROBE],
      deps.platform,
    ), {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.once("error", () => {
      closed = true;
      finish(unavailable());
    });
    child.once("close", (code) => {
      closed = true;
      if (killTimer) clearTimeout(killTimer);
      if (code !== 0) {
        finish(unavailable());
        return;
      }
      try {
        const info = JSON.parse(stdout.trim());
        const resolvedAuth = !auth.authenticated && info.authSource === "Google Cloud"
          ? { authenticated: true, authSource: "Google Cloud" }
          : auth;
        const sdkReady = isSupportedAntigravityVersion(info.version);
        finish({
          path: pythonPath,
          binPath: pythonPath,
          version: `Antigravity SDK ${info.version} (Python ${info.pythonVersion})`,
          installed: true,
          sdkReady,
          available: sdkReady && resolvedAuth.authenticated,
          ...resolvedAuth,
        });
      } catch {
        finish(unavailable());
      }
    });
    const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS;
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      try { if (!closed) child.kill("SIGTERM"); } catch {}
      const killGraceMs = Number.isFinite(deps.killGraceMs) ? deps.killGraceMs : DEFAULT_KILL_GRACE_MS;
      killTimer = setTimeout(() => {
        try { if (!closed) child.kill("SIGKILL"); } catch {}
      }, killGraceMs);
      killTimer.unref?.();
      finish(unavailable());
    }, timeoutMs);
  });
}

async function findAntigravitySdk(env, deps = {}) {
  const resolve = deps.resolve;
  const probe = deps.probe || ((pythonPath) => probeAntigravitySdk(pythonPath, env));
  const candidates = [];
  const commands = deps.platform === "win32" || (!deps.platform && process.platform === "win32")
    ? ["python3", "python", "py"]
    : ["python3", "python"];
  for (const command of commands) {
    const resolved = await resolve(command, env);
    if (resolved && !candidates.includes(resolved)) candidates.push(resolved);
  }
  let firstResult = null;
  for (const pythonPath of candidates) {
    const result = await probe(pythonPath, env);
    firstResult ||= result;
    if (result.sdkReady) return result;
  }
  return firstResult || {
    path: null,
    binPath: null,
    version: null,
    installed: false,
    sdkReady: false,
    available: false,
    ...getAntigravityAuth(env),
  };
}

module.exports = {
  findAntigravitySdk,
  getAntigravityAuth,
  isSupportedAntigravityVersion,
  probeAntigravitySdk,
  SDK_PROBE,
};
