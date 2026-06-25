"use strict";

/**
 * Permission grant pattern matching — shared between main (MCP) and renderer.
 */

function patternMatches(pattern, value) {
  if (typeof pattern !== "string" || pattern.length === 0) return false;
  if (pattern === "*") return true;
  if (typeof value !== "string") return false;

  if (pattern.startsWith("host:")) {
    const hostPattern = pattern.slice("host:".length);
    return globOrRegexMatch(hostPattern, value);
  }

  return globOrRegexMatch(pattern, value);
}

function globOrRegexMatch(pattern, value) {
  if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
    const lastSlash = pattern.lastIndexOf("/");
    const body = pattern.slice(1, lastSlash);
    const flags = pattern.slice(lastSlash + 1);
    try {
      return new RegExp(body, flags).test(value);
    } catch {
      return false;
    }
  }

  if (!pattern.includes("*") && !pattern.includes("?")) {
    return value === pattern;
  }

  // OpenCode Wildcard.match semantics (trailing " *" allows optional args).
  let escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) {
    escaped = `${escaped.slice(0, -3)}( .*)?`;
  }

  return new RegExp(`^${escaped}$`, "s").test(value);
}

function argsPatternMatches(argsPattern, args) {
  if (!argsPattern || typeof argsPattern !== "object") return true;
  if (!args || typeof args !== "object") return false;

  for (const [key, pattern] of Object.entries(argsPattern)) {
    const argValue = args[key];
    if (typeof argValue === "undefined") return false;
    if (!patternMatches(String(pattern), String(argValue))) return false;
  }
  return true;
}

function matchPermissionGrant(rules, ctx) {
  if (!Array.isArray(rules) || rules.length === 0) return null;

  const args = ctx?.args && typeof ctx.args === "object" ? ctx.args : {};

  for (const rule of rules) {
    if (!rule || typeof rule.capabilityId !== "string") continue;

    if (rule.capabilityId !== ctx?.capabilityId) continue;

    if (rule.commandPattern) {
      const command = typeof args.command === "string" ? args.command : "";
      if (!patternMatches(rule.commandPattern, command)) continue;
    }

    if (!argsPatternMatches(rule.argsPattern, args)) continue;

    return rule;
  }

  return null;
}

function sanitizePermissionGrants(raw) {
  if (!Array.isArray(raw)) return [];

  const result = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const capabilityId = typeof entry.capabilityId === "string" ? entry.capabilityId.trim() : "";
    if (!capabilityId) continue;

    const rule = {
      id: typeof entry.id === "string" && entry.id.trim()
        ? entry.id.trim().slice(0, 64)
        : `grant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      capabilityId,
      sessionPattern: typeof entry.sessionPattern === "string" && entry.sessionPattern.trim()
        ? entry.sessionPattern.trim()
        : "*",
      createdAt: typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)
        ? entry.createdAt
        : Date.now(),
    };

    if (typeof entry.commandPattern === "string" && entry.commandPattern.trim()) {
      rule.commandPattern = entry.commandPattern.trim();
    }
    if (entry.argsPattern && typeof entry.argsPattern === "object" && !Array.isArray(entry.argsPattern)) {
      const argsPattern = {};
      for (const [key, value] of Object.entries(entry.argsPattern)) {
        if (typeof value === "string" && value.trim()) {
          argsPattern[key] = value.trim();
        }
      }
      if (Object.keys(argsPattern).length > 0) {
        rule.argsPattern = argsPattern;
      }
    }
    if (typeof entry.note === "string" && entry.note.trim()) {
      rule.note = entry.note.trim().slice(0, 240);
    }

    result.push(rule);
  }

  return result;
}

module.exports = {
  patternMatches,
  matchPermissionGrant,
  sanitizePermissionGrants,
};
