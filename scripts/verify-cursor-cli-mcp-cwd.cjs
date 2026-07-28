#!/usr/bin/env node
"use strict";

/**
 * Local verification: packaged Cursor CLI MCP injection depends on a writable cwd.
 *
 * Proves:
 * 1) mergeWorkspaceMcpJson fails when cwd is "/" (typical Dock/Finder launch)
 * 2) mergeWorkspaceMcpJson succeeds in a writable directory (dev / terminal launch)
 * 3) Packaged Netcatty process cwd differs: launch from "/" vs writable dir
 * 4) Packaged MCP server script path exists under app.asar.unpacked
 *
 * Usage:
 *   node scripts/verify-cursor-cli-mcp-cwd.cjs
 *   node scripts/verify-cursor-cli-mcp-cwd.cjs --skip-app-launch
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  mergeWorkspaceMcpJson,
  resetMcpMergeRefcountsForTests,
  resolveCursorCliWorkspaceCwd,
} = require("../electron/bridges/aiBridge/sdk/cursorCliDriver.cjs");

const SKIP_APP = process.argv.includes("--skip-app-launch");
const APP_BIN = "/Applications/Netcatty.app/Contents/MacOS/Netcatty";
const APP_MCP = "/Applications/Netcatty.app/Contents/Resources/app.asar.unpacked/electron/mcp/netcatty-mcp-server.cjs";
const TEST_DIR = path.join(os.homedir(), "netcatty-cli-cwd-test");
const FAKE_MCP = [{
  name: "netcatty-remote-hosts",
  type: "stdio",
  command: APP_BIN,
  args: [APP_MCP],
  env: [
    { name: "ELECTRON_RUN_AS_NODE", value: "1" },
    { name: "NETCATTY_MCP_PORT", value: "1" },
    { name: "NETCATTY_MCP_TOKEN", value: "verify-token" },
    { name: "NETCATTY_MCP_CHAT_SESSION_ID", value: "verify-chat" },
  ],
}];

const results = [];

function pass(name, detail) {
  results.push({ ok: true, name, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail) {
  results.push({ ok: false, name, detail });
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readProcessCwd(pid) {
  const out = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
  });
  if (out.status !== 0) return null;
  const line = String(out.stdout || "").split("\n").find((l) => l.startsWith("n"));
  return line ? line.slice(1) : null;
}

async function launchAndReadCwd(launchCwd, label) {
  if (!fs.existsSync(APP_BIN)) {
    fail(`app cwd (${label})`, `missing ${APP_BIN}`);
    return null;
  }

  const child = spawn(APP_BIN, [], {
    cwd: launchCwd,
    stdio: "ignore",
    detached: true,
    env: process.env,
  });
  const pid = child.pid;
  child.unref();

  let cwd = null;
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    cwd = readProcessCwd(pid);
    if (cwd) break;
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch { /* already gone */ }
  await sleep(300);
  try {
    process.kill(pid, "SIGKILL");
  } catch { /* ignore */ }

  return cwd;
}

function testMergeRootFails() {
  resetMcpMergeRefcountsForTests();
  try {
    mergeWorkspaceMcpJson("/", FAKE_MCP);
    fail("merge at cwd=/", "expected throw, but merge succeeded");
    try {
      fs.unlinkSync("/.cursor/mcp.json");
    } catch { /* ignore */ }
  } catch (err) {
    pass("merge at cwd=/", `${err.code || "ERR"}: ${err.message}`);
  }
}

function testMergeWritableSucceeds() {
  resetMcpMergeRefcountsForTests();
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const cursorDir = path.join(TEST_DIR, ".cursor");
  const mcpPath = path.join(cursorDir, "mcp.json");
  try {
    fs.rmSync(cursorDir, { recursive: true, force: true });
  } catch { /* ignore */ }

  let handle;
  try {
    handle = mergeWorkspaceMcpJson(TEST_DIR, FAKE_MCP);
  } catch (err) {
    fail("merge in writable cwd", err.message);
    return;
  }

  if (!fs.existsSync(mcpPath)) {
    fail("merge in writable cwd", `missing ${mcpPath}`);
    handle?.restore?.();
    return;
  }

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  } catch (err) {
    fail("merge in writable cwd", `invalid json: ${err.message}`);
    handle?.restore?.();
    return;
  }

  const entry = doc?.mcpServers?.["netcatty-remote-hosts"];
  if (!entry?.command) {
    fail("merge in writable cwd", "netcatty-remote-hosts missing from mcp.json");
  } else {
    pass(
      "merge in writable cwd",
      `wrote ${mcpPath}; command=${entry.command}`,
    );
  }

  handle?.restore?.();
  // After restore of a previously non-existent file, mcp.json should be removed.
  if (fs.existsSync(mcpPath)) {
    fail("restore cleans mcp.json", `${mcpPath} still present after restore`);
  } else {
    pass("restore cleans mcp.json", "removed after turn-end restore");
  }
}

function testMergeFailureIsLoud() {
  const { runCursorCliTurn } = require("../electron/bridges/aiBridge/sdk/cursorCliDriver.cjs");
  const calls = [];
  const emitter = {
    emitError: (message) => calls.push(message),
    emitDone: () => {},
    text: () => {},
    reasoning: () => {},
    reasoningEnd: () => {},
    toolCall: () => {},
    toolResult: () => {},
    sessionId: () => {},
  };
  return runCursorCliTurn({
    prompt: "hi",
    binPath: "/bin/agent",
    cwd: "/",
    chatSessionId: "loud-fail",
    getTempDir: () => path.join(os.tmpdir(), "netcatty-cli-loud-ok"),
    model: "auto",
    env: {},
    permissionMode: "confirm",
    injectedMcpServers: [{ name: "netcatty-remote-hosts", command: "node", args: ["x"] }],
    emitter,
    spawnImpl: () => {
      throw new Error("spawn should not run after MCP merge failure");
    },
    mergeMcp: () => {
      throw new Error("forced merge failure");
    },
  }).then(() => {
    if (calls.length === 1 && /Failed to prepare Netcatty MCP for Cursor CLI/i.test(calls[0])) {
      pass("merge failure is user-visible", calls[0]);
    } else {
      fail("merge failure is user-visible", JSON.stringify(calls));
    }
  });
}

function testPackagedMcpPath() {
  if (fs.existsSync(APP_MCP)) {
    pass("packaged MCP script exists", APP_MCP);
  } else {
    fail("packaged MCP script exists", `missing ${APP_MCP}`);
  }

  // Smoke: Electron binary can at least start the script as node long enough to print env requirement.
  if (!fs.existsSync(APP_BIN)) {
    fail("packaged MCP spawn smoke", `missing ${APP_BIN}`);
    return;
  }
  const smoke = spawnSync(
    APP_BIN,
    [APP_MCP],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        // Intentionally omit NETCATTY_MCP_PORT so server exits quickly with a known message.
      },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  const errText = `${smoke.stderr || ""}${smoke.stdout || ""}`;
  if (/NETCATTY_MCP_PORT not set/i.test(errText)) {
    pass("packaged MCP spawn smoke", "Electron+ELECTRON_RUN_AS_NODE runs mcp server bootstrap");
  } else {
    fail(
      "packaged MCP spawn smoke",
      `unexpected exit=${smoke.status} signal=${smoke.signal} out=${errText.slice(0, 300)}`,
    );
  }
}

async function testAppLaunchCwds() {
  if (SKIP_APP) {
    console.log("SKIP  packaged app cwd probes (--skip-app-launch)");
    return;
  }

  // Ensure no leftover instance steals single-instance lock from a previous Dock launch.
  spawnSync("pkill", ["-x", "Netcatty"], { encoding: "utf8" });
  await sleep(800);

  const fromRoot = await launchAndReadCwd("/", "from /");
  if (fromRoot === "/" || fromRoot === "/System/Volumes/Data") {
    pass("packaged cwd when launched from /", fromRoot);
  } else if (fromRoot == null) {
    fail("packaged cwd when launched from /", "could not read process cwd (app exited early?)");
  } else {
    // Still useful: report actual cwd
    fail("packaged cwd when launched from /", `expected / , got ${fromRoot}`);
  }

  spawnSync("pkill", ["-x", "Netcatty"], { encoding: "utf8" });
  await sleep(800);

  fs.mkdirSync(TEST_DIR, { recursive: true });
  const fromWritable = await launchAndReadCwd(TEST_DIR, "from writable");
  if (fromWritable === TEST_DIR || fromWritable === path.resolve(TEST_DIR)) {
    pass("packaged cwd when launched from writable dir", fromWritable);
  } else if (fromWritable == null) {
    fail("packaged cwd when launched from writable dir", "could not read process cwd");
  } else {
    fail(
      "packaged cwd when launched from writable dir",
      `expected ${TEST_DIR}, got ${fromWritable}`,
    );
  }

  spawnSync("pkill", ["-x", "Netcatty"], { encoding: "utf8" });
}

function testResolveUsesTempOverRoot() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-fix-"));
  try {
    const resolved = resolveCursorCliWorkspaceCwd({
      preferredCwd: "/",
      chatSessionId: "verify-chat",
      getTempDir: () => tempRoot,
    });
    const expected = path.join(tempRoot, "cursor-cli-mcp", "verify-chat");
    if (resolved !== expected) {
      fail("resolveCursorCliWorkspaceCwd", `expected ${expected}, got ${resolved}`);
      return;
    }
    // Merge into the resolved workspace must succeed even when preferred cwd is /.
    resetMcpMergeRefcountsForTests();
    const handle = mergeWorkspaceMcpJson(resolved, FAKE_MCP);
    const mcpPath = path.join(resolved, ".cursor", "mcp.json");
    if (!fs.existsSync(mcpPath)) {
      fail("resolveCursorCliWorkspaceCwd", `missing ${mcpPath}`);
      handle?.restore?.();
      return;
    }
    handle?.restore?.();
    pass("resolveCursorCliWorkspaceCwd", `uses ${resolved} instead of /`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  console.log("=== Cursor CLI MCP cwd verification ===\n");

  testMergeRootFails();
  testMergeWritableSucceeds();
  await testMergeFailureIsLoud();
  testResolveUsesTempOverRoot();
  testPackagedMcpPath();
  await testAppLaunchCwds();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== Summary: ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) {
    console.error("Failed checks:");
    for (const f of failed) console.error(` - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
    return;
  }

  console.log("\nConclusion:");
  console.log("- Finder/Dock cwd=/ cannot host .cursor/mcp.json.");
  console.log("- Fix: Cursor CLI turns use Netcatty temp cursor-cli-mcp/<chatId> workspace.");
  console.log("- Merge failures now error out instead of silently dropping MCP.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
