"use strict";

const { randomBytes } = require("node:crypto");
const { BlockList, isIP } = require("node:net");

let _RE2JS = null;
function getRE2JS() {
  if (!_RE2JS) ({ RE2JS: _RE2JS } = require("re2js"));
  return _RE2JS;
}

const CONFIG_ERROR = "Invalid External MCP redaction configuration";
const VALUE_ERROR = "External MCP redaction could not safely process this value";
const TOKEN_ERROR = "Unknown External MCP redaction token; reconnect the client";
const LIMIT_ERROR = "External MCP redaction session limit reached; reconnect the client";
const MAX_ENTRIES = 10000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 100000;
const MAX_DEPTH = 100;
const CONFIG_KEYS = new Set(["enabled", "redactPrivateIps", "cidrs", "patterns"]);
const RESERVED_TOKEN = /\[NC_[^\]\r\n]*(?:\]|(?=[\r\n]|$))/g;

function plainObject(value) {
  return value !== null && typeof value === "object"
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function parseCidr(value) {
  if (typeof value !== "string") throw new Error(CONFIG_ERROR);
  const match = /^([^/%\s]+)\/(0|[1-9]\d*)$/.exec(value);
  const version = match && isIP(match[1]);
  const prefix = match && Number(match[2]);
  if (!version || prefix > (version === 4 ? 32 : 128)) throw new Error(CONFIG_ERROR);
  return { address: match[1], prefix, family: version === 4 ? "ipv4" : "ipv6" };
}

/** Reject malformed policy rather than silently disabling a requested protection. */
function normalizeRedactionConfig(input) {
  try {
    if (input === undefined) input = {};
    if (!plainObject(input) || Object.keys(input).some((key) => !CONFIG_KEYS.has(key))) {
      throw new Error(CONFIG_ERROR);
    }
    const config = {
      enabled: input.enabled === undefined ? false : input.enabled,
      redactPrivateIps: input.redactPrivateIps === undefined ? false : input.redactPrivateIps,
      cidrs: input.cidrs === undefined ? [] : input.cidrs,
      patterns: input.patterns === undefined ? [] : input.patterns,
    };
    if (typeof config.enabled !== "boolean" || typeof config.redactPrivateIps !== "boolean") {
      throw new Error(CONFIG_ERROR);
    }
    for (const key of ["cidrs", "patterns"]) {
      if (!Array.isArray(config[key]) || config[key].length > 100
        || config[key].some((item) => typeof item !== "string" || !item || item.length > 1024)) {
        throw new Error(CONFIG_ERROR);
      }
    }
    config.cidrs.forEach(parseCidr);
    // RE2 rejects backreferences/lookaround and has bounded execution time.
    if (config.patterns.length > 0) {
      const RE2JS = getRE2JS();
      config.patterns.forEach((pattern) => {
        if (RE2JS.compile(pattern).matcher("").find()) throw new Error(CONFIG_ERROR);
      });
    }
    return { ...config, cidrs: [...config.cidrs], patterns: [...config.patterns] };
  } catch {
    throw new Error(CONFIG_ERROR);
  }
}

function normalizedKey(key) {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function secretKey(key) {
  return /(?:password|passwd|passphrase|pwd|token|secret|apikey|accesskey|secretkey|privatekey|credentials?)$/
    .test(normalizedKey(key));
}

function hostKey(key) {
  return /^(?:host|hostname|address|ip|ipaddress|server|serveraddress|endpoint|remotehost|targethost|bindaddress|localaddress|remoteaddress)$/
    .test(normalizedKey(key));
}

function hostname(value) {
  return value.length <= 253 && /[A-Za-z]/.test(value)
    && value.replace(/\.$/, "").split(".").every((label) => (
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)
    ));
}

function addSubnet(block, cidr) {
  const { address, prefix, family } = parseCidr(cidr);
  block.addSubnet(address, prefix, family);
}

const privateAddresses = new BlockList();
[
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
  "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16",
  "224.0.0.0/4", "240.0.0.0/4",
  "::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8",
].forEach((cidr) => addSubnet(privateAddresses, cidr));

function escapedLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Session-local reversible pseudonyms. No reverse map leaves this closure.
 * Operate on parsed JSON, never on an RPC envelope or an encoded attachment.
 */
function createRedactionSession(input) {
  const config = normalizeRedactionConfig(input);
  if (!config.enabled) return Object.freeze({ redact: (value) => value, restore: (value) => value });

  const nonce = randomBytes(6).toString("hex");
  const originals = new Map();
  const tokens = new Map();
  const knownSecrets = new Set();
  const knownHosts = new Set();
  const counters = { IP: 0, HOST: 0, SECRET: 0 };
  let storedBytes = 0;
  let exhausted = false;
  const customRanges = new BlockList();
  config.cidrs.forEach((cidr) => addSubnet(customRanges, cidr));
  const patterns = config.patterns.length > 0
    ? config.patterns.map((pattern) => getRE2JS().compile(pattern))
    : [];

  function issue(value, namespace) {
    // The first classification names a value; later contexts reuse its token.
    const identity = `${typeof value}\0${String(value)}`;
    const prior = tokens.get(identity);
    if (prior) return prior;
    const bytes = Buffer.byteLength(identity, "utf8");
    if (originals.size >= MAX_ENTRIES || storedBytes + bytes > MAX_BYTES) {
      exhausted = true;
      throw new Error(LIMIT_ERROR);
    }
    const token = `[NC_${nonce}_${namespace}_${++counters[namespace]}]`;
    tokens.set(identity, token);
    originals.set(token, value);
    storedBytes += bytes;
    return token;
  }

  function rememberSecret(value) {
    if (typeof value !== "string" || !value) return;
    issue(value, "SECRET");
    knownSecrets.add(value);
  }

  function shouldMaskIp(address) {
    const version = isIP(address);
    if (!version) return false;
    const family = version === 4 ? "ipv4" : "ipv6";
    return config.redactPrivateIps || customRanges.check(address, family)
      || !privateAddresses.check(address, family);
  }

  function inspectString(value, key, inheritedSecret, budget, acceptExistingTokens = false) {
    const source = value;
    const aliases = [];
    if (acceptExistingTokens) {
      value = source.replace(RESERVED_TOKEN, (token, start) => {
        if (!originals.has(token)) throw new Error(TOKEN_ERROR);
        if (++budget.ranges > MAX_NODES) throw new Error(VALUE_ERROR);
        aliases.push({ start, end: start + token.length, token });
        // Keep offsets and credential context around aliases. In particular,
        // password=prefix<alias>suffix must mask both unaliased fragments.
        return "x".repeat(token.length);
      });
    }
    const ranges = [...aliases];
    function appendRange(start, end, namespace, remember) {
      if (end <= start) return;
      if (++budget.ranges > MAX_NODES) throw new Error(VALUE_ERROR);
      ranges.push({ start, end, namespace });
      if (namespace === "SECRET" && remember) rememberSecret(source.slice(start, end));
      if (namespace === "HOST") {
        const host = source.slice(start, end);
        issue(host, "HOST");
        knownHosts.add(host);
      }
    }
    function add(start, end, namespace = "SECRET", remember = true) {
      let low = 0;
      let high = aliases.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (aliases[mid].end <= start) low = mid + 1;
        else high = mid;
      }
      let cursor = start;
      for (let index = low; index < aliases.length && aliases[index].start < end; index++) {
        appendRange(cursor, Math.min(end, aliases[index].start), namespace, remember);
        cursor = Math.max(cursor, aliases[index].end);
      }
      appendRange(cursor, end, namespace, remember);
    }
    function matches(regex, select) {
      for (const match of value.matchAll(regex)) {
        const group = select(match);
        if (group !== undefined && match.indices[group]) add(...match.indices[group]);
      }
    }

    // Source text that resembles a token must survive a one-pass round trip.
    // Do not remember these literals as credentials or scan replacement tokens.
    for (const match of value.matchAll(RESERVED_TOKEN)) {
      add(match.index, match.index + match[0].length, "SECRET", false);
    }
    if (value && (inheritedSecret || secretKey(key))) add(0, value.length);
    matches(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gd, () => 0);
    matches(/\bBearer(\s+)([A-Za-z0-9._~+/=-]{8,})/gdi, () => 2);
    matches(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@]+)(@)/gdi, () => 2);
    // Keep the original separators, whitespace, quotes, and escaped contents.
    for (const match of value.matchAll(/(?<![A-Za-z0-9_.-])(["']?)([A-Za-z0-9_.-]+)\1(\s*[:=]\s*)(["'])/g)) {
      if (!secretKey(match[2])) continue;
      const start = match.index + match[0].length;
      let end = start;
      for (; end < value.length; end++) {
        if (value[end] === "\\") end++;
        else if (value[end] === match[4]) break;
      }
      add(start, Math.min(end, value.length));
    }
    matches(/(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(\s*[:=]\s*)([^\s"',;{}\[\]]+)/gd,
      (match) => secretKey(match[1]) && match[3] !== "null" ? 3 : undefined);
    matches(/--(?:password|passwd|passphrase|pwd|token|secret|api-key|access-key|secret-key|private-key)(?:\s+|=)(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|([^\s]+))/gdi,
      (match) => match[1] !== undefined ? 1 : match[2] !== undefined ? 2 : 3);
    matches(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/gd, () => 0);

    for (const pattern of patterns) {
      const matcher = pattern.matcher(value);
      while (matcher.find()) add(matcher.start(), matcher.end());
    }

    for (const match of value.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
      const start = match.index;
      const end = start + match[0].length;
      if (!/[A-Za-z0-9_.]/.test(value[start - 1] || "")
        && !/[A-Za-z0-9_.]/.test(value[end] || "") && shouldMaskIp(match[0])) {
        add(start, end, "IP");
      }
    }
    for (const match of value.matchAll(/[A-Fa-f0-9:.]+(?:%[A-Za-z0-9_.-]+)?/g)) {
      let address = match[0];
      if (!address.includes(":")) continue;
      // Full stops/colons can be sentence punctuation following an address.
      while (address && !isIP(address) && /[.:]$/.test(address)) address = address.slice(0, -1);
      if (isIP(address) === 6 && shouldMaskIp(address)) {
        add(match.index, match.index + address.length, "IP");
      }
    }

    function inspectHost(start, end) {
      const raw = value.slice(start, end);
      const trimmed = raw.trim();
      const offset = start + raw.indexOf(trimmed);
      if (!trimmed || isIP(trimmed)) return;
      // In a structured address, only the authority is a hostname, not a path.
      const authority = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#:\s]+)(?::\d+)?(?:[/?#].*)?$/i.exec(trimmed);
      if (authority && !isIP(authority[1]) && hostname(authority[1])) {
        const hostStart = offset + trimmed.indexOf(authority[1]);
        add(hostStart, hostStart + authority[1].length, "HOST");
      }
    }
    if (hostKey(key)) inspectHost(0, value.length);
    for (const match of value.matchAll(/(?<![A-Za-z0-9_.-])(["']?)([A-Za-z0-9_.-]+)\1\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,;{}]+))/gd)) {
      if (!hostKey(match[2])) continue;
      const group = match[3] !== undefined ? 3 : match[4] !== undefined ? 4 : 5;
      inspectHost(...match.indices[group]);
    }
    return { value: source, ranges };
  }

  function rejectBinary(value) {
    const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
    if (type === "image" || type === "audio") throw new Error(VALUE_ERROR);
    for (const [key, entry] of Object.entries(value)) {
      if (/^(?:base64data|base64|blob)$/.test(normalizedKey(key))
        && entry !== undefined && entry !== null && entry !== "") throw new Error(VALUE_ERROR);
    }
    const mime = typeof value.mimeType === "string" ? value.mimeType : value.mime_type;
    if (typeof mime === "string" && !/^(?:text\/|application\/(?:json|xml|javascript)(?:;|$))/i.test(mime)
      && value.data !== undefined && value.data !== null && value.data !== "") {
      throw new Error(VALUE_ERROR);
    }
  }

  function walk(value, transformString, transformPrimitive, key = "", inheritedSecret = false, state) {
    if (++state.nodes > MAX_NODES || state.depth > MAX_DEPTH) throw new Error(VALUE_ERROR);
    if (typeof value === "string") {
      if (value.includes("\0")) throw new Error(VALUE_ERROR);
      state.bytes += Buffer.byteLength(value, "utf8");
      if (state.bytes > MAX_BYTES) throw new Error(VALUE_ERROR);
      return transformString(value, key, inheritedSecret);
    }
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      return transformPrimitive(value, key, inheritedSecret);
    }
    if (!Array.isArray(value) && !plainObject(value)) throw new Error(VALUE_ERROR);
    if (state.seen.has(value)) throw new Error(VALUE_ERROR);
    state.seen.add(value);
    state.depth++;
    let result;
    if (Array.isArray(value)) {
      // Match JSON transport semantics for optional in-process values.
      result = Array.from(value, (entry) => walk(
        entry === undefined ? null : entry, transformString, transformPrimitive, key, inheritedSecret, state,
      ));
    } else {
      rejectBinary(value);
      const entries = Object.entries(value).filter(([, entry]) => entry !== undefined).map(([entryKey, entry]) => [
        state.preserveRootKeys && state.depth === 1
          ? entryKey : walk(entryKey, transformString, transformPrimitive, "", false, state),
        walk(entry, transformString, transformPrimitive, entryKey, inheritedSecret || secretKey(key), state),
      ]);
      if (new Set(entries.map(([entryKey]) => String(entryKey))).size !== entries.length) {
        throw new Error(VALUE_ERROR);
      }
      result = Object.fromEntries(entries);
    }
    state.depth--;
    state.seen.delete(value);
    return result;
  }

  function state(preserveRootKeys = false) {
    if (exhausted) throw new Error(LIMIT_ERROR);
    return { nodes: 0, bytes: 0, depth: 0, seen: new Set(), preserveRootKeys };
  }

  function redact(value, options) {
    const plans = [];
    const budget = { ranges: 0 };
    const preserveRootKeys = options?.preserveRootKeys === true;
    const acceptExistingTokens = options?.acceptExistingTokens === true;
    // Inspect the entire value first: repeats appearing before a credential's
    // defining field in this response must be masked too.
    walk(value, (text, key, secret) => {
      plans.push(inspectString(text, key, secret, budget, acceptExistingTokens));
      return text;
    }, (entry) => entry, "", false, state(preserveRootKeys));
    const knownPattern = knownSecrets.size
      ? new RegExp([...knownSecrets].sort((a, b) => b.length - a.length).map(escapedLiteral).join("|"), "g")
      : null;
    const knownHostPattern = knownHosts.size
      ? new RegExp(`(?<![A-Za-z0-9_.-])(?:${[...knownHosts].sort((a, b) => b.length - a.length)
        .map(escapedLiteral).join("|")})(?![A-Za-z0-9_.-])`, "g")
      : null;
    let cursor = 0;
    return walk(value, () => {
      const { value: text, ranges } = plans[cursor++];
      const aliasRanges = ranges.filter((range) => range.token);
      for (const [pattern, namespace] of [[knownPattern, "SECRET"], [knownHostPattern, "HOST"]]) {
        if (!pattern) continue;
        let aliasIndex = 0;
        for (const match of text.matchAll(pattern)) {
          const end = match.index + match[0].length;
          // Previously issued aliases are protocol data, never source secrets.
          while (aliasIndex < aliasRanges.length && aliasRanges[aliasIndex].end <= match.index) aliasIndex++;
          if (aliasIndex < aliasRanges.length && aliasRanges[aliasIndex].start < end) continue;
          if (++budget.ranges > MAX_NODES) throw new Error(VALUE_ERROR);
          ranges.push({ start: match.index, end, namespace });
        }
      }
      ranges.sort((a, b) => a.start - b.start || b.end - a.end);
      const merged = [];
      for (const range of ranges) {
        const previous = merged[merged.length - 1];
        if (previous && range.start < previous.end) {
          previous.end = Math.max(previous.end, range.end);
          if (range.namespace === "SECRET") previous.namespace = "SECRET";
        } else merged.push({ ...range });
      }
      let result = "";
      let position = 0;
      for (const range of merged) {
        result += text.slice(position, range.start)
          + (range.token || issue(text.slice(range.start, range.end), range.namespace));
        position = range.end;
      }
      return result + text.slice(position);
    }, (entry, key, secret) => (
      entry !== null && (secret || secretKey(key)) ? issue(entry, "SECRET") : entry
    ), "", false, state(preserveRootKeys));
  }

  function restore(value) {
    return walk(value, (text) => {
      if (originals.has(text)) return originals.get(text);
      return text.replace(RESERVED_TOKEN, (token) => {
        if (!originals.has(token)) throw new Error(TOKEN_ERROR);
        // A replacement is not scanned again, including a source token literal.
        return String(originals.get(token));
      });
    }, (entry) => entry, "", false, state());
  }

  function safeTransform(transform, value, options) {
    try {
      return transform(value, options);
    } catch (error) {
      // Even a regex/compiler failure must not include source text in an error.
      const message = [VALUE_ERROR, TOKEN_ERROR, LIMIT_ERROR].includes(error?.message)
        ? error.message : VALUE_ERROR;
      throw new Error(message);
    }
  }
  return Object.freeze({
    redact: (value, options) => safeTransform(redact, value, options),
    restore: (value) => safeTransform(restore, value),
  });
}

module.exports = { normalizeRedactionConfig, createRedactionSession };
