/**
 * Node-side replacement for the upstream Mosh Perl wrapper.
 *
 * The upstream `mosh` script is a tiny orchestrator: it execs `ssh` to
 * run `mosh-server new` on the remote host, scrapes the
 * "MOSH CONNECT <port> <key>" line from the SSH stream, then execs
 * `mosh-client` locally with that port/key. This module does the same
 * thing in JS so we no longer need a Perl interpreter on the user's
 * machine — and so we can drive a bundled `mosh-client` even on
 * Windows (which has no Perl wrapper).
 *
 * Flow (driven by terminalBridge.startMoshSession):
 *   1. spawn `ssh -n -tt [-p port] [user@]host -- mosh-server new -s ...`
 *      inside a node-pty, sized to the renderer's cols/rows so password
 *      / 2FA prompts render natively.
 *   2. forward every byte from the ssh PTY to the renderer (parsing
 *      simultaneously via parseMoshConnect).
 *   3. when `MOSH CONNECT <port> <key>` is detected, kill the ssh PTY,
 *      spawn `mosh-client <ip> <port>` in a fresh node-pty with
 *      MOSH_KEY=<key> in the environment, and let the bridge swap that
 *      new PTY into the existing session.
 *
 * On every supported platform the module relies on the system `ssh`
 * binary for the SSH bootstrap (Windows 10 1809+ ships OpenSSH by
 * default, macOS / Linux have it everywhere). That keeps key / agent /
 * config handling identical to what the user already has working with
 * `ssh` — no need to reimplement OpenSSH features in this codebase.
 */

const path = require("node:path");
const net = require("node:net");

// ConPTY (Windows) and some remote shells inject CSI / OSC sequences into
// the SSH byte stream. Strip them before matching MOSH CONNECT so a line
// like `MOSH CONNECT 60001 KEY==\x1b[?25h` still parses. Keep the original
// offsets so the sniffer can redact the marker from the visible stream.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[PX^_][^\u001b]*\u001b\\|.)/g;
const MOSH_CONNECT_PREFIX_RE = /MOSH CONNECT[ \t]+(\d{1,5})[ \t]+/;
const MOSH_IP_RE = /MOSH IP[ \t]+(\S+)/;
const PROTOCOL_MARKERS = ["MOSH CONNECT", "MOSH IP"];
const MOSH_LOCALE_NAMES = [
  "LANG",
  "LANGUAGE",
  "LC_CTYPE",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_COLLATE",
  "LC_MONETARY",
  "LC_MESSAGES",
  "LC_PAPER",
  "LC_NAME",
  "LC_ADDRESS",
  "LC_TELEPHONE",
  "LC_MEASUREMENT",
  "LC_IDENTIFICATION",
  "LC_ALL",
];

function shellQuote(value) {
  const text = String(value);
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function validMoshKey(key) {
  return key.length === 22 || (key.length === 24 && key.endsWith("=="));
}

function stripAnsiEscapes(text) {
  return String(text || "").replace(ANSI_ESCAPE_RE, "");
}

function stripAnsiEscapesWithMap(text) {
  const source = String(text || "");
  let cleaned = "";
  const cleanToOriginal = [];
  let index = 0;
  while (index < source.length) {
    if (source[index] === "\u001b") {
      ANSI_ESCAPE_RE.lastIndex = index;
      const esc = ANSI_ESCAPE_RE.exec(source);
      if (esc && esc.index === index) {
        index = ANSI_ESCAPE_RE.lastIndex;
        continue;
      }
    }
    cleanToOriginal.push(index);
    cleaned += source[index];
    index += 1;
  }
  cleanToOriginal.push(source.length);
  return { cleaned, cleanToOriginal };
}

function skipAnsiEscapes(text, offset) {
  let pos = offset;
  while (pos < text.length && text[pos] === "\u001b") {
    ANSI_ESCAPE_RE.lastIndex = pos;
    const esc = ANSI_ESCAPE_RE.exec(text);
    if (!esc || esc.index !== pos) break;
    pos = ANSI_ESCAPE_RE.lastIndex;
  }
  return pos;
}

function parseConnectLine(line) {
  const { cleaned, cleanToOriginal } = stripAnsiEscapesWithMap(line);
  const m = MOSH_CONNECT_PREFIX_RE.exec(cleaned);
  if (!m) return null;
  const port = Number(m[1]);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;

  const connectIdx = cleanToOriginal[m.index];
  const keyStartOffset = cleanToOriginal[m.index + m[0].length];
  if (connectIdx === undefined || keyStartOffset === undefined) return null;

  let key = "";
  let pos = keyStartOffset;
  while (pos < line.length && key.length < 22) {
    const ch = line[pos];
    if (ch === "\u001b") {
      ANSI_ESCAPE_RE.lastIndex = pos;
      const esc = ANSI_ESCAPE_RE.exec(line);
      if (esc && esc.index === pos) {
        pos = ANSI_ESCAPE_RE.lastIndex;
        continue;
      }
    }
    if (!/[A-Za-z0-9+/]/.test(ch)) return null;
    key += ch;
    pos += 1;
  }

  if (key.length !== 22) return null;

  let paddingLookahead = skipAnsiEscapes(line, pos);

  if (line.startsWith("==", paddingLookahead)) {
    key += "==";
    pos = paddingLookahead + 2;
  } else if (line[paddingLookahead] === "=") {
    const secondPaddingOffset = skipAnsiEscapes(line, paddingLookahead + 1);
    if (line[secondPaddingOffset] === "=") {
      key += "==";
      pos = secondPaddingOffset + 1;
    } else if (paddingLookahead === pos) {
      return null;
    }
  } else if (paddingLookahead === pos && /[A-Za-z0-9+/=]/.test(line[pos] || "")) {
    return null;
  }

  if (/[A-Za-z0-9+/=]/.test(line[pos] || "")) {
    return null;
  }

  if (!validMoshKey(key)) return null;

  // Map the cleaned match back onto the original line so redaction still
  // covers ConPTY CSI that trailed or split the key (e.g. `\x1b[?25h`).
  let matchEndOffset = pos;
  while (matchEndOffset < line.length) {
    const ch = line[matchEndOffset];
    if (ch === "\u001b") {
      ANSI_ESCAPE_RE.lastIndex = matchEndOffset;
      const esc = ANSI_ESCAPE_RE.exec(line);
      if (esc && esc.index === matchEndOffset) {
        matchEndOffset = ANSI_ESCAPE_RE.lastIndex;
        continue;
      }
    }
    if (ch === " " || ch === "\t") {
      matchEndOffset += 1;
      continue;
    }
    break;
  }

  return {
    port,
    key,
    matchStartOffset: connectIdx,
    matchEndOffset,
  };
}

function parseMoshIpLine(line) {
  const m = MOSH_IP_RE.exec(stripAnsiEscapes(line));
  if (!m) return null;
  const host = m[1];
  return net.isIP(host) ? host : null;
}

function forEachCompleteLine(text, visit) {
  const lineRe = /([^\r\n]*)(\r\n|\r|\n)/g;
  let m;
  while ((m = lineRe.exec(text)) !== null) {
    if (visit({
      line: m[1],
      newline: m[2],
      startIndex: m.index,
      endIndex: lineRe.lastIndex,
    }) === false) {
      break;
    }
  }
}

function findMoshConnect(text) {
  let found = null;
  forEachCompleteLine(text, ({ line, newline, startIndex, endIndex }) => {
    const parsed = parseConnectLine(line);
    if (!parsed) return;
    found = {
      port: parsed.port,
      key: parsed.key,
      matchStartIndex: startIndex + parsed.matchStartOffset,
      matchEndIndex: endIndex,
      visiblePrefix: line.slice(0, parsed.matchStartOffset),
      visibleSuffix: line.slice(parsed.matchEndOffset) + newline,
    };
    return false;
  });
  return found;
}

function potentialProtocolStart(text) {
  if (!text) return -1;
  let best = -1;
  for (const marker of PROTOCOL_MARKERS) {
    const full = text.indexOf(marker);
    if (full !== -1) {
      best = best === -1 ? full : Math.min(best, full);
    }
    for (let len = Math.min(marker.length - 1, text.length); len > 0; len -= 1) {
      if (marker.startsWith(text.slice(text.length - len))) {
        const pos = text.length - len;
        best = best === -1 ? pos : Math.min(best, pos);
        break;
      }
    }
  }
  return best;
}

function buildMoshServerCommand(moshServerPath) {
  const trimmed = typeof moshServerPath === "string" ? moshServerPath.trim() : "";
  if (!trimmed) return "mosh-server new -s";
  return `${shellQuote(trimmed)} new -s`;
}

/**
 * Parse a buffer of bytes from the SSH PTY for a MOSH CONNECT line.
 *
 * Returns { port: number, key: string, matchEndIndex: number } when the
 * marker is found, otherwise null. matchEndIndex is the byte offset
 * immediately after the matched line in the *current* chunk so callers
 * can tell what to strip from the renderer-visible stream (since the
 * line is internal protocol, not a user-visible prompt).
 *
 * The parser is deliberately stateless: callers should keep a small
 * trailing window (≤ 4096 bytes) of unmatched data so the marker isn't
 * lost when it spans chunk boundaries.
 */
function parseMoshConnect(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  const found = findMoshConnect(text);
  if (!found) return null;
  return { port: found.port, key: found.key, matchEndIndex: found.matchEndIndex };
}

/**
 * Build the argv for the ssh bootstrap command.
 *
 *   ssh -n -tt [-p port] [user@]host -- sh -c '<report SSH address; run mosh-server>'
 *
 * `-tt` mirrors the stock Mosh wrapper. Besides supporting password / 2FA
 * prompts, it makes mosh-server drain the CONNECT line before its launcher
 * exits; this avoids losing stdout while Windows ConPTY merges the SSH
 * stdout/stderr streams. `-n` keeps the remote command from consuming input;
 * OpenSSH authentication prompts still use the controlling PTY. `--`
 * separates ssh's options from the remote command we want it to run.
 * The remote command runs `mosh-server new` and exits, with the magic
 * line emitted to stdout.
 *
 * @param {object} opts
 * @param {string} opts.host        — hostname or IP
 * @param {number} [opts.port]      — ssh port (omit for default 22)
 * @param {string} [opts.username]  — ssh user (defaults to ssh's choice)
 * @param {string} [opts.lang]      — UTF-8 locale offered to mosh-server
 * @param {object} [opts.locales]    — client locale variables offered in stock order
 * @param {string} [opts.moshServer]— remote command (default "mosh-server new")
 * @param {string[]} [opts.sshArgs] — extra args passed to ssh (e.g. -i path)
 * @returns {{ command: string, args: string[] }}
 */
function buildSshHandshakeCommand(opts) {
  if (!opts || !opts.host) throw new Error("buildSshHandshakeCommand: host is required");
  const args = ["-n", "-tt"];
  if (opts.port && Number(opts.port) !== 22) {
    args.push("-p", String(opts.port));
  }
  if (Array.isArray(opts.sshArgs)) {
    args.push(...opts.sshArgs);
  }
  const target = opts.username ? `${opts.username}@${opts.host}` : opts.host;
  args.push(target);
  args.push("--");
  // Match stock mosh's remote-address handoff. A hostname can resolve to
  // several IPv4/IPv6 addresses, and resolving it again for UDP may select a
  // different endpoint from the one SSH actually reached. SSH_CONNECTION's
  // third field is the server address of this exact SSH connection.
  // Invoke POSIX sh explicitly because the account's login shell may not be
  // sh-compatible. The sniffer validates and hides the MOSH IP marker.
  const lang = opts.lang || "en_US.UTF-8";
  const moshServer = opts.moshServer || "mosh-server new -s";
  const localeAssignments = MOSH_LOCALE_NAMES
    .filter((name) => Object.prototype.hasOwnProperty.call(opts.locales || {}, name))
    .map((name) => `${name}=${String(opts.locales[name])}`);
  if (localeAssignments.length === 0) {
    localeAssignments.push(`LANG=${lang}`);
  }
  const localeArgs = localeAssignments
    .map((assignment) => ` -l ${shellQuote(assignment)}`)
    .join("");
  const remoteScript = "if [ -n \"$SSH_CONNECTION\" ]; then "
    + "set -- $SSH_CONNECTION; printf '\\nMOSH IP %s\\n' \"$3\"; fi; "
    // Match the stock wrapper's `mosh-server -l NAME=value` behavior. The
    // server first keeps a working UTF-8 locale from the remote host and only
    // applies the client locales if it needs a fallback. Forcing LC_ALL here
    // makes startup fail on minimal hosts that do not install the requested
    // locale even when their native C.UTF-8 locale is perfectly usable.
    + `exec ${moshServer}${localeArgs}`;
  args.push(`sh -c ${shellQuote(remoteScript)}`);
  return { command: "ssh", args };
}

/**
 * Build the argv for the local mosh-client invocation once the
 * handshake produced an ip + port + key.
 *
 *   mosh-client <ip> <port>     (with MOSH_KEY in env)
 *
 * `mosh-server` listens on UDP at the IP/port pair it announced. By
 * convention, the IP is derived from the "MOSH IP" line emitted before
 * MOSH CONNECT, but most servers omit it and the client just uses the
 * SSH-resolved hostname / IP. We default to the original hostname when
 * no MOSH IP override is available.
 */
function buildMoshClientCommand({ moshClientPath, host, port }) {
  if (!moshClientPath) throw new Error("buildMoshClientCommand: moshClientPath is required");
  if (!host) throw new Error("buildMoshClientCommand: host is required");
  if (!port || port <= 0) throw new Error("buildMoshClientCommand: port must be > 0");
  return { command: moshClientPath, args: [host, String(port)] };
}

/**
 * Lightweight stream sniffer: hands chunks in, emits MOSH CONNECT
 * details + the byte ranges that should be hidden from the user-
 * visible stream.
 *
 * Usage:
 *   const sniffer = createMoshConnectSniffer();
 *   for each chunk: const { visible, parsed } = sniffer.feed(chunk);
 *     send `visible` to renderer; if `parsed`, switch to mosh-client.
 *
 * Once a parse hits, every subsequent chunk passes through unchanged
 * (defensive: the bridge will tear down the SSH PTY immediately after
 * the parse so further chunks are unlikely, but we don't want to leak
 * partial copies of MOSH CONNECT lines if we somehow get more bytes).
 *
 * The sniffer keeps a trailing window of unmatched bytes (RING_SIZE) so
 * it can detect MOSH CONNECT spanning chunk boundaries.
 */
function createMoshConnectSniffer() {
  const RING_SIZE = 4096;
  const MAX_PROTOCOL_LINE = 512;
  let pending = "";
  let parsed = null;
  let moshHost = null;

  function makeParsed(connect) {
    const result = { port: connect.port, key: connect.key };
    if (moshHost) result.host = moshHost;
    return result;
  }

  function tryParseRemainder(text) {
    // ssh/mosh-server often exits right after printing MOSH CONNECT with no
    // trailing newline. Also try the unterminated remainder so Windows ConPTY
    // handshakes that end on the magic line still swap to mosh-client.
    if (!text) return null;
    const ip = parseMoshIpLine(text);
    if (ip) moshHost = ip;
    return parseConnectLine(text);
  }

  return {
    feed(chunk) {
      if (parsed) return { visible: chunk, parsed: null };

      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      pending += text;
      let visibleText = "";
      let consumed = 0;

      forEachCompleteLine(pending, ({ line, newline, startIndex, endIndex }) => {
        if (startIndex > consumed) {
          visibleText += pending.slice(consumed, startIndex);
        }

        const ip = parseMoshIpLine(line);
        if (ip) {
          moshHost = ip;
          consumed = endIndex;
          return;
        }

        const connect = parseConnectLine(line);
        if (connect) {
          parsed = makeParsed(connect);
          visibleText += line.slice(0, connect.matchStartOffset);
          const suffix = line.slice(connect.matchEndOffset);
          if (suffix) visibleText += suffix + newline;
          consumed = endIndex;
          return false;
        }

        visibleText += line + newline;
        consumed = endIndex;
      });

      if (parsed) {
        visibleText += pending.slice(consumed);
        pending = "";
        const visible = Buffer.isBuffer(chunk) ? Buffer.from(visibleText, "utf8") : visibleText;
        return { visible, parsed };
      }

      pending = pending.slice(consumed);

      // Do NOT parse an unterminated MOSH CONNECT here. A 22-char key prefix can
      // still receive trailing "==" padding in a later chunk; accepting early would
      // start mosh-client with a truncated MOSH_KEY (Codex review on #2028).
      // Unterminated recovery happens in flush() when the SSH PTY exits.

      const holdIndex = potentialProtocolStart(pending);
      if (holdIndex === -1) {
        visibleText += pending;
        pending = "";
      } else {
        visibleText += pending.slice(0, holdIndex);
        pending = pending.slice(holdIndex);
        if (pending.length > MAX_PROTOCOL_LINE) {
          visibleText += pending;
          pending = "";
        }
      }

      if (pending.length > RING_SIZE) {
        const overflow = pending.length - RING_SIZE;
        visibleText += pending.slice(0, overflow);
        pending = pending.slice(overflow);
      }
      const visible = Buffer.isBuffer(chunk) ? Buffer.from(visibleText, "utf8") : visibleText;
      return { visible, parsed: null };
    },
    /**
     * Drain any unterminated trailing protocol line when the SSH PTY exits.
     * Returns { visible, parsed } using the same shape as feed().
     */
    flush() {
      if (parsed || !pending) return { visible: "", parsed: null };
      const connect = tryParseRemainder(pending);
      if (connect) {
        parsed = makeParsed(connect);
        const visible = pending.slice(0, connect.matchStartOffset)
          + pending.slice(connect.matchEndOffset);
        pending = "";
        return { visible, parsed };
      }
      const visible = pending;
      pending = "";
      return { visible, parsed: null };
    },
    isParsed() { return parsed !== null; },
  };
}

/**
 * Assemble the env that `mosh-client` will see. MOSH_KEY is the secret
 * shared with mosh-server, and we preserve TERM + LANG so the local
 * terminfo lookups pick the right entry.
 */
function buildMoshClientEnv({ baseEnv, key, lang, fallbackHost }) {
  const env = { ...(baseEnv || {}), MOSH_KEY: key };
  delete env.MOSH_FALLBACK_HOST;
  if (fallbackHost) env.MOSH_FALLBACK_HOST = fallbackHost;
  if (lang && !env.LANG) env.LANG = lang;
  if (!env.TERM) env.TERM = "xterm-256color";
  return env;
}

/**
 * Resolve the absolute path of the system `ssh` binary. On Windows we
 * try the in-box OpenSSH location first because PATH may not list
 * it inside the Electron child env.
 */
function resolveSshExecutable({ findExecutable, fileExists, platform = process.platform }) {
  const fromPath = findExecutable("ssh");
  if (fromPath && fromPath !== "ssh" && fileExists(fromPath)) return fromPath;
  if (platform === "win32") {
    const sysRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    // Build with the win32-flavored path module so the result is
    // back-slash-joined regardless of the host platform we're running
    // the lookup from (relevant for cross-platform unit tests).
    const inbox = path.win32.join(sysRoot, "System32", "OpenSSH", "ssh.exe");
    if (fileExists(inbox)) return inbox;
  }
  return null;
}

module.exports = {
  parseMoshConnect,
  buildSshHandshakeCommand,
  buildMoshServerCommand,
  buildMoshClientCommand,
  createMoshConnectSniffer,
  buildMoshClientEnv,
  resolveSshExecutable,
};
