"use strict";

/**
 * Test-only isolation helper for the AI CLI discovery file.
 *
 * The bridge writes and deletes the file returned by getCliDiscoveryFilePath().
 * With no override that is the INSTALLED app's live
 * `%APPDATA%\netcatty\netcatty-tool-cli\discovery.json`, so a plain `node --test`
 * run used to remove the running app's bridge pointer. Pointing the discovery
 * env var at a throwaway temp file keeps both sides safe.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  getCliDiscoveryFilePath,
  TOOL_CLI_DISCOVERY_ENV_VAR,
} = require("../cli/discoveryPath.cjs");

const tempDirs = new Set();
let exitHookRegistered = false;

function removeAllTempDirs() {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: the process is exiting anyway.
    }
  }
  tempDirs.clear();
}

/** Redirect discovery writes/deletes to a fresh temp file for this process. */
function isolateCliDiscoveryFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cli-discovery-"));
  tempDirs.add(dir);
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.once("exit", removeAllTempDirs);
  }
  const discoveryPath = path.join(dir, "discovery.json");
  process.env[TOOL_CLI_DISCOVERY_ENV_VAR] = discoveryPath;
  return { dir, discoveryPath };
}

/** Resolve the path the installed app would use, ignoring any active override. */
function defaultCliDiscoveryPath() {
  const override = process.env[TOOL_CLI_DISCOVERY_ENV_VAR];
  delete process.env[TOOL_CLI_DISCOVERY_ENV_VAR];
  try {
    return getCliDiscoveryFilePath();
  } finally {
    if (override !== undefined) {
      process.env[TOOL_CLI_DISCOVERY_ENV_VAR] = override;
    }
  }
}

module.exports = { isolateCliDiscoveryFile, defaultCliDiscoveryPath };
