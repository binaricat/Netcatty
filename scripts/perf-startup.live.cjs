#!/usr/bin/env node
"use strict";

/**
 * Startup performance harness for the real app (not a fixture).
 *
 *   npm run build            # the harness measures the built dist/ bundle
 *   npm run perf:startup -- --runs 10 --hosts 2000
 *
 * Every run launches Electron against an isolated, throwaway profile
 * (--user-data-dir) so the user's own data, sessions and running Netcatty are
 * never touched. ssh:// deep-link registration is disabled in that profile
 * before the first launch, so the dev Electron binary never becomes the OS
 * protocol handler. The app records its own timeline through
 * electron/perfTrace.cjs (NETCATTY_PERF_TRACE=1), writes it as JSON and quits.
 *
 * Options:
 *   --runs N        measured launches (default 10; run 1 is reported as cold)
 *   --hosts N       seed N synthetic SSH hosts before measuring (default 0)
 *   --settle-ms N   wait after renderer-ready before sampling memory (default 3000)
 *   --json          print the summary as JSON instead of a table
 *   --keep-profile  keep the temporary profile for inspection
 *   --profile DIR   reuse (or create) DIR as the profile and keep it, e.g. to
 *                   compare warm V8 code caches across builds
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const tempDirBridge = require("../electron/bridges/tempDirBridge.cjs");
const { applyElectronLaunchEnv } = require("../electron/launchEnv.cjs");

const repoRoot = path.resolve(__dirname, "..");
const HOSTS_STORAGE_KEY = "netcatty_hosts_v1";
const LAUNCH_TIMEOUT_MS = 120_000;

function parseArgs(argv) {
  const options = { runs: 10, hosts: 0, settleMs: 3000, json: false, keepProfile: false, profile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => Number(argv[++index]);
    if (arg === "--runs") options.runs = next();
    else if (arg === "--hosts") options.hosts = next();
    else if (arg === "--settle-ms") options.settleMs = next();
    else if (arg === "--json") options.json = true;
    else if (arg === "--keep-profile") options.keepProfile = true;
    else if (arg === "--profile") options.profile = path.resolve(String(argv[++index] || ""));
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error("--runs must be a positive integer");
  if (!Number.isInteger(options.hosts) || options.hosts < 0) throw new Error("--hosts must be a non-negative integer");
  return options;
}

function electronBinary() {
  // In plain Node, requiring "electron" returns the binary path.
  return require("electron");
}

function launchEnv(extra = {}) {
  const env = applyElectronLaunchEnv(process.env);
  delete env.VITE_DEV_SERVER_URL; // always measure the built app:// bundle
  return { ...env, ...extra };
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(code ?? signal);
    });
  });
}

function launchApp(profileDir, { env, extraArgs = [], logFile }) {
  const child = spawn(electronBinary(), [repoRoot, `--user-data-dir=${profileDir}`, ...extraArgs], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = fs.createWriteStream(logFile, { flags: "a" });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return child;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function cdpEvaluate(webSocketDebuggerUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      socket.close();
      if (message.error || message.result?.exceptionDetails) {
        reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
      } else {
        resolve(message.result?.result?.value);
      }
    });
    socket.addEventListener("error", () => reject(new Error("CDP socket error")));
  });
}

function buildSyntheticHosts(count) {
  const hosts = [];
  for (let index = 0; index < count; index += 1) {
    hosts.push({
      id: `perf-host-${index}`,
      label: `perf-host-${String(index).padStart(5, "0")}`,
      hostname: `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`,
      port: 22,
      username: "perf",
      protocol: "ssh",
      group: `perf-group-${index % 40}`,
      tags: index % 3 === 0 ? ["perf", `tag-${index % 7}`] : [],
      createdAt: 1_700_000_000_000 + index,
    });
  }
  return hosts;
}

async function seedHosts(profileDir, count, logFile) {
  const child = launchApp(profileDir, {
    env: launchEnv(),
    extraArgs: ["--remote-debugging-port=0"],
    logFile,
  });
  try {
    const portFile = path.join(profileDir, "DevToolsActivePort");
    const port = await waitFor(() => {
      try {
        return Number(fs.readFileSync(portFile, "utf8").split("\n")[0]) || null;
      } catch {
        return null;
      }
    }, 60_000, "DevToolsActivePort");
    const page = await waitFor(async () => {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        return targets.find((target) => target.type === "page" && target.url.startsWith("app://netcatty/index.html"));
      } catch {
        return null;
      }
    }, 60_000, "main window target");
    const hostsJson = JSON.stringify(buildSyntheticHosts(count));
    const stored = await cdpEvaluate(page.webSocketDebuggerUrl, `(() => {
      localStorage.setItem(${JSON.stringify(HOSTS_STORAGE_KEY)}, ${JSON.stringify(hostsJson)});
      return JSON.parse(localStorage.getItem(${JSON.stringify(HOSTS_STORAGE_KEY)})).length;
    })()`);
    if (stored !== count) throw new Error(`Seeded ${stored} hosts, expected ${count}`);
    // Let DOM storage commit, then quit gracefully so it is flushed to disk.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    child.kill("SIGTERM");
    await waitForExit(child, 30_000);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

async function measureRun(profileDir, index, options, logFile) {
  const traceFile = path.join(profileDir, `perf-trace-${index}.json`);
  fs.rmSync(traceFile, { force: true });
  const child = launchApp(profileDir, {
    env: launchEnv({
      NETCATTY_PERF_TRACE: "1",
      NETCATTY_PERF_TRACE_FILE: traceFile,
      NETCATTY_PERF_TRACE_EXIT: "1",
      NETCATTY_PERF_TRACE_SETTLE_MS: String(options.settleMs),
    }),
    logFile,
  });
  await waitForExit(child, LAUNCH_TIMEOUT_MS);
  if (!fs.existsSync(traceFile)) throw new Error(`Run ${index}: no trace written (see ${logFile})`);
  return JSON.parse(fs.readFileSync(traceFile, "utf8"));
}

function rendererMark(report, name) {
  return report.renderer?.marks?.find((entry) => entry.name === name)?.at ?? null;
}

function paintAt(report, name) {
  return report.renderer?.paint?.find((entry) => entry.name === name)?.at ?? null;
}

function sinceStart(report, at) {
  return Number.isFinite(at) ? at - report.processStartAt : null;
}

function between(from, to) {
  return Number.isFinite(from) && Number.isFinite(to) ? to - from : null;
}

function summarizeRun(report) {
  const main = report.main || {};
  const processes = Array.isArray(report.processes) ? report.processes : [];
  const workingSetMB = (type) => processes
    .filter((proc) => !type || proc.type === type)
    .reduce((sum, proc) => sum + (proc.workingSetKB || 0), 0) / 1024;
  return {
    "electron boot → main.cjs": sinceStart(report, main["main:entry"]),
    "main.cjs top-level requires": between(main["main:entry"], main["main:modules-loaded"]),
    "app ready": sinceStart(report, main["main:when-ready"]),
    "registerBridges": between(main["main:register-bridges:start"], main["main:register-bridges:end"]),
    "  of which plugin host": between(main["main:plugin-host:start"], main["main:plugin-host:end"]),
    "loadURL called": sinceStart(report, main["main:load-url"]),
    "renderer entry evaluated": sinceStart(report, rendererMark(report, "netcatty:renderer:entry-evaluated")),
    "first contentful paint": sinceStart(report, paintAt(report, "first-contentful-paint")),
    "App mounted": sinceStart(report, rendererMark(report, "netcatty:renderer:app-mounted")),
    "renderer ready": sinceStart(report, rendererMark(report, "netcatty:renderer:ready")),
    "window shown": sinceStart(report, main["main:window-shown"]),
    "memory total (MB)": workingSetMB(),
    "memory renderer (MB)": workingSetMB("Tab"),
    "memory main (MB)": workingSetMB("Browser"),
    "renderer JS heap (MB)": report.renderer?.heap ? report.renderer.heap.usedJSHeapSize / 1048576 : null,
  };
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

function aggregate(summaries) {
  const cold = summaries[0];
  const warm = summaries.slice(1);
  const result = {};
  for (const metric of Object.keys(cold)) {
    const warmValues = warm.map((summary) => summary[metric]);
    result[metric] = {
      cold: cold[metric],
      warmP50: percentile(warmValues, 50),
      warmP90: percentile(warmValues, 90),
    };
  }
  return result;
}

function formatValue(value) {
  return Number.isFinite(value) ? value.toFixed(0).padStart(8) : "       -";
}

function printTable(aggregated, options) {
  console.log(`\nNetcatty startup (${options.runs} runs, ${options.hosts} seeded hosts; ms unless noted)`);
  console.log(`${"metric".padEnd(30)}${"cold".padStart(8)}${"warm p50".padStart(10)}${"warm p90".padStart(10)}`);
  for (const [metric, value] of Object.entries(aggregated)) {
    console.log(`${metric.padEnd(30)}${formatValue(value.cold)}  ${formatValue(value.warmP50)}  ${formatValue(value.warmP90)}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(repoRoot, "dist", "index.html"))) {
    throw new Error("dist/index.html not found. Run `npm run build` first.");
  }
  const profileDir = options.profile
    ? (fs.mkdirSync(options.profile, { recursive: true }), options.profile)
    : fs.mkdtempSync(`${tempDirBridge.getTempFilePath("perf-startup")}-`);
  if (options.profile) options.keepProfile = true;
  const logFile = path.join(profileDir, "electron.log");
  // Keep the throwaway profile from becoming the OS ssh:// / telnet:// handler.
  fs.writeFileSync(path.join(profileDir, "ssh-deep-link-preferences.json"), JSON.stringify({ enabled: false }));
  try {
    if (options.hosts > 0) await seedHosts(profileDir, options.hosts, logFile);
    const summaries = [];
    for (let index = 1; index <= options.runs; index += 1) {
      const report = await measureRun(profileDir, index, options, logFile);
      summaries.push(summarizeRun(report));
      if (!options.json) process.stderr.write(`run ${index}/${options.runs} done\n`);
    }
    const aggregated = aggregate(summaries);
    if (options.json) console.log(JSON.stringify({ options, aggregated, runs: summaries }, null, 2));
    else printTable(aggregated, options);
  } finally {
    if (options.keepProfile) console.error(`Profile kept at ${profileDir}`);
    else fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
