#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEST_FILE_RE = /\.test\.(?:ts|tsx|cjs|mjs|js)$/;
const EXCLUDED_FILE_RE = /\.(?:live|docker)\.test\.(?:ts|tsx|cjs|mjs|js)$/;
const IGNORED_DIRS = new Set(["node_modules", "dist", "release", ".git"]);

const UNIT_ROOT_DIRS = [
  "application",
  "components",
  "domain",
  "electron",
  "infrastructure",
  "lib",
  "packages",
  "scripts",
];

const UNIT_ROOT_FILES = ["vite.config.test.ts"];

const PLUGIN_RUNTIME_DOMAIN_TESTS = [
  "domain/pluginRuntimePolicy.test.cjs",
  "domain/pluginPermissionDescriptions.test.cjs",
  "domain/pluginThemePack.test.cjs",
  "domain/pluginGitHubRepository.test.cjs",
];

function walkTests(dir, out, excludeDirs = new Set()) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || excludeDirs.has(full)) continue;
      walkTests(full, out, excludeDirs);
    } else if (
      entry.isFile() &&
      TEST_FILE_RE.test(entry.name) &&
      !EXCLUDED_FILE_RE.test(entry.name)
    ) {
      out.push(full);
    }
  }
}

function parseArgs(argv) {
  let suite = "unit";
  let listOnly = false;
  const filters = [];
  const extraNodeTestArgs = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--suite" && argv[i + 1]) {
      suite = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--suite=")) {
      suite = arg.slice("--suite=".length);
    } else if (arg === "--filter" && argv[i + 1]) {
      filters.push(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--filter=")) {
      filters.push(arg.slice("--filter=".length));
    } else if (arg === "--list") {
      listOnly = true;
    } else {
      extraNodeTestArgs.push(arg);
    }
  }

  return { suite, listOnly, filters, extraNodeTestArgs };
}

function discoverFiles(suite) {
  const files = [];
  if (suite === "unit") {
    const excludeDirs = new Set([path.join("electron", "plugins")]);
    for (const root of UNIT_ROOT_DIRS) {
      walkTests(root, files, excludeDirs);
    }
    for (const file of UNIT_ROOT_FILES) {
      if (fs.existsSync(file)) files.push(file);
    }
  } else if (suite === "plugin-runtime") {
    walkTests(path.join("electron", "plugins"), files);
    for (const file of PLUGIN_RUNTIME_DOMAIN_TESTS) {
      if (fs.existsSync(file)) files.push(file);
    }
  } else {
    console.error(`[run-tests] Unknown suite: ${suite}`);
    process.exit(2);
  }

  return Array.from(new Set(files)).sort();
}

const WINDOWS_MAX_CMD_CHARS = 20_000;
const POSIX_MAX_CMD_CHARS = 120_000;
// Conservative per-argument quoting + separator overhead for CreateProcessW.
const ARG_OVERHEAD_CHARS = 3;

export function batchTestFiles(
  files,
  baseArgsLength = 0,
  maxCmdChars = process.platform === "win32" ? WINDOWS_MAX_CMD_CHARS : POSIX_MAX_CMD_CHARS,
) {
  const batches = [];
  let current = [];
  let currentLen = baseArgsLength;

  for (const file of files) {
    const addition = file.length + ARG_OVERHEAD_CHARS;
    if (current.length > 0 && currentLen + addition > maxCmdChars) {
      batches.push(current);
      current = [file];
      currentLen = baseArgsLength + addition;
    } else {
      current.push(file);
      currentLen += addition;
    }
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function main() {
  const { suite, listOnly, filters, extraNodeTestArgs } = parseArgs(process.argv.slice(2));
  let files = discoverFiles(suite);

  if (filters.length > 0) {
    files = files.filter((file) => filters.some((f) => file.includes(f)));
  }

  if (listOnly) {
    for (const file of files) console.log(file);
    process.exit(0);
  }

  if (files.length === 0) {
    console.error(`[run-tests] No test files matched suite="${suite}"`);
    process.exit(1);
  }

  const baseArgs = ["--test"];
  if (suite === "unit") {
    baseArgs.push("--import", "tsx");
  }
  baseArgs.push(...extraNodeTestArgs);

  const baseLength =
    process.execPath.length +
    ARG_OVERHEAD_CHARS +
    baseArgs.reduce((sum, arg) => sum + arg.length + ARG_OVERHEAD_CHARS, 0);

  const batches = batchTestFiles(files, baseLength);
  let exitCode = 0;

  for (const batch of batches) {
    const result = spawnSync(process.execPath, [...baseArgs, ...batch], { stdio: "inherit" });
    if (result.error) {
      console.error(`[run-tests] Failed to spawn test process: ${result.error.message}`);
      process.exit(1);
    }
    if (result.signal) {
      process.kill(process.pid, result.signal);
    }
    if ((result.status ?? 1) !== 0 && exitCode === 0) {
      exitCode = result.status ?? 1;
    }
  }

  process.exit(exitCode);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
