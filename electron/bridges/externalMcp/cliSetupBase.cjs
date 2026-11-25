"use strict";

function loadShellUtils() {
  return require("../ai/shellUtils.cjs");
}

function loadDesktopCliResolver() {
  return require("./desktopCliResolver.cjs");
}

function quoteCommandArg(value) {
  if (typeof value !== "string" || value.length === 0) return '""';
  // Match ExternalMcpCard quoteShellArg so copyable commands stay shell-safe
  // for paths with spaces, quotes, apostrophes, or backslashes.
  if (!/[\s"'\\]/u.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function formatCliCommandText(args, cliPath, defaultCli) {
  const executable = typeof cliPath === "string" && cliPath.trim()
    ? cliPath.trim()
    : defaultCli;
  return [quoteCommandArg(executable), ...args.map(quoteCommandArg)].join(" ");
}

function normalizePathForCompare(value) {
  if (typeof value !== "string") return "";
  let normalized = value.trim().replace(/^["']|["']$/gu, "");
  if (process.platform === "win32") {
    normalized = normalized.replace(/\.cmd$/iu, "");
  }
  return normalized;
}

function pathsMatch(left, right) {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

function extractCommandExecutable(commandText) {
  if (typeof commandText !== "string") return "";
  const trimmed = commandText.trim();
  if (!trimmed) return "";
  // Prefer the last path-like token so env flags before `--` do not confuse matching.
  const dashDashIndex = trimmed.lastIndexOf(" -- ");
  const candidate = dashDashIndex >= 0
    ? trimmed.slice(dashDashIndex + 4).trim()
    : trimmed;
  const match = candidate.match(/("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+)/u);
  if (!match) return candidate;
  // Extra args after the executable mean a different launch command.
  const remainder = candidate.slice(match[0].length).trim();
  if (remainder) return "";
  return match[1];
}

function hasRequiredDiscoveryEnv(entryEnv, discoveryEnv) {
  const required = discoveryEnv && typeof discoveryEnv === "object" ? discoveryEnv : {};
  const keys = Object.keys(required).filter((key) => typeof required[key] === "string" && required[key]);
  if (keys.length === 0) return true;
  if (!entryEnv || typeof entryEnv !== "object") return false;
  return keys.every((key) => String(entryEnv[key] || "") === String(required[key]));
}

function summarizeFailure(result, fallback, defaultMessage = "CLI command failed") {
  return String(result?.stderr || result?.stdout || fallback || defaultMessage).trim();
}

module.exports = {
  loadShellUtils,
  loadDesktopCliResolver,
  quoteCommandArg,
  formatCliCommandText,
  normalizePathForCompare,
  pathsMatch,
  extractCommandExecutable,
  hasRequiredDiscoveryEnv,
  summarizeFailure,
};
