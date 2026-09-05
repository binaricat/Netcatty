"use strict";

const TABLE = require("./commandBlocklist.json");

const COMMON_PATTERNS = [...TABLE.common];
const POSIX_NATIVE_PATTERNS = [...TABLE.posixNative];
const POSIX_PATTERNS = [...TABLE.posix];
const POWERSHELL_PATTERNS = [...TABLE.powershell];
const PATTERN_GROUPS = {
  common: COMMON_PATTERNS,
  posixNative: POSIX_NATIVE_PATTERNS,
  posix: POSIX_PATTERNS,
  powershell: POWERSHELL_PATTERNS,
};

/** Flat union of every default pattern: the strictest selection. */
const DEFAULT_COMMAND_BLOCKLIST = [
  ...COMMON_PATTERNS,
  ...POSIX_NATIVE_PATTERNS,
  ...POSIX_PATTERNS,
  ...POWERSHELL_PATTERNS,
];

const DEFAULT_PATTERN_SET = new Set(DEFAULT_COMMAND_BLOCKLIST);

/**
 * Shell kinds as produced by lib/localShell.cjs / session shell detection.
 * Unknown / empty kinds intentionally fall back to the full list so callers
 * that cannot classify a session keep today's strict behavior.
 */
function selectDefaultBlocklistPatterns(shellKind) {
  const groupNames = TABLE.shellGroups[String(shellKind || "").toLowerCase()];
  return Array.isArray(groupNames)
    ? groupNames.flatMap((name) => PATTERN_GROUPS[name] || [])
    : [...DEFAULT_COMMAND_BLOCKLIST];
}

function isDefaultBlocklistPattern(pattern) {
  return DEFAULT_PATTERN_SET.has(pattern);
}

module.exports = DEFAULT_COMMAND_BLOCKLIST;
module.exports.DEFAULT_COMMAND_BLOCKLIST = DEFAULT_COMMAND_BLOCKLIST;
module.exports.COMMON_PATTERNS = COMMON_PATTERNS;
module.exports.POSIX_NATIVE_PATTERNS = POSIX_NATIVE_PATTERNS;
module.exports.POSIX_PATTERNS = POSIX_PATTERNS;
module.exports.POWERSHELL_PATTERNS = POWERSHELL_PATTERNS;
module.exports.DEFAULT_PATTERN_SET = DEFAULT_PATTERN_SET;
module.exports.selectDefaultBlocklistPatterns = selectDefaultBlocklistPatterns;
module.exports.isDefaultBlocklistPattern = isDefaultBlocklistPattern;
