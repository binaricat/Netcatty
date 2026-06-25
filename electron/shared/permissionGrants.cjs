"use strict";

/**
 * Permission grant pattern matching — shared between main (MCP) and renderer.
 */

function escapeRegex(value) {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

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

  if (!pattern.includes("*")) {
    return value === pattern;
  }

  const parts = pattern.split("*").map(escapeRegex);
  const regex = new RegExp(`^${parts.join(".*")}$`);
  return regex.test(value);
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

function resolveSessionTarget(args, chatSessionId, sessionId) {
  if (args && typeof args.sessionId === "string" && args.sessionId.length > 0) {
    return args.sessionId;
  }
  if (typeof sessionId === "string" && sessionId.length > 0) {
    return sessionId;
  }
  return typeof chatSessionId === "string" ? chatSessionId : "";
}

function resolveHostname(args, hostname) {
  if (typeof hostname === "string" && hostname.length > 0) return hostname;
  if (args && typeof args.hostname === "string") return args.hostname;
  return "";
}

/**
 * @param {Array<{ capabilityId: string; sessionPattern: string; commandPattern?: string; argsPattern?: Record<string, string> }>} rules
 */
function matchPermissionGrant(rules, ctx) {
  if (!Array.isArray(rules) || rules.length === 0) return null;

  const args = ctx?.args && typeof ctx.args === "object" ? ctx.args : {};
  const sessionTarget = resolveSessionTarget(args, ctx?.chatSessionId, ctx?.sessionId);
  const hostname = resolveHostname(args, ctx?.hostname);

  for (const rule of rules) {
    if (!rule || typeof rule.capabilityId !== "string") continue;

    if (rule.capabilityId !== ctx?.capabilityId) continue;

    const sessionPattern = typeof rule.sessionPattern === "string" ? rule.sessionPattern : "*";
    let sessionMatched = false;
    if (sessionPattern.startsWith("host:")) {
      sessionMatched = patternMatches(sessionPattern, hostname);
    } else {
      sessionMatched = patternMatches(sessionPattern, sessionTarget);
    }
    if (!sessionMatched) continue;

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
    const sessionPattern = typeof entry.sessionPattern === "string" ? entry.sessionPattern.trim() : "";
    if (!capabilityId || !sessionPattern) continue;

    const rule = {
      id: typeof entry.id === "string" && entry.id.trim()
        ? entry.id.trim().slice(0, 64)
        : `grant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      capabilityId,
      sessionPattern,
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
