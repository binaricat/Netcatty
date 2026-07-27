"use strict";

const defaultSpawn = require("cross-spawn");
const { signalAntigravityProcessTree } = require("./sdk/antigravityDriver.cjs");

const MINIMUM_CLI_VERSION = [1, 1, 4];
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 750;

function parseAntigravityCliVersion(output) {
  const match = String(output || "").match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/m);
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

function isSupportedAntigravityCliVersion(version) {
  const parsed = parseAntigravityCliVersion(version);
  if (!parsed) return false;
  const current = parsed.split(".").map(Number);
  for (let index = 0; index < MINIMUM_CLI_VERSION.length; index += 1) {
    if (current[index] > MINIMUM_CLI_VERSION[index]) return true;
    if (current[index] < MINIMUM_CLI_VERSION[index]) return false;
  }
  return true;
}

function unavailable(cliPath, { installed = Boolean(cliPath), cliVersion = null } = {}) {
  return {
    path: cliPath || null,
    binPath: cliPath || null,
    version: cliVersion ? `Antigravity CLI ${cliVersion}` : null,
    cliVersion,
    installed,
    cliReady: false,
    available: false,
    authenticated: false,
    authSource: null,
  };
}

function hasAntigravityCliHelp(help) {
  const text = String(help || "");
  return /--print(?:\s|$)/.test(text)
    && /--print-timeout(?:\s|$)/.test(text)
    && /--dangerously-skip-permissions(?:\s|$)/.test(text)
    && /(?:^|\s)models(?:\s|$)/m.test(text);
}

async function runProbeCommand(cliPath, args, env, deps) {
  const spawn = deps.spawn || defaultSpawn;
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS;
  const killGraceMs = Number.isFinite(deps.killGraceMs) ? deps.killGraceMs : DEFAULT_KILL_GRACE_MS;
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let closed = false;
    let timedOut = false;
    let timeoutTimer = null;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve(result);
    };
    try {
      child = spawn(cliPath, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: true,
      });
    } catch (error) {
      finish({ code: null, stdout, stderr, error });
      return;
    }
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      closed = true;
      if (timedOut) return;
      finish({ code: null, stdout, stderr, error });
    });
    child.once("close", (code) => {
      closed = true;
      if (timedOut) return;
      finish({ code, stdout, stderr, error: null });
    });
    timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      const platform = deps.platform || process.platform;
      const signalProcessTree = deps.signalProcessTree
        || ((target, signal) => signalAntigravityProcessTree(target, signal, deps));
      void Promise.resolve().then(async () => {
        await signalProcessTree(child, "SIGTERM");
        if (platform !== "win32") {
          await new Promise((done) => setTimeout(done, killGraceMs));
          await signalProcessTree(child, "SIGKILL");
        }
      }).catch(() => {}).finally(() => {
        finish({ code: null, stdout, stderr, error: new Error("Antigravity CLI probe timed out") });
      });
    }, timeoutMs);
  });
}

async function probeAntigravityCli(cliPath, env = {}, deps = {}) {
  const normalizedPath = String(cliPath || "").trim();
  if (!normalizedPath) return unavailable(null, { installed: false });
  const versionResult = await runProbeCommand(normalizedPath, ["--version"], env, deps);
  const cliVersion = parseAntigravityCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  const installed = versionResult.error?.code !== "ENOENT";
  if (versionResult.code !== 0 || !cliVersion) return unavailable(normalizedPath, { installed });
  if (!isSupportedAntigravityCliVersion(cliVersion)) return unavailable(normalizedPath, { installed: true, cliVersion });

  const helpResult = await runProbeCommand(normalizedPath, ["--help"], env, deps);
  if (helpResult.code !== 0 || !hasAntigravityCliHelp(`${helpResult.stdout}\n${helpResult.stderr}`)) {
    return unavailable(normalizedPath, { installed: true, cliVersion });
  }
  return {
    path: normalizedPath,
    binPath: normalizedPath,
    version: `Antigravity CLI ${cliVersion}`,
    cliVersion,
    installed: true,
    cliReady: true,
    available: true,
    authenticated: false,
    authSource: null,
  };
}

async function findAntigravityCli(env, deps = {}) {
  if (typeof deps.resolve !== "function") return unavailable(null, { installed: false });
  const probe = deps.probe || ((candidate) => probeAntigravityCli(candidate, env, deps));
  let firstFailure = null;
  for (const command of ["agy", "antigravity"]) {
    const cliPath = await deps.resolve(command, env);
    if (!cliPath) continue;
    const status = await probe(cliPath, env);
    if (status?.available) return status;
    firstFailure ||= status;
  }
  return firstFailure || unavailable(null, { installed: false });
}

module.exports = {
  findAntigravityCli,
  hasAntigravityCliHelp,
  isSupportedAntigravityCliVersion,
  MINIMUM_CLI_VERSION,
  parseAntigravityCliVersion,
  probeAntigravityCli,
};
