"use strict";

/**
 * ZMODEM receive fast path for zmodem.js (0.1.10).
 *
 * The library processes every incoming byte as an element of a
 * JavaScript number[] array: Sentry.consume() converts Buffers with
 * `Array.prototype.slice.call(new Uint8Array(input))`, subpackets are
 * ZDLE-decoded and CRC-checked with per-byte JS loops, and the decoded
 * payloads are handed to on_input as number[] again. That costs tens of
 * JS ops per byte and caps `sz` download throughput in the low tens of
 * MB/s even though ssh2 can deliver ~100MB/s. The fast path deliberately
 * keeps receive payloads as Uint8Array instances so the download bridge can
 * pass them to the file stream without another full-payload copy.
 *
 * This module patches the library's prototypes so that while a receive
 * session is streaming ZDATA subpackets, bytes stay as Buffers the whole
 * way: the frame-end scan uses Buffer.indexOf (native memchr), the
 * payload is ZDLE-decoded into a fresh Uint8Array in one pass, and
 * CRC16/CRC32 run over typed arrays with precomputed tables. Headers are
 * tiny and rare, so they keep the original array-based pipeline
 * untouched — protocol state machines, error recovery, wire bytes, and
 * event ordering behave exactly as before. The receive payload container is
 * intentionally Uint8Array on this path for throughput.
 *
 * The same module also carries `applyZmodemSendSessionFixes()`, which
 * patches zmodem.js Send-session correctness hazards that make `rz`
 * uploads fail intermittently. Those are protocol fixes, not a
 * throughput fast path, and are not gated by the kill-switch below.
 *
 * Kill-switch: set NETCATTY_ZMODEM_FAST_PATH=0 to disable both performance
 * fast paths. The send-session correctness fixes remain enabled.
 */

const ZDLE = 0x18;
const XON = 0x11;
const XOFF = 0x13;
const XON_HIGH = XON | 0x80; // 0x91
const XOFF_HIGH = XOFF | 0x80; // 0x93
const OVER_AND_OUT = [79, 79]; // "OO"

// frame-end byte (104-107) → Subpacket.build() frameend key
const FRAME_END_KEYS = {
  104: "end_no_ack", // ZCRCE - frame ends, no ack
  105: "no_end_no_ack", // ZCRCG - frame continues
  106: "no_end_ack", // ZCRCQ - frame continues, ack expected
  107: "end_ack", // ZCRCW - frame ends, ack expected
};

const EMPTY_BUFFER = Buffer.alloc(0);

function isFastPathDisabled() {
  return process.env.NETCATTY_ZMODEM_FAST_PATH === "0";
}

//----------------------------------------------------------------------
// CRC16 (CRC-CCITT/XModem) — replicates zcrc.js `_compute_crctab()`.
//----------------------------------------------------------------------
const CRC16_TABLE = new Uint32Array(256);
for (let divident = 0; divident < 256; divident++) {
  let currByte = (divident << 8) & 0xffff;
  for (let bit = 0; bit < 8; bit++) {
    currByte =
      currByte & 0x8000
        ? ((currByte << 1) ^ 0x1021) & 0xffff
        : (currByte << 1) & 0xffff;
  }
  CRC16_TABLE[divident] = currByte;
}

//----------------------------------------------------------------------
// CRC32 (standard reflected, poly 0xEDB88320) — matches the crc-32
// package that zmodem.js uses via `CRC32_MOD.buf()`.
//----------------------------------------------------------------------
const CRC32_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[n] = c >>> 0;
}

/** One CRC16 step; identical to zcrc.js `_updcrc()`. */
function crc16Step(crc, byte) {
  return CRC16_TABLE[(crc >> 8) & 255] ^ ((255 & crc) << 8) ^ byte;
}

/**
 * CRC16 over decoded payload + frame-end byte, including the two
 * zero-byte passes that zmodem.js `CRC.crc16()` appends.
 *
 * TABLE[0] is 0, so seeding with 0 and updating with the first byte is
 * equivalent to the library seeding with the first byte.
 */
function crc16Bytes(payload, frameEndNum) {
  let crc = 0;
  for (let i = 0; i < payload.length; i++) {
    crc = crc16Step(crc, payload[i]);
  }
  crc = crc16Step(crc, frameEndNum);
  crc = crc16Step(crc, 0);
  crc = crc16Step(crc, 0);
  return crc & 0xffff;
}

/** CRC32 over decoded payload + frame-end byte (standard init/final xor). */
function crc32Bytes(payload, frameEndNum) {
  let crc = 0xffffffff;
  for (let i = 0; i < payload.length; i++) {
    crc = CRC32_TABLE[(crc ^ payload[i]) & 255] ^ (crc >>> 8);
  }
  crc = CRC32_TABLE[(crc ^ frameEndNum) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * ZDLE-decode `u8` into a fresh Uint8Array.
 *
 * Decoding is `second_byte - 64`, exactly like zmodem.js's
 * `octets[o + 1] - 64`. (XOR 0x40 would only be equivalent for escaped
 * values < 0x80; conforming encoders never emit escape pairs whose
 * second byte is in 0x80-0xBF, but we replicate the library verbatim.)
 * A trailing bare ZDLE is malformed input; it decodes to ZDLE-64 here
 * and the CRC check downstream rejects it, same as the library.
 */
function zdleDecode(u8) {
  const out = new Uint8Array(u8.length); // never longer than encoded
  let w = 0;
  for (let i = 0; i < u8.length; i++) {
    let b = u8[i];
    if (b === ZDLE) {
      i += 1;
      b = u8[i] - 64;
    }
    out[w++] = b;
  }
  return out.subarray(0, w);
}

/**
 * Read `count` ZDLE-decoded bytes starting at `start` in `u8`.
 *
 * Returns null if the encoded bytes aren't fully available (including a
 * trailing bare ZDLE), mirroring `Zmodem.ZDLE.splice()`.
 */
function readDecodedBytes(u8, start, count) {
  const bytes = new Uint8Array(count);
  let i = start;
  let got = 0;
  while (got < count) {
    if (i >= u8.length) return null;
    let b = u8[i];
    if (b === ZDLE) {
      i += 1;
      if (i >= u8.length) return null; // bare trailing ZDLE
      b = u8[i] - 64;
    }
    bytes[got++] = b;
    i += 1;
  }
  return { bytes, consumed: i - start };
}

/**
 * Replicates Zmodem.ZMLIB.strip_ignored_bytes() (XON/XOFF and their
 * high-bit variants) without the per-byte Array.splice().
 * Zero-copy when there's nothing to strip.
 */
function stripIgnoredBytesFast(u8) {
  let dirty = false;
  for (let i = 0; i < u8.length; i++) {
    const b = u8[i];
    if (b === XON || b === XON_HIGH || b === XOFF || b === XOFF_HIGH) {
      dirty = true;
      break;
    }
  }
  if (!dirty) return u8;

  const out = new Uint8Array(u8.length);
  let w = 0;
  for (let i = 0; i < u8.length; i++) {
    const b = u8[i];
    if (b === XON || b === XON_HIGH || b === XOFF || b === XOFF_HIGH) {
      continue;
    }
    out[w++] = b;
  }
  return out.subarray(0, w);
}

/**
 * Fast equivalent of zsubpacket.js `Subpacket._parse()` for Buffer input.
 *
 * - Returns null when the buffer doesn't (yet) hold a complete subpacket
 *   (i.e., the caller should keep accumulating bytes).
 * - Throws `new Zmodem.Error("crc", got, expected)` on a CRC mismatch,
 *   exactly like the library's CRC.verify16()/verify32().
 *
 * @param {Object} Zmodem - The zmodem.js module (used for
 *     Subpacket.build() and the Zmodem.Error class).
 * @param {Buffer} buf - Encoded bytes, starting at a subpacket boundary.
 * @param {number} crcLen - 2 for CRC16, 4 for CRC32.
 * @returns {{ subpacket: Object, consumed: number } | null}
 */
function parseSubpacketFast(Zmodem, buf, crcLen) {
  // Find the first ZDLE followed by a frame-end byte (104-107). ZDLE
  // escaping guarantees no payload byte can decode to a frame-end value,
  // so the first such pair is the marker — the same scan the library
  // does in Subpacket._parse().
  let zdleAt = -1;
  let frameEndKey = null;
  let frameEndNum = 0;
  while (true) {
    zdleAt = buf.indexOf(ZDLE, zdleAt + 1);
    if (zdleAt === -1) return null; // no marker yet → need more data
    if (zdleAt + 1 >= buf.length) return null; // trailing ZDLE → need more data
    frameEndNum = buf[zdleAt + 1];
    frameEndKey = FRAME_END_KEYS[frameEndNum];
    if (frameEndKey) break;
  }

  // Payload is everything before the marker's ZDLE, ZDLE-decoded.
  const payload = zdleDecode(buf.subarray(0, zdleAt));

  // The CRC bytes follow the marker and are individually escaped.
  const got = readDecodedBytes(buf, zdleAt + 2, crcLen);
  if (!got) return null; // CRC straddles chunks → need more data

  // Verify the CRC over decoded payload + frame-end byte.
  let expected;
  if (crcLen === 2) {
    const v = crc16Bytes(payload, frameEndNum);
    expected = [(v >> 8) & 0xff, v & 0xff];
  } else {
    const v = crc32Bytes(payload, frameEndNum);
    expected = [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
  }
  for (let i = 0; i < crcLen; i++) {
    if (got.bytes[i] !== expected[i]) {
      throw new Zmodem.Error(
        "crc",
        Array.prototype.slice.call(got.bytes),
        expected,
      );
    }
  }

  // Keep the decoded payload typed through the fast receive path. The
  // application download handler turns this into a zero-copy Buffer view;
  // converting to a number[] here would erase the throughput gain with a
  // full payload allocation on every subpacket.
  const subpacket = Zmodem.Subpacket.build(payload, frameEndKey);
  return { subpacket, consumed: zdleAt + 2 + got.consumed };
}

/** Replicates `_trim_OO()` from zsession.js. */
function trimOverAndOut(Zmodem, array) {
  if (0 === Zmodem.ZMLIB.find_subarray(array, OVER_AND_OUT)) {
    array.splice(0, OVER_AND_OUT.length);
  } else if (array[0] === OVER_AND_OUT[OVER_AND_OUT.length - 1]) {
    array.splice(0, 1);
  }
  return array;
}

/**
 * zsentry.js declares its Detection class privately; the patched
 * Sentry.consume() needs to hand on_detect a Detection object of the
 * same shape. Recreate it faithfully (confirm/deny/is_valid/
 * get_session_role — callers only ever use these methods).
 */
class Detection {
  constructor(session_type, accepter, denier, checker) {
    this._confirmer = accepter;
    this._denier = denier;
    this._is_valid = checker;
    this._session_type = session_type;
  }

  confirm() {
    return this._confirmer.apply(this, arguments);
  }

  deny() {
    return this._denier.apply(this, arguments);
  }

  is_valid() {
    return this._is_valid.apply(this, arguments);
  }

  get_session_role() {
    return this._session_type;
  }
}

//----------------------------------------------------------------------
// The patch itself.
//----------------------------------------------------------------------

/**
 * Patch zmodem.js so receive sessions consume Buffers on a fast path.
 *
 * Safe to call more than once (idempotent), and a no-op when the
 * NETCATTY_ZMODEM_FAST_PATH kill-switch is set.
 *
 * @param {Object} Zmodem - The zmodem.js module, as returned by require().
 * @returns {Object} The same module object, patched (or not).
 */
function applyZmodemFastPath(Zmodem) {
  // Kill-switch for diagnosing protocol trouble in the field.
  if (isFastPathDisabled()) return Zmodem;
  if (Zmodem.__netcattyZmodemFastPathApplied) return Zmodem;

  const sentryProto = Zmodem?.Sentry?.prototype;
  const sessionProto = Zmodem?.Session?.prototype;
  if (
    !sentryProto ||
    !sessionProto ||
    typeof sentryProto.consume !== "function" ||
    typeof sessionProto.consume !== "function" ||
    !Zmodem.ZMLIB?.ABORT_SEQUENCE
  ) {
    return Zmodem;
  }

  const ORIGINAL_SENTRY_CONSUME = sentryProto.consume;
  const ORIGINAL_SESSION_CONSUME = sessionProto.consume;
  const ABORT_SEQUENCE_BUF = Buffer.from(Zmodem.ZMLIB.ABORT_SEQUENCE);

  //--------------------------------------------------------------------
  // Session-level helpers. Bytes are kept in `_zmodem_fast_chunks`, a
  // list of zero-copy Buffer views of the incoming chunks; consumed
  // prefixes are dropped with subarray() instead of array.splice().
  //--------------------------------------------------------------------

  function fastPush(u8) {
    if (!u8.length) return;
    if (!this._zmodem_fast_chunks) this._zmodem_fast_chunks = [];
    this._zmodem_fast_chunks.push(
      Buffer.isBuffer(u8)
        ? u8
        : Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength),
    );
    this._zmodem_fast_length = (this._zmodem_fast_length || 0) + u8.length;
  }

  /** A single Buffer with all pending fast bytes (concats on demand). */
  function fastContiguous() {
    const chunks = this._zmodem_fast_chunks;
    if (!chunks || !chunks.length) return EMPTY_BUFFER;
    if (chunks.length > 1) {
      this._zmodem_fast_chunks = [Buffer.concat(chunks)];
      // The chunk-index cursors refer to the old list. The frame marker, if
      // any, is intentionally retained while its CRC bytes are still pending;
      // the abort scan must restart on the merged buffer.
      this._zmodem_fast_sequence_scan = null;
    }
    return this._zmodem_fast_chunks[0];
  }

  function fastLen() {
    return this._zmodem_fast_length || 0;
  }

  /** Find a small byte sequence incrementally without flattening chunks. */
  function fastFindSequence(needle) {
    const chunks = this._zmodem_fast_chunks;
    if (!chunks || !chunks.length || !needle.length) return -1;
    let scan = this._zmodem_fast_sequence_scan;
    if (!scan || scan.needle !== needle) {
      scan = { needle, chunkIndex: 0, byteIndex: 0, offset: 0, matched: 0 };
      this._zmodem_fast_sequence_scan = scan;
    }
    for (let chunkIndex = scan.chunkIndex; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex];
      const start = chunkIndex === scan.chunkIndex ? scan.byteIndex : 0;
      for (let i = start; i < chunk.length; i++) {
        const byte = chunk[i];
        const offset = scan.offset++;
        if (byte === needle[scan.matched]) {
          scan.matched += 1;
          if (scan.matched === needle.length) return offset - needle.length + 1;
        } else {
          scan.matched = byte === needle[0] ? 1 : 0;
        }
      }
      scan.chunkIndex = chunkIndex + 1;
      scan.byteIndex = 0;
    }
    scan.chunkIndex = chunks.length;
    scan.byteIndex = 0;
    return -1;
  }

  /** Find a ZDLE frame-end marker incrementally without flattening a packet. */
  function fastFindFrameEnd() {
    const chunks = this._zmodem_fast_chunks;
    if (!chunks || !chunks.length) return -1;
    const existing = this._zmodem_fast_frame_end_at;
    if (existing !== undefined) return existing;
    let scan = this._zmodem_fast_frame_scan;
    if (!scan) {
      scan = { chunkIndex: 0, byteIndex: 0, offset: 0, previousWasZdle: false };
      this._zmodem_fast_frame_scan = scan;
    }
    for (let chunkIndex = scan.chunkIndex; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex];
      const start = chunkIndex === scan.chunkIndex ? scan.byteIndex : 0;
      for (let i = start; i < chunk.length; i++) {
        const byte = chunk[i];
        const offset = scan.offset++;
        if (scan.previousWasZdle && FRAME_END_KEYS[byte]) {
          this._zmodem_fast_frame_end_at = offset - 1;
          return this._zmodem_fast_frame_end_at;
        }
        scan.previousWasZdle = byte === ZDLE;
      }
      scan.chunkIndex = chunkIndex + 1;
      scan.byteIndex = 0;
    }
    scan.chunkIndex = chunks.length;
    scan.byteIndex = 0;
    return -1;
  }

  /** Drop the first `n` fast bytes (like Array.splice(0, n)). */
  function fastConsumeAt(n) {
    const chunks = this._zmodem_fast_chunks;
    const available = this._zmodem_fast_length || 0;
    const toConsume = Math.min(Math.max(0, n), available);
    while (n > 0 && chunks.length) {
      const head = chunks[0];
      if (head.length > n) {
        chunks[0] = head.subarray(n);
        n = 0;
      } else {
        chunks.shift();
        n -= head.length;
      }
    }
    this._zmodem_fast_length = available - toConsume;
    this._zmodem_fast_frame_end_at = undefined;
    this._zmodem_fast_frame_scan = null;
    this._zmodem_fast_sequence_scan = null;
  }

  /** Move all pending fast bytes into `_input_buffer` (header parsing). */
  function fastMoveAllToArray() {
    const buf = this._zmodem_fast_contiguous();
    this._zmodem_fast_chunks = [];
    this._zmodem_fast_length = 0;
    this._zmodem_fast_frame_end_at = undefined;
    this._zmodem_fast_frame_scan = null;
    this._zmodem_fast_sequence_scan = null;
    // push.apply() takes up to ~32k args per call; chunk defensively.
    for (let i = 0; i < buf.length; i += 0x8000) {
      Array.prototype.push.apply(this._input_buffer, buf.subarray(i, i + 0x8000));
    }
  }

  /**
   * Move array-side bytes back into the fast chunks, before them.
   * Used when a ZDATA header and its first subpacket(s) arrive in one
   * chunk: the header parser leaves the data bytes in `_input_buffer`,
   * and they must be consumed in stream order.
   */
  function fastMoveArrayToFast() {
    if (!this._input_buffer.length) return;
    const arr = this._input_buffer.splice(0);
    if (!this._zmodem_fast_chunks) this._zmodem_fast_chunks = [];
    this._zmodem_fast_chunks.unshift(Buffer.from(arr));
    this._zmodem_fast_length = arr.length + (this._zmodem_fast_length || 0);
    this._zmodem_fast_frame_end_at = undefined;
    this._zmodem_fast_frame_scan = null;
    this._zmodem_fast_sequence_scan = null;
  }

  /** Mirrors `_check_for_abort_sequence()`. */
  function fastCheckAbort() {
    // Header parsing leaves incomplete frames in _input_buffer. Before a
    // fast chunk is parsed, move it beside that buffered prefix so CAN x5
    // is detected even when the cancel sequence crosses the boundary.
    // This also lets the upstream helper own the removal semantics.
    if (this._input_buffer.length) {
      this._zmodem_fast_move_all_to_array();
      return this._check_for_abort_sequence();
    }

    const at = this._zmodem_fast_find_sequence(ABORT_SEQUENCE_BUF);
    if (at === -1) return false;

    this._zmodem_fast_consume_at(at + ABORT_SEQUENCE_BUF.length);
    this._aborted = true;
    this._on_session_end();
    throw new Zmodem.Error("peer_aborted");
  }

  /** Mirrors `_parse_and_consume_subpacket()`, parsing from fast bytes. */
  function fastParseSubpacket() {
    if (this._zmodem_fast_find_frame_end() === -1) return null;
    const buf = this._zmodem_fast_contiguous();

    const crcLen = this._last_header_crc === 16 ? 2 : 4;
    const parsed = parseSubpacketFast(Zmodem, buf, crcLen);
    if (!parsed) return null;

    this._zmodem_fast_consume_at(parsed.consumed);

    if (Zmodem.DEBUG) {
      console.debug(this.type, "RECEIVED SUBPACKET", parsed.subpacket);
    }

    this._consume_data(parsed.subpacket);

    if (parsed.subpacket.frame_end()) {
      this._next_subpacket_handler = null;
    }

    return parsed.subpacket;
  }

  /** Mirrors the `_consume_first()` do-while for the receive path. */
  function fastConsumeLoop() {
    while (true) {
      if (this._next_subpacket_handler) {
        // A ZDATA header and its first subpacket may have arrived in one
        // chunk and been routed through the array pipeline; pull those
        // bytes back in order before fast-parsing.
        this._zmodem_fast_move_array_to_fast();

        if (!this._zmodem_fast_len()) break;
        if (!this._zmodem_fast_parse_subpacket()) break;
      } else {
        // Headers are tiny and rare; hand bytes to the original
        // array-based header pipeline.
        this._zmodem_fast_move_all_to_array();

        if (!this._input_buffer.length) break;
        if (!this._parse_and_consume_header()) break;
      }
    }
  }

  /**
   * Fast equivalent of Session.consume() for a receive session fed
   * with Uint8Array/Buffer input.
   */
  function fastSessionConsume(octets) {
    this._before_consume(octets);

    if (this._aborted) throw new Zmodem.Error("already_aborted");
    if (!octets.length) return;

    // Replicates _strip_and_enqueue_input(). The original path strips
    // `octets` in place and keeps that same reference as
    // _bytes_being_consumed; keep the stripped bytes so the post-"OO"
    // trailing-bytes logic sees the same thing (per chunk, as before).
    const stripped = stripIgnoredBytesFast(octets);
    this._bytes_being_consumed = stripped;

    this._zmodem_fast_push(stripped);

    // The original Session.consume() checks for CAN x5 before its special
    // post-ZFIN OO handling. Preserve that ordering on the fast path.
    this._zmodem_fast_check_abort();

    if (this._got_ZFIN) {
      // Session is ending: only "OO" + trailing prompt bytes may follow.
      // _trim_OO() and the header parser use Array.splice(), so route
      // through the array pipeline (once, at session end).
      this._zmodem_fast_move_all_to_array();

      if (this._input_buffer.length < 2) return;

      if (Zmodem.ZMLIB.find_subarray(this._input_buffer, OVER_AND_OUT) === 0) {
        // This doubles as an indication that the session has ended.
        this._bytes_after_OO = trimOverAndOut(
          Zmodem,
          Array.prototype.slice.call(this._bytes_being_consumed),
        );
        this._on_session_end();
        return;
      }

      throw (
        "PROTOCOL: Only thing after ZFIN should be “OO” (79,79), not: " +
        this._input_buffer.join()
      );
    }

    this._zmodem_fast_consume_loop();
  }

  try {
    sentryProto.consume = function consume(input) {
      let consumedViaFastPath = false;

      if (!(input instanceof Array)) {
        if (this._zsession && input instanceof Uint8Array) {
          // Fast path: hand raw bytes straight to the session instead of
          // converting every byte into a JS-array element (that
          // conversion is what caps receive throughput). The session
          // falls back to the original pipeline internally for send
          // sessions and array input.
          consumedViaFastPath = true;

          const session = this._zsession;
          session.consume(input);

          if (!session.has_ended()) return;

          if (session.type === "receive") {
            input = session.get_trailing_bytes();
          } else {
            input = [];
          }
        } else {
          input = Array.prototype.slice.call(new Uint8Array(input));
        }
      }

      // Everything below is verbatim from the library's Sentry.consume()
      // (zsentry.js), minus the fast-path branch above.
      if (this._zsession && !consumedViaFastPath) {
        var session_before_consume = this._zsession;

        session_before_consume.consume(input);

        if (session_before_consume.has_ended()) {
          if (session_before_consume.type === "receive") {
            input = session_before_consume.get_trailing_bytes();
          } else {
            input = [];
          }
        } else return;
      }

      var new_session = this._parse(input);
      var to_terminal = input;

      if (new_session) {
        let replacement_detect = !!this._parsed_session;

        if (replacement_detect) {
          //no terminal output if the new session is of the
          //same type as the old
          if (this._parsed_session.type === new_session.type) {
            to_terminal = [];
          }

          this._on_retract();
        }

        this._parsed_session = new_session;

        var sentry = this;

        function checker() {
          return sentry._parsed_session === new_session;
        }

        //This runs with the Sentry object as the context.
        function accepter() {
          if (!this.is_valid()) {
            throw "Stale ZMODEM session!";
          }

          new_session.on("garbage", sentry._to_terminal);

          new_session.on(
            "session_end",
            sentry._after_session_end.bind(sentry),
          );

          new_session.set_sender(sentry._sender);

          delete sentry._parsed_session;

          return (sentry._zsession = new_session);
        }

        function denier() {
          if (!this.is_valid()) return;
        }

        this._on_detect(
          new Detection(
            new_session.type,
            accepter,
            this._send_abort.bind(this),
            checker,
          ),
        );
      } else {
        var expired_session = this._parsed_session;

        this._parsed_session = null;

        if (expired_session) {
          //If we got a single “C” after parsing a session,
          //that means our peer is trying to downgrade to YMODEM.
          //That won’t work, so we just send the ABORT_SEQUENCE
          //right away.
          if (to_terminal.length === 1 && to_terminal[0] === 67) {
            this._send_abort();
          }

          this._on_retract();
        }
      }

      this._to_terminal(to_terminal);
    };

    sessionProto.consume = function consume(octets) {
      if (this.type === "receive" && octets instanceof Uint8Array) {
        return this._zmodem_fast_consume(octets);
      }

      // Everything else (send sessions, array input) keeps the original
      // pipeline.
      return ORIGINAL_SESSION_CONSUME.call(
        this,
        octets instanceof Uint8Array
          ? Array.prototype.slice.call(octets)
          : octets,
      );
    };

    Object.assign(sessionProto, {
      _zmodem_fast_consume: fastSessionConsume,
      _zmodem_fast_push: fastPush,
      _zmodem_fast_contiguous: fastContiguous,
      _zmodem_fast_len: fastLen,
      _zmodem_fast_find_sequence: fastFindSequence,
      _zmodem_fast_find_frame_end: fastFindFrameEnd,
      _zmodem_fast_consume_at: fastConsumeAt,
      _zmodem_fast_move_all_to_array: fastMoveAllToArray,
      _zmodem_fast_move_array_to_fast: fastMoveArrayToFast,
      _zmodem_fast_check_abort: fastCheckAbort,
      _zmodem_fast_parse_subpacket: fastParseSubpacket,
      _zmodem_fast_consume_loop: fastConsumeLoop,
    });

    Zmodem.__netcattyZmodemFastPathApplied = true;
  } catch (err) {
    // Never break ZMODEM transfers over a patch problem.
    sentryProto.consume = ORIGINAL_SENTRY_CONSUME;
    sessionProto.consume = ORIGINAL_SESSION_CONSUME;
    console.error(
      "[ZMODEM] fast path patch failed; using original pipeline:",
      err && err.message ? err.message : err,
    );
  }

  return Zmodem;
}

//----------------------------------------------------------------------
// Send-session robustness fixes (rz upload path)
//----------------------------------------------------------------------
//
// zmodem.js's Send session has a few hazards that make `rz` uploads fail
// intermittently:
//
// 1. Duplicate-ZSINIT race: send_offer() -> _ensure_receiver_escapes_ctrl_chars()
//    sends a ZSINIT whenever the receiver's ZRINIT lacks ESCCTL and no ZACK
//    has been seen yet, without checking whether the 5s keepalive just sent
//    one. rz ACKs both ZSINITs; the second ZACK lands in a handler state that
//    no longer expects it and consume() throws "Unhandled header: ZACK",
//    killing the upload mid-transfer. Fix: track an in-flight ZSINIT
//    (_zsinit_pending) and share its ZACK instead of sending a duplicate.
//
// 2. Shared-ACK plumbing: the keepalive's ZACK handler only sets
//    _got_ZSINIT_ZACK, so a waiter parked on a pending ZSINIT (from #1)
//    would never wake up. All send-session ZACKs now route through
//    _on_zsinit_ack(), which sets the flag and flushes every waiter.
//
// 3. _stop_keepalive() nulls _keep_alive_promise (typo) instead of
//    _keepalive_promise, so the keepalive can never restart after the first
//    offer. Fix the field name.
//
// These are protocol-correctness fixes, not a throughput fast path, so they
// are not gated by NETCATTY_ZMODEM_FAST_PATH.

function applyZmodemSendSessionFixes(Zmodem) {
  if (Zmodem.__netcattyZmodemSendSessionFixesApplied) return Zmodem;

  const Send = Zmodem.Session && Zmodem.Session.Send;
  if (!Send) return Zmodem;
  const proto = Send.prototype;
  if (
    [
      proto._send_ZSINIT,
      proto._start_keepalive,
      proto._stop_keepalive,
      proto._ensure_receiver_escapes_ctrl_chars,
    ].some((method) => typeof method !== "function")
  ) {
    return Zmodem;
  }

  const ORIGINAL_SEND_ZSINIT = proto._send_ZSINIT;
  const ORIGINAL_START_KEEPALIVE = proto._start_keepalive;
  const ORIGINAL_STOP_KEEPALIVE = proto._stop_keepalive;
  const ORIGINAL_ENSURE_ESCAPES = proto._ensure_receiver_escapes_ctrl_chars;

  // Deliberately leave _consume_ZRINIT untouched. A non-zero receiver
  // buffer requires ZCRCW/ZACK pacing; TCP backpressure is not equivalent.
  // The upstream fail-closed check prevents silent receiver-buffer overrun
  // until a protocol-level window implementation is added.

  try {
    // One shared ACK path for every ZSINIT (keepalive or offer-time).
    proto._on_zsinit_ack = function _on_zsinit_ack() {
      this._got_ZSINIT_ZACK = true;
      this._zsinit_pending = false;
      const waiters = this._zsinit_ack_waiters;
      this._zsinit_ack_waiters = null;
      if (waiters) {
        for (const res of waiters) {
          try {
            res();
          } catch {
            /* ignore */
          }
        }
      }
    };

    // _send_ZSINIT is the only ZSINIT emitter (keepalive + ensure).
    proto._send_ZSINIT = function _send_ZSINIT() {
      this._zsinit_pending = true;
      return ORIGINAL_SEND_ZSINIT.apply(this, arguments);
    };

    proto._start_keepalive = function _start_keepalive() {
      if (!this._keepalive_promise) {
        const sess = this;

        this._keepalive_promise = new Promise(function (resolve) {
          sess._keepalive_timeout = setTimeout(resolve, 5000);
        }).then(function () {
          sess._keepalive_promise = null;
          // Never overlap ZSINIT frames. The receiver sends one ZACK per
          // frame; replacing the handler while an earlier ACK is pending
          // turns the later ACK into an unhandled-header failure.
          if (!sess._zsinit_pending) {
            sess._next_header_handler = {
              ZACK: function () {
                sess._on_zsinit_ack();
              },
            };
            sess._send_ZSINIT();
          }
          sess._start_keepalive();
        });
      }
    };

    proto._stop_keepalive = function _stop_keepalive() {
      if (this._keepalive_promise) {
        clearTimeout(this._keepalive_timeout);
        this._keepalive_promise = null;
      }
    };

    proto._ensure_receiver_escapes_ctrl_chars = function _ensure_receiver_escapes_ctrl_chars() {
      let promise;

      const needs_ZSINIT =
        !this._last_ZRINIT.escape_ctrl_chars() && !this._got_ZSINIT_ZACK;

      if (needs_ZSINIT) {
        const sess = this;

        if (sess._zsinit_pending) {
          // A keepalive ZSINIT is awaiting its ZACK: sending another would
          // produce a stray ZACK that aborts the session as
          // "Unhandled header: ZACK". Share the pending ACK instead.
          sess._next_header_handler = {
            ZACK: function () {
              sess._on_zsinit_ack();
            },
          };
          promise = new Promise(function (res) {
            if (!sess._zsinit_ack_waiters) sess._zsinit_ack_waiters = [];
            sess._zsinit_ack_waiters.push(res);
          });
        } else {
          promise = new Promise(function (res) {
            if (!sess._zsinit_ack_waiters) sess._zsinit_ack_waiters = [];
            sess._zsinit_ack_waiters.push(res);
            sess._next_header_handler = {
              ZACK: function () {
                sess._on_zsinit_ack();
              },
            };
            sess._send_ZSINIT();
          });
        }
      } else {
        promise = Promise.resolve();
      }

      return promise;
    };

    Zmodem.__netcattyZmodemSendSessionFixesApplied = true;
  } catch (err) {
    // Never break ZMODEM uploads over a patch problem.
    proto._send_ZSINIT = ORIGINAL_SEND_ZSINIT;
    proto._start_keepalive = ORIGINAL_START_KEEPALIVE;
    proto._stop_keepalive = ORIGINAL_STOP_KEEPALIVE;
    proto._ensure_receiver_escapes_ctrl_chars = ORIGINAL_ENSURE_ESCAPES;
    delete proto._on_zsinit_ack;
    console.error(
      "[ZMODEM] send-session fixes patch failed; using original Send session:",
      err && err.message ? err.message : err,
    );
  }

  return Zmodem;
}

//----------------------------------------------------------------------
// Send-side fast path (rz uploads).
//----------------------------------------------------------------------
//
// `_send_file_part()` splits every chunk into MAX_CHUNK_LENGTH (8192)
// byte subpackets and routes each one through the array-based encode
// pipeline: the Uint8Array chunk is converted to a boxed number Array,
// then `Subpacket._encode()` makes several more full-payload copies
// (`slice(0)`, `zencoder.encode()`, `concat(frameend)` for the CRC,
// the final `.concat()`), and `CRC.crc16()` calls `_updcrc()` per byte.
// At ~60 MB/s that is ~7700 subpackets per second and GB/s of
// short-lived arrays: CPU-bound in the fast phase and GC-stormed into
// a few MB/s when the collector catches up.  This is the same array
// pipeline disease the receive fast path already cured for downloads.
//
// The replacement builds each subpacket frame straight into one Buffer
// (one pass for the CRC, one pass to ZDLE-escape) and is byte-for-byte
// identical to the original under the encoder configuration the send
// sessions always use (FORCE_ESCAPE_CTRL_CHARS => escape_ctrl_chars on).

const SEND_FRAME_END_NUM = { no_end_no_ack: 0x69, end_no_ack: 0x68 };

/**
 * ZDLE-escape rule for the send sessions' fixed encoder configuration
 * (escape_ctrl_chars on, turbo_escape off): bytes 0x00-0x1f and
 * 0x80-0x9f escape as ZDLE + (byte ^ 0x40); everything else passes
 * through.  Mirrors the zdle.js zsendline_tab for that configuration.
 */
function sendSessionEscapes(byte) {
  return (byte & 0x60) === 0;
}

/**
 * Build one ZMODEM data subpacket frame into a fresh Buffer: ZDLE-
 * escaped payload (the `length` bytes of `source` starting at `offset`),
 * the [ZDLE, frameEndNum] trailer, then the ZDLE-escaped CRC16.
 *
 * Wire-identical to `Subpacket.build(chunk, frameend).encode16(encoder)`
 * with escape_ctrl_chars on, including the two zero-byte CRC passes and
 * the empty-payload case.
 */
function buildSendSubpacketFast(source, offset, length, frameEndNum) {
  let crc = 0;
  let escapedLen = 0;
  for (let i = offset; i < offset + length; i++) {
    const b = source[i];
    crc = crc16Step(crc, b);
    escapedLen += sendSessionEscapes(b) ? 2 : 1;
  }
  crc = crc16Step(crc, frameEndNum);
  crc = crc16Step(crc, 0);
  crc = crc16Step(crc, 0);
  crc &= 0xffff;

  const crcHi = crc >> 8;
  const crcLo = crc & 0xff;

  const out = Buffer.allocUnsafe(
    escapedLen +
      2 +
      (sendSessionEscapes(crcHi) ? 2 : 1) +
      (sendSessionEscapes(crcLo) ? 2 : 1),
  );
  let w = 0;
  for (let i = offset; i < offset + length; i++) {
    const b = source[i];
    if (sendSessionEscapes(b)) {
      out[w++] = 0x18; // ZDLE
      out[w++] = b ^ 0x40;
    } else {
      out[w++] = b;
    }
  }
  out[w++] = 0x18; // ZDLE
  out[w++] = frameEndNum;
  for (const b of [crcHi, crcLo]) {
    if (sendSessionEscapes(b)) {
      out[w++] = 0x18;
      out[w++] = b ^ 0x40;
    } else {
      out[w++] = b;
    }
  }
  return out;
}

/**
 * Patch zmodem.js so the send session builds data subpackets directly
 * as Buffers instead of churning through the array pipeline (see the
 * block comment above).  Falls back to the original for anything that
 * is not the fixed escape_ctrl_chars configuration or an unknown
 * frame-end, so wire behavior is unchanged elsewhere.
 *
 * @param {Object} Zmodem - The zmodem.js module, as returned by require().
 * @returns {Object} The same module object, patched (or not).
 */
function applyZmodemSendFastPath(Zmodem) {
  // The field kill-switch must cover both throughput patches. Keep the
  // independent send-session correctness fixes active for diagnostics.
  if (isFastPathDisabled()) return Zmodem;
  if (Zmodem.__netcattyZmodemSendFastPathApplied) return Zmodem;

  try {
    const proto = Zmodem.Session.Send.prototype;
    const ORIGINAL_SEND_FILE_PART = proto._send_file_part;
    if (typeof ORIGINAL_SEND_FILE_PART !== "function") return Zmodem;

    proto._send_file_part = function _send_file_part_fast(bytes_obj, final_packetend) {
      const frameEndNum = SEND_FRAME_END_NUM[final_packetend];
      if (
        !frameEndNum ||
        !this._zencoder ||
        !this._zencoder.escapes_ctrl_chars()
      ) {
        return ORIGINAL_SEND_FILE_PART.apply(this, arguments);
      }

      if (!this._sent_ZDATA) {
        this._send_header("ZDATA", this._file_offset);
        this._sent_ZDATA = true;
      }

      const bytes_count = bytes_obj.length;
      let obj_offset = 0;

      // Same 8192-byte split as the library (MAX_CHUNK_LENGTH in
      // zsession.js); intermediate subpackets use no_end_no_ack and the
      // final one uses the caller's frame end.
      while (true) {
        const chunk_size =
          Math.min(obj_offset + 8192, bytes_count) - obj_offset;
        const at_end = (chunk_size + obj_offset) >= bytes_count;

        const frame = buildSendSubpacketFast(
          bytes_obj,
          obj_offset,
          chunk_size,
          at_end ? frameEndNum : SEND_FRAME_END_NUM.no_end_no_ack,
        );
        this._sender(frame);
        // zdle.js keeps _lastcode on the encoder; replicate it for
        // fidelity (it does not affect escape_ctrl_chars output).
        this._zencoder._lastcode = frame[frame.length - 1];

        this._file_offset += chunk_size;
        obj_offset += chunk_size;

        if (obj_offset >= bytes_count) break;
      }
    };

    Zmodem.__netcattyZmodemSendFastPathApplied = true;
  } catch (err) {
    console.error(
      "[ZMODEM] send fast-path patch failed; using original sender:",
      err && err.message ? err.message : err,
    );
  }

  return Zmodem;
}

module.exports = {
  applyZmodemFastPath,
  applyZmodemSendSessionFixes,
  applyZmodemSendFastPath,

  // Exposed for unit tests.
  _internals: {
    parseSubpacketFast,
    zdleDecode,
    readDecodedBytes,
    stripIgnoredBytesFast,
    crc16Bytes,
    crc32Bytes,
    buildSendSubpacketFast,
    sendSessionEscapes,
  },
};
