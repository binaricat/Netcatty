const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const OPEN_TERMINAL_PATH_CHANNEL = "netcatty:openTerminalPath";
const OPEN_TERMINAL_PATH_ARG = "--open-terminal-path";

function expandHomePath(targetPath, { osHomedir = os.homedir } = {}) {
  if (!targetPath) return targetPath;
  if (targetPath === "~") return osHomedir();
  if (targetPath.startsWith("~/")) return path.join(osHomedir(), targetPath.slice(2));
  return targetPath;
}

function collectOpenTerminalPathArgs(argv) {
  if (!Array.isArray(argv)) return [];
  const paths = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== "string") continue;

    if (arg === OPEN_TERMINAL_PATH_ARG) {
      const next = argv[index + 1];
      if (typeof next === "string" && next.trim()) {
        paths.push(next);
        index += 1;
      }
      continue;
    }

    const prefix = `${OPEN_TERMINAL_PATH_ARG}=`;
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length);
      if (value.trim()) paths.push(value);
    }
  }

  return paths;
}

function resolveOpenTerminalPath(rawPath, {
  baseDirectory,
  fsModule = fs,
  pathModule = path,
  logWarn = console.warn,
} = {}) {
  if (typeof rawPath !== "string" || !rawPath.trim()) return null;

  try {
    const expanded = expandHomePath(rawPath);
    const resolved = pathModule.isAbsolute(expanded)
      ? pathModule.resolve(expanded)
      : pathModule.resolve(baseDirectory || process.cwd(), expanded);
    const stat = fsModule.statSync(resolved);
    if (stat.isDirectory()) return resolved;
    if (stat.isFile()) return pathModule.dirname(resolved);
    return null;
  } catch (err) {
    logWarn?.("[Main] Ignoring invalid terminal open path:", rawPath, err?.message || err);
    return null;
  }
}

function resolveOpenTerminalPathsFromArgs(argv, options = {}) {
  return collectOpenTerminalPathArgs(argv)
    .map((rawPath) => resolveOpenTerminalPath(rawPath, options))
    .filter(Boolean);
}

module.exports = {
  OPEN_TERMINAL_PATH_ARG,
  OPEN_TERMINAL_PATH_CHANNEL,
  collectOpenTerminalPathArgs,
  expandHomePath,
  resolveOpenTerminalPath,
  resolveOpenTerminalPathsFromArgs,
};
