"use strict";

const os = require("node:os");
const path = require("node:path");

function getCliDiscoveryFilePath() {
  if (process.env.NETCATTY_AI_CLI_DISCOVERY_FILE) {
    return process.env.NETCATTY_AI_CLI_DISCOVERY_FILE;
  }
  return path.join(os.homedir(), ".netcatty", "ai-cli", "discovery.json");
}

module.exports = {
  getCliDiscoveryFilePath,
};
