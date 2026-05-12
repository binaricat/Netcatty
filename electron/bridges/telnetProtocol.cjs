/**
 * Telnet protocol helpers — RFC 854 framing + RFC 858/1091/1184/1408 options.
 *
 * The pieces live here so the protocol layer can be exercised by unit tests
 * without spinning up a socket. terminalBridge.cjs owns the policy (which
 * options to enable, what TERM-TYPE to advertise, how to wire data back to
 * the renderer), this module owns the parsing.
 */

// Command bytes (RFC 854 / RFC 855).
const IAC = 255;
const SE = 240;
const NOP = 241;
const DM = 242;
const BRK = 243;
const IP = 244;
const AO = 245;
const AYT = 246;
const EC = 247;
const EL = 248;
const GA = 249;
const SB = 250;
const WILL = 251;
const WONT = 252;
const DO = 253;
const DONT = 254;

// Options we care about. Servers may negotiate plenty of others, but we only
// surface these to the policy layer; everything else is rejected with DONT/
// WONT so the conversation terminates cleanly.
const OPT = {
  ECHO: 1,                 // RFC 857
  SUPPRESS_GO_AHEAD: 3,    // RFC 858
  STATUS: 5,
  TERMINAL_TYPE: 24,       // RFC 1091
  NAWS: 31,                // RFC 1073 — window size
  TERMINAL_SPEED: 32,
  LINEMODE: 34,
  NEW_ENVIRON: 39,
};

const SUBOPTION_IS = 0;
const SUBOPTION_SEND = 1;

const isOptionCommand = (cmd) =>
  cmd === WILL || cmd === WONT || cmd === DO || cmd === DONT;

const commandName = (cmd) => {
  switch (cmd) {
    case IAC: return "IAC";
    case SE: return "SE";
    case NOP: return "NOP";
    case DM: return "DM";
    case BRK: return "BRK";
    case IP: return "IP";
    case AO: return "AO";
    case AYT: return "AYT";
    case EC: return "EC";
    case EL: return "EL";
    case GA: return "GA";
    case SB: return "SB";
    case WILL: return "WILL";
    case WONT: return "WONT";
    case DO: return "DO";
    case DONT: return "DONT";
    default: return String(cmd);
  }
};

/**
 * Escape a buffer for wire transmission: any literal 0xFF byte becomes
 * 0xFF 0xFF so the peer's parser does not treat it as IAC. Cheap fast-path
 * for the common case (no 0xFF bytes) so user typing — which is UTF-8 and
 * cannot contain 0xFF — pays nothing.
 */
function escapeIacForWire(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return buf;
  if (buf.indexOf(0xff) < 0) return buf;
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    out.push(buf[i]);
    if (buf[i] === 0xff) out.push(0xff);
  }
  return Buffer.from(out);
}

/**
 * Build a stateful Telnet parser.
 *
 * The parser preserves any partial command (IAC alone, IAC + verb without
 * option, or unterminated subnegotiation) between feeds so that a sequence
 * split across TCP frames is reassembled before being acted on. The previous
 * stateless approach would either drop the lone IAC or treat the tail of an
 * unterminated SB block as data — exactly the source of the garbled-output
 * symptom on chatty old equipment.
 *
 * Callbacks:
 *   onCommand(cmd, opt)        — WILL/WONT/DO/DONT for `opt`.
 *   onSubnegotiation(opt, buf) — IAC SB <opt> ... IAC SE. `buf` is the
 *                                 payload between option byte and IAC SE,
 *                                 with any IAC IAC unescaped to a single
 *                                 0xFF.
 *   onData(buf)                — clean stream bytes, IAC IAC already
 *                                 unescaped. Emitted in chunks coinciding
 *                                 with command boundaries; never empty.
 */
function createTelnetParser({ onCommand, onSubnegotiation, onData } = {}) {
  let pending = Buffer.alloc(0);

  const noop = () => {};
  const handleCommand = typeof onCommand === "function" ? onCommand : noop;
  const handleSubnegotiation = typeof onSubnegotiation === "function" ? onSubnegotiation : noop;
  const handleData = typeof onData === "function" ? onData : noop;

  const feed = (chunk) => {
    if (!chunk || chunk.length === 0) return;
    const buf = pending.length === 0
      ? (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      : Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    pending = Buffer.alloc(0);

    const out = [];
    let i = 0;
    const flushData = () => {
      if (out.length > 0) {
        handleData(Buffer.from(out));
        out.length = 0;
      }
    };

    while (i < buf.length) {
      const byte = buf[i];
      if (byte !== IAC) {
        out.push(byte);
        i++;
        continue;
      }

      // We are at an IAC byte. Need at least one more byte to know the verb.
      if (i + 1 >= buf.length) {
        pending = buf.subarray(i);
        break;
      }

      const cmd = buf[i + 1];

      if (cmd === IAC) {
        // Escaped literal 0xFF in the data stream.
        out.push(0xff);
        i += 2;
        continue;
      }

      if (isOptionCommand(cmd)) {
        if (i + 2 >= buf.length) {
          pending = buf.subarray(i);
          break;
        }
        const opt = buf[i + 2];
        flushData();
        handleCommand(cmd, opt);
        i += 3;
        continue;
      }

      if (cmd === SB) {
        // Subnegotiation: IAC SB <opt> <payload...> IAC SE. We need to find
        // the terminating IAC SE while ignoring escaped IAC IAC inside the
        // payload (RFC 855).
        let j = i + 3;
        let seFound = false;
        while (j + 1 < buf.length) {
          if (buf[j] === IAC) {
            if (buf[j + 1] === SE) {
              seFound = true;
              break;
            }
            // Escaped IAC IAC in payload, or another IAC verb (rare,
            // ignored). Either way, skip two bytes and keep scanning.
            j += 2;
            continue;
          }
          j++;
        }
        if (!seFound) {
          // Subnegotiation continues into the next frame.
          pending = buf.subarray(i);
          break;
        }
        if (i + 2 >= buf.length) {
          pending = buf.subarray(i);
          break;
        }
        const opt = buf[i + 2];
        const rawPayload = buf.subarray(i + 3, j);
        const payload = unescapeIacFromPayload(rawPayload);
        flushData();
        handleSubnegotiation(opt, payload);
        i = j + 2;
        continue;
      }

      // Other single-verb IAC commands (NOP, AYT, IP, ...). The protocol
      // does not require us to act, but we must still consume the two bytes
      // so they do not leak into the data stream.
      flushData();
      i += 2;
    }

    flushData();
  };

  return {
    feed,
    get pendingByteCount() {
      return pending.length;
    },
    /** Reset state — used when a session is torn down or reconnected. */
    reset() {
      pending = Buffer.alloc(0);
    },
  };
}

function unescapeIacFromPayload(buf) {
  if (!buf || buf.indexOf(0xff) < 0) return buf;
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0xff && i + 1 < buf.length && buf[i + 1] === 0xff) {
      out.push(0xff);
      i++;
      continue;
    }
    out.push(buf[i]);
  }
  return Buffer.from(out);
}

/**
 * Build a Telnet negotiation policy machine.
 *
 * The machine owns the rules for which options we accept, the
 * direction-aware acknowledgement tracking, and the wire bytes sent in
 * response to peer commands. It is intentionally separated from socket I/O
 * so it can be exercised directly in unit tests.
 *
 * `writeCommand(cmd, opt)` is invoked to send `IAC <cmd> <opt>` on the
 * wire; `writeSubnegotiation(opt, payload)` is invoked to send
 * `IAC SB <opt> <payload...> IAC SE` (with `payload` already escaped if
 * needed by the caller); `getWindowSize()` returns `{ cols, rows }` for
 * the current terminal dimensions; `termType` is the string advertised
 * for TERMINAL-TYPE subnegotiation (default "XTERM-256COLOR").
 */
function createTelnetNegotiator({
  writeCommand,
  writeSubnegotiation,
  getWindowSize,
  termType = "XTERM-256COLOR",
} = {}) {
  const pendingDoRequests = new Set();
  const pendingWillRequests = new Set();

  const noopWrite = () => {};
  const cmdSink = typeof writeCommand === "function" ? writeCommand : noopWrite;
  const sbSink = typeof writeSubnegotiation === "function" ? writeSubnegotiation : noopWrite;
  const sizeFn = typeof getWindowSize === "function"
    ? getWindowSize
    : () => ({ cols: 80, rows: 24 });

  const naws = () => {
    const { cols, rows } = sizeFn() || {};
    const safeCols = Number.isFinite(cols) && cols > 0 ? cols : 80;
    const safeRows = Number.isFinite(rows) && rows > 0 ? rows : 24;
    const payload = Buffer.from([
      (safeCols >> 8) & 0xff, safeCols & 0xff,
      (safeRows >> 8) & 0xff, safeRows & 0xff,
    ]);
    sbSink(OPT.NAWS, escapeIacForWire(payload));
  };

  const sendTerminalType = () => {
    sbSink(
      OPT.TERMINAL_TYPE,
      Buffer.concat([
        Buffer.from([SUBOPTION_IS]),
        Buffer.from(String(termType), "ascii"),
      ]),
    );
  };

  const requestOption = (cmd, opt) => {
    if (cmd === DO) pendingDoRequests.add(opt);
    else if (cmd === WILL) pendingWillRequests.add(opt);
    cmdSink(cmd, opt);
  };

  const start = () => {
    // Drive the negotiation rather than waiting for the peer. Many legacy
    // servers will not advance past their banner until the client commits
    // to a basic option set.
    requestOption(DO, OPT.SUPPRESS_GO_AHEAD);
    requestOption(WILL, OPT.TERMINAL_TYPE);
    requestOption(WILL, OPT.NAWS);
  };

  const handleCommand = (cmd, opt) => {
    let acknowledgesOurRequest = false;
    if ((cmd === WILL || cmd === WONT) && pendingDoRequests.has(opt)) {
      pendingDoRequests.delete(opt);
      acknowledgesOurRequest = true;
    } else if ((cmd === DO || cmd === DONT) && pendingWillRequests.has(opt)) {
      pendingWillRequests.delete(opt);
      acknowledgesOurRequest = true;
    }

    if (cmd === WILL) {
      if (!acknowledgesOurRequest) {
        if (opt === OPT.SUPPRESS_GO_AHEAD || opt === OPT.ECHO) {
          cmdSink(DO, opt);
        } else {
          cmdSink(DONT, opt);
        }
      }
      return;
    }

    if (cmd === DO) {
      if (opt === OPT.NAWS) {
        if (!acknowledgesOurRequest) cmdSink(WILL, opt);
        // Always follow through with the actual size, whether this DO is the
        // peer's reply to our WILL or an independent fresh request.
        naws();
      } else if (opt === OPT.TERMINAL_TYPE || opt === OPT.SUPPRESS_GO_AHEAD) {
        if (!acknowledgesOurRequest) cmdSink(WILL, opt);
      } else {
        if (!acknowledgesOurRequest) cmdSink(WONT, opt);
      }
      return;
    }

    if (cmd === DONT) {
      if (!acknowledgesOurRequest) cmdSink(WONT, opt);
      return;
    }

    if (cmd === WONT) {
      if (!acknowledgesOurRequest) cmdSink(DONT, opt);
      return;
    }
  };

  const handleSubnegotiation = (opt, payload) => {
    if (opt === OPT.TERMINAL_TYPE
      && payload && payload.length > 0
      && payload[0] === SUBOPTION_SEND) {
      sendTerminalType();
    }
  };

  return {
    start,
    handleCommand,
    handleSubnegotiation,
    sendWindowSize: naws,
    /** Test/debug introspection — number of options awaiting a reply per direction. */
    get pendingDoCount() {
      return pendingDoRequests.size;
    },
    get pendingWillCount() {
      return pendingWillRequests.size;
    },
  };
}

module.exports = {
  // Command constants
  IAC,
  SE,
  NOP,
  DM,
  BRK,
  IP,
  AO,
  AYT,
  EC,
  EL,
  GA,
  SB,
  WILL,
  WONT,
  DO,
  DONT,
  // Options
  OPT,
  SUBOPTION_IS,
  SUBOPTION_SEND,
  // Helpers
  commandName,
  escapeIacForWire,
  createTelnetParser,
  createTelnetNegotiator,
};
