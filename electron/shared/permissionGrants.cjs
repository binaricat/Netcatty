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

const CWD_COMMANDS = new Set([
  "cd",
  "chdir",
  "popd",
  "pushd",
  "push-location",
  "set-location",
]);

function unquoteShellToken(token) {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === "\"" || first === "'") && first === last) {
      return token.slice(1, -1);
    }
  }
  return token;
}

function tokenizeShellCommand(command) {
  const matches = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return matches.map(unquoteShellToken);
}

function lastNonWhitespaceChar(value) {
  return value.match(/\S(?=\s*$)/)?.[0];
}

function readArithmeticExpansionEnd(segment, startIndex) {
  if (segment[startIndex] !== "$" || segment[startIndex + 1] !== "(" || segment[startIndex + 2] !== "(") {
    return null;
  }

  let depth = 1;
  let quote = null;

  for (let index = startIndex + 3; index < segment.length; index += 1) {
    const char = segment[index];
    const next = segment[index + 1];

    if (quote) {
      if (char === "\\" && quote !== "'" && next) {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === "\\" && next) {
      index += 1;
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char === ")") {
      if (depth === 1 && next === ")") return index + 2;
      if (depth > 1) depth -= 1;
    }
  }

  return segment.length;
}

function hasExecutableShellExpansion(segment) {
  let quote = null;

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    const next = segment[index + 1];

    if (quote) {
      if (char === "\\" && quote === "\"" && next) {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      if (quote === "\"" && char === "$" && next === "(") return true;
      if (quote === "\"" && char === "`") return true;
      continue;
    }

    if (char === "\\" && next) {
      index += 1;
      continue;
    }

    if (char === "'") {
      quote = char;
      continue;
    }

    if (char === "\"") {
      quote = char;
      continue;
    }

    if (char === "`") return true;
    if (char === "$" && next === "(") return true;
    if ((char === "<" || char === ">") && next === "(") return true;
  }

  return false;
}

function readEscapeDigits(value, startIndex, maxLength, pattern) {
  let endIndex = startIndex;
  while (
    endIndex < value.length
    && endIndex < startIndex + maxLength
    && pattern.test(value[endIndex])
  ) {
    endIndex += 1;
  }

  if (endIndex === startIndex) return null;
  return { digits: value.slice(startIndex, endIndex), endIndex: endIndex - 1 };
}

function codePointToString(codePoint) {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return "";
  }
}

function readAnsiCEscape(value, backslashIndex) {
  const escapeIndex = backslashIndex + 1;
  const char = value[escapeIndex];
  if (!char) return { text: "\\", endIndex: backslashIndex };

  const simpleEscapes = {
    a: "\x07",
    b: "\b",
    e: "\x1B",
    E: "\x1B",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    "'": "'",
    "\"": "\"",
    "?": "?",
  };

  const simple = simpleEscapes[char];
  if (simple !== undefined) return { text: simple, endIndex: escapeIndex };

  if (char === "x") {
    const digits = readEscapeDigits(value, escapeIndex + 1, 2, /[0-9a-fA-F]/);
    if (!digits) return { text: "\\x", endIndex: escapeIndex };
    return {
      text: codePointToString(Number.parseInt(digits.digits, 16)),
      endIndex: digits.endIndex,
    };
  }

  if (char === "u" || char === "U") {
    const digits = readEscapeDigits(value, escapeIndex + 1, char === "u" ? 4 : 8, /[0-9a-fA-F]/);
    if (!digits) return { text: `\\${char}`, endIndex: escapeIndex };
    return {
      text: codePointToString(Number.parseInt(digits.digits, 16)),
      endIndex: digits.endIndex,
    };
  }

  if (/[0-7]/.test(char)) {
    const digits = readEscapeDigits(value, escapeIndex, 3, /[0-7]/);
    return {
      text: codePointToString(Number.parseInt(digits.digits, 8)),
      endIndex: digits.endIndex,
    };
  }

  return { text: `\\${char}`, endIndex: escapeIndex };
}

function readHereDocDelimiterWord(segment, startIndex) {
  let index = startIndex;
  while (index < segment.length && /\s/.test(segment[index])) index += 1;

  let text = "";
  let quote = null;
  let ansiQuote = false;

  for (; index < segment.length; index += 1) {
    const char = segment[index];
    const next = segment[index + 1];

    if (quote) {
      if (ansiQuote && char === "\\") {
        const escape = readAnsiCEscape(segment, index);
        text += escape.text;
        index = escape.endIndex;
        continue;
      }
      if (char === "\\" && quote !== "'" && next) {
        text += next;
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        ansiQuote = false;
        continue;
      }
      text += char;
      continue;
    }

    if (/\s/.test(char) || char === ";" || char === "|" || char === "&") break;

    if (char === "\\" && next) {
      text += next;
      index += 1;
      continue;
    }

    if (char === "$" && (next === "'" || next === "\"")) {
      quote = next;
      ansiQuote = next === "'";
      index += 1;
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      ansiQuote = false;
      continue;
    }

    text += char;
  }

  return text ? { text, endIndex: index } : null;
}

function extractHereDocTerminators(segment) {
  const terminators = [];
  let quote = null;

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    const next = segment[index + 1];

    if (quote) {
      if (char === "\\" && quote !== "'" && next) {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    const arithmeticEnd = readArithmeticExpansionEnd(segment, index);
    if (arithmeticEnd !== null) {
      index = arithmeticEnd - 1;
      continue;
    }

    if (char === "\\" && next) {
      index += 1;
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char !== "<" || next !== "<") continue;
    if (segment[index + 2] === "<") {
      index += 2;
      continue;
    }

    const stripLeadingTabs = segment[index + 2] === "-";
    const delimiterStart = index + (stripLeadingTabs ? 3 : 2);
    const delimiter = readHereDocDelimiterWord(segment, delimiterStart);
    if (!delimiter) continue;
    terminators.push({ text: delimiter.text, stripLeadingTabs });
    index = delimiter.endIndex - 1;
  }

  return terminators;
}

function skipHereDocBodies(command, startIndex, terminators) {
  let cursor = startIndex;

  for (const terminator of terminators) {
    while (cursor < command.length) {
      const lineEnd = command.indexOf("\n", cursor);
      const end = lineEnd === -1 ? command.length : lineEnd;
      const rawLine = command.slice(cursor, end);
      const line = terminator.stripLeadingTabs ? rawLine.replace(/^\t+/, "") : rawLine;
      cursor = lineEnd === -1 ? command.length : lineEnd + 1;

      if (line === terminator.text) break;
    }
  }

  return cursor;
}

function splitShellCommandSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  let inComment = false;
  let lineHereDocTerminators = [];

  const flush = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = "";
  };

  const flushCommandSegment = () => {
    lineHereDocTerminators.push(...extractHereDocTerminators(current));
    flush();
  };

  const finishLine = (bodyStartIndex) => {
    flushCommandSegment();
    const hereDocTerminators = lineHereDocTerminators;
    lineHereDocTerminators = [];
    if (hereDocTerminators.length === 0) return bodyStartIndex;
    return skipHereDocBodies(command, bodyStartIndex, hereDocTerminators);
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (inComment) {
      if (char === "\n") {
        inComment = false;
        index = finishLine(index + 1) - 1;
      }
      continue;
    }

    if (quote) {
      current += char;
      if (char === "\\" && quote !== "'" && next) {
        current += next;
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === "\\" && next === "\n") {
      index += 1;
      continue;
    }

    if (char === "\\" && next) {
      current += char + next;
      index += 1;
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      current += char;
      continue;
    }

    const arithmeticEnd = readArithmeticExpansionEnd(command, index);
    if (arithmeticEnd !== null) {
      current += command.slice(index, arithmeticEnd);
      index = arithmeticEnd - 1;
      continue;
    }

    if (char === "#") {
      const previous = current[current.length - 1];
      if (!previous || /\s/.test(previous)) {
        inComment = true;
        continue;
      }
    }

    if (char === "\n") {
      index = finishLine(index + 1) - 1;
      continue;
    }

    if (char === ";") {
      flushCommandSegment();
      continue;
    }

    if (char === "&" && next === "&") {
      flushCommandSegment();
      index += 1;
      continue;
    }

    if (char === "|" && next === "|") {
      flushCommandSegment();
      index += 1;
      continue;
    }

    if (char === "&") {
      const previous = lastNonWhitespaceChar(current);
      if (next === ">" || previous === ">" || previous === "<") {
        current += char;
        continue;
      }
      flushCommandSegment();
      continue;
    }

    if (char === "|") {
      flushCommandSegment();
      if (next === "&") index += 1;
      continue;
    }

    current += char;
  }

  flush();
  return segments;
}

function extractGrantableShellCommandSegments(command) {
  return splitShellCommandSegments(command).filter((segment) => {
    const tokens = tokenizeShellCommand(segment);
    const cmd = tokens[0] && tokens[0].toLowerCase();
    return tokens.length > 0 && !(cmd && CWD_COMMANDS.has(cmd) && !hasExecutableShellExpansion(segment));
  });
}

function matchCommandPatternGrants(rules, ctx, command, args) {
  const commandSegments = extractGrantableShellCommandSegments(command);
  if (commandSegments.length === 0) return null;

  const eligibleRules = rules.filter((rule) => (
    rule
    && rule.capabilityId === ctx?.capabilityId
    && rule.commandPattern
    && argsPatternMatches(rule.argsPattern, args)
  ));
  if (eligibleRules.length === 0) return null;

  let firstMatch = null;
  for (const segment of commandSegments) {
    const matched = eligibleRules.find((rule) => patternMatches(rule.commandPattern, segment));
    if (!matched) return null;
    if (!firstMatch) firstMatch = matched;
  }

  return firstMatch;
}

function matchPermissionGrant(rules, ctx) {
  if (!Array.isArray(rules) || rules.length === 0) return null;

  const args = ctx?.args && typeof ctx.args === "object" ? ctx.args : {};
  const command = typeof args.command === "string" ? args.command : "";
  const commandGrantMatch = command ? matchCommandPatternGrants(rules, ctx, command, args) : null;
  if (commandGrantMatch) return commandGrantMatch;

  for (const rule of rules) {
    if (!rule || typeof rule.capabilityId !== "string") continue;

    if (rule.capabilityId !== ctx?.capabilityId) continue;
    if (rule.commandPattern) continue;

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
