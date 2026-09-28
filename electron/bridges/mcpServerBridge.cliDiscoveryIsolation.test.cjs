"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  isolateCliDiscoveryFile,
  defaultCliDiscoveryPath,
} = require("./cliDiscoveryTestIsolation.cjs");

function loadFreshBridge() {
  const bridgePath = require.resolve("./mcpServerBridge.cjs");
  delete require.cache[bridgePath];
  return require("./mcpServerBridge.cjs");
}

function statSnapshot(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
    };
  } catch {
    return { exists: false };
  }
}

test("bridge write and cleanup never touch the installed app discovery file", async () => {
  // Resolved before isolating: this is the path the installed app really uses.
  const installedPath = defaultCliDiscoveryPath();
  assert.equal(path.basename(path.dirname(installedPath)), "netcatty-tool-cli");
  assert.equal(path.basename(installedPath), "discovery.json");
  const before = statSnapshot(installedPath);

  const isolated = isolateCliDiscoveryFile();
  const bridge = loadFreshBridge();
  bridge.init({ sessions: new Map(), electronModule: null });
  bridge.setPermissionMode("auto");

  const port = await bridge.getOrCreateHost();
  assert.ok(fs.existsSync(isolated.discoveryPath), "discovery file lands in the temp override");
  const written = JSON.parse(fs.readFileSync(isolated.discoveryPath, "utf8"));
  assert.equal(written.port, port);
  assert.ok(written.token);

  bridge.cleanup();
  assert.equal(fs.existsSync(isolated.discoveryPath), false, "cleanup removes the temp override");

  assert.deepEqual(statSnapshot(installedPath), before, "installed discovery file untouched");
});

const repoRoot = path.resolve(__dirname, "../..");
const PREVIOUSLY_DESTRUCTIVE_TEST = "electron/bridges/mcpServerBridge.attachments.test.cjs";
const discoveryPathModule = path.resolve(repoRoot, "electron/cli/discoveryPath.cjs");

/** Resolve the discovery path a child process with `env` would use by default. */
function defaultDiscoveryPathFor(env) {
  const result = spawnSync(
    process.execPath,
    ["-e", `process.stdout.write(require(${JSON.stringify(discoveryPathModule)}).getCliDiscoveryFilePath())`],
    { cwd: repoRoot, env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("running a previously destructive test never touches the installed discovery file", () => {
  // The real path the installed app uses, resolved with no override active.
  const installedPath = defaultCliDiscoveryPath();
  const installedBefore = statSnapshot(installedPath);

  // Give the child a throwaway home and app-data root, then plant a canary at
  // the exact path it would use by default. If the test file stopped isolating,
  // cleanup() would delete this canary. Every variable the default path can
  // derive from is redirected: APPDATA (Windows), XDG_CONFIG_HOME (Linux) and
  // HOME/USERPROFILE, which os.homedir() reads (macOS uses
  // ~/Library/Application Support and ignores the other two).
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-appdata-canary-"));
  const childEnv = {
    ...process.env,
    HOME: fakeRoot,
    USERPROFILE: fakeRoot,
    APPDATA: path.join(fakeRoot, "AppData", "Roaming"),
    XDG_CONFIG_HOME: path.join(fakeRoot, ".config"),
  };
  delete childEnv.NETCATTY_TOOL_CLI_DISCOVERY_FILE;

  try {
    const canaryPath = defaultDiscoveryPathFor(childEnv);
    // The canary must never be written outside the throwaway root: if a
    // platform resolves the default path from something not redirected above,
    // fail here instead of overwriting a running app's discovery pointer.
    const relativeToRoot = path.relative(fakeRoot, canaryPath);
    assert.ok(
      relativeToRoot && !relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot),
      `child discovery path escaped the fake root: ${canaryPath}`,
    );
    assert.notEqual(path.resolve(canaryPath), path.resolve(installedPath));
    fs.mkdirSync(path.dirname(canaryPath), { recursive: true });
    fs.writeFileSync(canaryPath, `${JSON.stringify({ canary: true })}\n`);
    const canaryBefore = statSnapshot(canaryPath);
    assert.ok(fs.existsSync(canaryPath));

    const result = spawnSync(process.execPath, ["--test", PREVIOUSLY_DESTRUCTIVE_TEST], {
      cwd: repoRoot,
      env: childEnv,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    assert.deepEqual(
      statSnapshot(canaryPath),
      canaryBefore,
      "the destructive test file must not reach the app-data discovery path",
    );
    assert.deepEqual(
      statSnapshot(installedPath),
      installedBefore,
      "the installed app discovery file must be untouched",
    );
  } finally {
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  }
});
