"use strict";

const path = require("node:path");

function buildPythonInvocationArgs(pythonPath, args, platform = process.platform) {
  const basename = path.win32.basename(path.basename(String(pythonPath || "")));
  return platform === "win32" && /^py(?:\.exe)?$/i.test(basename)
    ? ["-3", ...args]
    : args;
}

module.exports = { buildPythonInvocationArgs };
