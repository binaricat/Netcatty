"use strict";

/**
 * Tests for the zmodem.js Buffer fast path (zmodemFastPath.cjs).
 *
 * Strategy: the fast parser must be byte-for-byte equivalent to the
 * original zmodem.js subpacket parser, so most tests build wire bytes
 * with the library's own encoder and compare the fast parser against
 * Subpacket.parse16()/parse32(). Complete receive sessions
 * (ZFILE → ZDATA → ZEOF → ZFIN → OO) are then driven through both the
 * patched Session/Sentry and — via a fresh unpatched copy of the
 * library — the original array pipeline, to prove the state machine
 * wiring behaves identically.
 */

const { test } = require("node:test");
const assert = require("node:assert");

const ZmodemLib = require("zmodem.js");
const {
  applyZmodemFastPath,
  applyZmodemSendFastPath,
  applyZmodemSendSessionFixes,
  _internals: {
    parseSubpacketFast,
    zdleDecode,
    readDecodedBytes,
    stripIgnoredBytesFast,
    crc16Bytes,
    crc32Bytes,
  },
} = require("./zmodemFastPath.cjs");

const Zmodem = applyZmodemFastPath(ZmodemLib);

//----------------------------------------------------------------------
// helpers
//----------------------------------------------------------------------

/** Deterministic PRNG so failures are reproducible. */
function makeRng(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s;
  };
}

/**
 * Random payload; every 4th byte is one of the interesting values
 * (ZDLE, XON/XOFF, CR, DEL, '@', 0xC0, NUL, LF).
 */
function randomPayload(rng, len) {
  const specials = [0x18, 0x11, 0x13, 0x0d, 0x7f, 0x40, 0xc0, 0x00, 0x0a];
  const out = [];
  for (let i = 0; i < len; i++) {
    const r = rng() & 0xff;
    out.push((r & 3) === 0 ? specials[r % specials.length] : r);
  }
  return out;
}

const FRAME_ENDS = ["end_no_ack", "no_end_no_ack", "no_end_ack", "end_ack"];

/** Encode one subpacket with the library's own encoder. */
function buildWire(payload, { crc32 = false, escCtl = false, frameEnd = "no_end_no_ack" } = {}) {
  const encoder = new Zmodem.ZDLE({ escape_ctrl_chars: escCtl });
  const subpacket = Zmodem.Subpacket.build(payload, frameEnd);
  return Buffer.from(
    crc32 ? subpacket.encode32(encoder) : subpacket.encode16(encoder),
  );
}

/** Parse a wire Buffer with the original library parser (array pipeline). */
function parseWithOriginal(wireBuffer, crcLen) {
  const arr = Array.prototype.slice.call(wireBuffer); // what Sentry.consume() used to do
  const subpacket = crcLen === 2
    ? Zmodem.Subpacket.parse16(arr)
    : Zmodem.Subpacket.parse32(arr);
  return {
    subpacket,
    consumed: wireBuffer.length - arr.length,
    payload: subpacket ? Array.from(subpacket.get_payload()) : null,
  };
}

/** Parse a wire Buffer with the fast parser. */
function parseWithFast(wireBuffer, crcLen) {
  const parsed = parseSubpacketFast(Zmodem, wireBuffer, crcLen);
  return {
    subpacket: parsed && parsed.subpacket,
    consumed: parsed ? parsed.consumed : null,
    payload: parsed ? Array.from(parsed.subpacket.get_payload()) : null,
  };
}

function assertParsersAgree(wireBuffer, crcLen, label) {
  const original = parseWithOriginal(wireBuffer, crcLen);
  const fast = parseWithFast(wireBuffer, crcLen);

  assert.ok(original.subpacket, `${label}: original parser should parse`);
  assert.ok(fast.subpacket, `${label}: fast parser should parse`);
  assert.strictEqual(fast.consumed, original.consumed, `${label}: consumed`);
  assert.deepStrictEqual(fast.payload, original.payload, `${label}: payload`);
  assert.strictEqual(
    fast.subpacket.frame_end(),
    original.subpacket.frame_end(),
    `${label}: frame_end`,
  );
  assert.strictEqual(
    fast.subpacket.ack_expected(),
    original.subpacket.ack_expected(),
    `${label}: ack_expected`,
  );
}

/**
 * Build the fake `sz` sender's wire for a complete download:
 * ZFILE + file-info subpacket, ZDATA + file subpackets, ZEOF, ZFIN.
 * Headers for ZFILE/ZDATA are binary (like lrzsz); ZEOF/ZFIN are hex.
 * The trailing "OO" + prompt is fed separately by the caller.
 */
function buildSenderWire(lib, filePayload, { crc32 = false } = {}) {
  const encoder = new lib.ZDLE({ escape_ctrl_chars: true });
  const enc = crc32 ? "encode32" : "encode16";
  const bin = crc32 ? "to_binary32" : "to_binary16";
  const chunks = [];

  const zfileInfo = Array.from("fastpath-test.bin").map((c) => c.charCodeAt(0));
  zfileInfo.push(0);
  const rest = `${filePayload.length} 0 0 0`.split("").map((c) => c.charCodeAt(0));
  zfileInfo.push(...rest);

  chunks.push(
    Buffer.from(
      lib.Header.build("ZFILE")[bin](encoder).concat(
        lib.Subpacket.build(zfileInfo, "end_ack")[enc](encoder),
      ),
    ),
  );

  const zdata = [lib.Header.build("ZDATA", 0)[bin](encoder)];
  const SUB = 1024;
  for (let off = 0; off < filePayload.length; off += SUB) {
    const slice = filePayload.slice(off, off + SUB);
    const atEnd = off + SUB >= filePayload.length;
    zdata.push(
      lib.Subpacket.build(slice, atEnd ? "end_no_ack" : "no_end_no_ack")[enc](encoder),
    );
  }
  chunks.push(Buffer.concat(zdata.map(Buffer.from)));

  chunks.push(Buffer.from(lib.Header.build("ZEOF", filePayload.length).to_hex()));
  chunks.push(Buffer.from(lib.Header.build("ZFIN").to_hex()));

  return Buffer.concat(chunks);
}

/** Decode a sent header byte block into its header name. */
function sentHeaderName(lib, bytes) {
  const parsed = lib.Header.parse(Array.prototype.slice.call(bytes));
  return parsed && parsed[0] && parsed[0].NAME;
}

/**
 * Get a second, unpatched copy of the zmodem.js classes by evicting the
 * library's modules from the require cache. The patched instance held by
 * this test file keeps working (its classes are separate objects).
 */
function requireFreshUnpatchedZmodem() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${require("node:path").sep}zmodem.js`)) {
      delete require.cache[key];
    }
  }
  return require("zmodem.js");
}

//----------------------------------------------------------------------
// patch / idempotency
//----------------------------------------------------------------------

test("applyZmodemFastPath patches the shared prototypes and is idempotent", () => {
  assert.strictEqual(Zmodem.__netcattyZmodemFastPathApplied, true);
  assert.strictEqual(applyZmodemFastPath(Zmodem), Zmodem);
  assert.strictEqual(
    typeof Zmodem.Session.prototype._zmodem_fast_consume,
    "function",
  );
});

test("fast receive detects an abort sequence spanning header and Buffer state", () => {
  const headerPrefix = Buffer.from([0x2a, 0x18, 0x41, 0x18, 0x18, 0x18]);
  const abortTail = Buffer.from([0x18, 0x18]);
  const session = new Zmodem.Session.Receive();

  // An incomplete binary header is retained in _input_buffer. The remaining
  // two CAN bytes arrive in a later Buffer, so detection must cover both.
  session.consume(headerPrefix);
  assert.throws(
    () => session.consume(abortTail),
    (err) => err && err.type === "peer_aborted",
  );
  assert.equal(session.aborted(), true);
});

test("fast receive checks abort bytes before post-ZFIN OO validation", () => {
  const session = new Zmodem.Session.Receive();
  session._got_ZFIN = true;

  assert.throws(
    () => session.consume(Buffer.from([0x18, 0x18, 0x18, 0x18, 0x18])),
    (err) => err && err.type === "peer_aborted",
  );
  assert.equal(session.aborted(), true);
  assert.equal(session.has_ended(), true);
});

test("fast parsed subpackets keep typed payloads for zero-copy downloads", () => {
  const wire = buildWire([0x00, 0x18, 0xff, 0x41], { frameEnd: "end_no_ack" });
  const parsed = parseSubpacketFast(Zmodem, wire, 2);
  assert.ok(parsed);
  assert.equal(parsed.subpacket.get_payload() instanceof Uint8Array, true);
});

test("kill switch disables both performance fast paths while retaining send-session fixes", () => {
  const previous = process.env.NETCATTY_ZMODEM_FAST_PATH;
  process.env.NETCATTY_ZMODEM_FAST_PATH = "0";

  try {
    const fresh = requireFreshUnpatchedZmodem();
    const originalSentryConsume = fresh.Sentry.prototype.consume;
    const originalSendFilePart = fresh.Session.Send.prototype._send_file_part;

    applyZmodemFastPath(fresh);
    applyZmodemSendSessionFixes(fresh);
    applyZmodemSendFastPath(fresh);

    assert.equal(fresh.__netcattyZmodemFastPathApplied, undefined);
    assert.equal(fresh.__netcattyZmodemSendFastPathApplied, undefined);
    assert.equal(fresh.__netcattyZmodemSendSessionFixesApplied, true);
    assert.strictEqual(fresh.Sentry.prototype.consume, originalSentryConsume);
    assert.strictEqual(fresh.Session.Send.prototype._send_file_part, originalSendFilePart);
  } finally {
    if (previous === undefined) delete process.env.NETCATTY_ZMODEM_FAST_PATH;
    else process.env.NETCATTY_ZMODEM_FAST_PATH = previous;
  }
});

//----------------------------------------------------------------------
// CRC
//----------------------------------------------------------------------

test("crc16Bytes matches the library's CRC.crc16", () => {
  const rng = makeRng(7);
  for (let i = 0; i < 20; i++) {
    const payload = randomPayload(rng, (rng() & 0x1ff) + 1);
    const frameEnd = 105;
    const lib = Zmodem.CRC.crc16(payload.concat([frameEnd]));
    const mine = crc16Bytes(payload, frameEnd);
    assert.strictEqual((mine >> 8) & 0xff, lib[0], `crc16 case ${i} hi`);
    assert.strictEqual(mine & 0xff, lib[1], `crc16 case ${i} lo`);
  }
});

test("crc32Bytes matches the library's CRC.crc32", () => {
  const rng = makeRng(11);
  for (let i = 0; i < 20; i++) {
    const payload = randomPayload(rng, (rng() & 0x1ff) + 1);
    const frameEnd = 105;
    const lib = Zmodem.CRC.crc32(payload.concat([frameEnd]));
    const mine = crc32Bytes(payload, frameEnd);
    assert.deepStrictEqual(
      [mine & 0xff, (mine >> 8) & 0xff, (mine >> 16) & 0xff, (mine >> 24) & 0xff],
      lib,
      `crc32 case ${i}`,
    );
  }
});

//----------------------------------------------------------------------
// subpacket parser vs original
//----------------------------------------------------------------------

test("parseSubpacketFast round-trips CRC16 subpackets for every frame-end type", () => {
  const rng = makeRng(42);
  for (const frameEnd of FRAME_ENDS) {
    for (const escCtl of [false, true]) {
      const payload = randomPayload(rng, (rng() & 0x3ff) + 1);
      const wire = buildWire(payload, { frameEnd, escCtl });
      assertParsersAgree(wire, 2, `${frameEnd}/escCtl=${escCtl}`);
    }
  }
});

test("parseSubpacketFast round-trips CRC32 subpackets for every frame-end type", () => {
  const rng = makeRng(43);
  for (const frameEnd of FRAME_ENDS) {
    const payload = randomPayload(rng, (rng() & 0x3ff) + 1);
    const wire = buildWire(payload, { frameEnd, crc32: true, escCtl: true });
    assertParsersAgree(wire, 4, `${frameEnd}/crc32`);
  }
});

test("parseSubpacketFast handles empty and single-byte payloads", () => {
  for (const payload of [[], [0x18], [0x00], [0x41]]) {
    assertParsersAgree(buildWire(payload), 2, `payload=[${payload}]`);
    assertParsersAgree(buildWire(payload, { crc32: true }), 4, `payload=[${payload}] crc32`);
  }
});

test("fuzz: byte-at-a-time feeding parses identically to the original", () => {
  const rng = makeRng(99);
  for (let round = 0; round < 30; round++) {
    const payload = randomPayload(rng, (rng() & 0xff) + 1);
    const crcLen = round % 2 === 0 ? 2 : 4;
    const wire = buildWire(payload, {
      crc32: crcLen === 4,
      escCtl: round % 3 === 0,
      frameEnd: FRAME_ENDS[round % FRAME_ENDS.length],
    });
    const original = parseWithOriginal(wire, crcLen);

    // Feed the wire one byte at a time; the parser must return null
    // until the subpacket is complete, then parse it exactly once and
    // consume every byte.
    let acc = Buffer.alloc(0);
    let parsed = null;
    for (let i = 0; i < wire.length; i++) {
      acc = Buffer.concat([acc, wire.subarray(i, i + 1)]);
      const got = parseSubpacketFast(Zmodem, acc, crcLen);
      if (got) {
        assert.strictEqual(parsed, null, `round ${round}: parsed twice`);
        parsed = got;
        assert.strictEqual(got.consumed, acc.length, `round ${round}: partial consume`);
        assert.deepStrictEqual(
          Array.from(got.subpacket.get_payload()),
          original.payload,
          `round ${round}: payload`,
        );
        assert.strictEqual(
          got.subpacket.frame_end(),
          original.subpacket.frame_end(),
          `round ${round}: frame_end`,
        );
      }
    }
    assert.ok(parsed, `round ${round}: never parsed`);
  }
});

test("CRC corruption throws the same 'crc' error as the library", () => {
  const rng = makeRng(5);
  for (const crcLen of [2, 4]) {
    for (const corruptWhat of ["payload", "crc"]) {
      const payload = randomPayload(rng, 200);
      const wire = buildWire(payload, { crc32: crcLen === 4 });

      let at = -1;
      if (corruptWhat === "payload") {
        // flip the first byte that isn't a ZDLE escape prefix
        for (let i = 0; i < wire.length / 2; i++) {
          if (wire[i] !== 0x18) {
            at = i;
            break;
          }
        }
      } else {
        at = wire.length - 1;
      }
      assert.ok(at !== -1);
      wire[at] ^= 0x40;

      let libErr = null;
      let fastErr = null;
      try {
        parseWithOriginal(wire, crcLen);
      } catch (err) {
        libErr = err;
      }
      try {
        parseWithFast(wire, crcLen);
      } catch (err) {
        fastErr = err;
      }

      assert.ok(libErr, `${crcLen}/${corruptWhat}: library should throw`);
      assert.ok(fastErr, `${crcLen}/${corruptWhat}: fast parser should throw`);
      assert.strictEqual(fastErr.type, "crc", `${crcLen}/${corruptWhat}: type`);
      assert.ok(
        fastErr.message.startsWith("CRC check failed!"),
        `${crcLen}/${corruptWhat}: message`,
      );
    }
  }
});

//----------------------------------------------------------------------
// low-level helpers vs the library
//----------------------------------------------------------------------

test("stripIgnoredBytesFast matches ZMLIB.strip_ignored_bytes", () => {
  const rng = makeRng(123);
  for (let i = 0; i < 20; i++) {
    // sprinkle XON/XOFF (and high-bit variants) into random data
    const ignored = [0x11, 0x13, 0x91, 0x93];
    const input = randomPayload(rng, (rng() & 0x7f) + 1);
    for (let k = 0; k < 5; k++) {
      input[rng() % input.length] = ignored[rng() % ignored.length];
    }

    const lib = input.slice(0);
    Zmodem.ZMLIB.strip_ignored_bytes(lib);

    assert.deepStrictEqual(
      Array.from(stripIgnoredBytesFast(Buffer.from(input))),
      lib,
      `case ${i}`,
    );
  }

  // zero-copy on clean input
  const clean = Buffer.from([1, 2, 3]);
  assert.strictEqual(stripIgnoredBytesFast(clean), clean);
});

test("zdleDecode matches ZDLE.decode", () => {
  const encoder = new Zmodem.ZDLE({ escape_ctrl_chars: false });
  const rng = makeRng(321);
  for (let i = 0; i < 20; i++) {
    const payload = randomPayload(rng, (rng() & 0x3ff) + 1);
    const encoded = encoder.encode(payload.slice(0)); // mutates its input
    const lib = Zmodem.ZDLE.decode(encoded.slice(0));
    assert.deepStrictEqual(Array.from(zdleDecode(Buffer.from(encoded))), lib, `case ${i}`);
  }
});

test("readDecodedBytes matches ZDLE.splice semantics", () => {
  const rng = makeRng(555);
  for (let i = 0; i < 40; i++) {
    // build an encoded byte array: mostly plain bytes, occasionally a
    // ZDLE escape pair (only second bytes >= 0x40 occur on the wire —
    // conforming encoders never emit 0x00-0x3F there); sometimes a bare
    // trailing ZDLE
    const raw = randomPayload(rng, (rng() & 0x1f) + 1);
    const encoded = [];
    for (const b of raw) {
      if ((b & 3) === 0) {
        encoded.push(0x18, 0x40 | (b & 0x3f));
      } else if ((b & 3) === 1) {
        encoded.push(0x18, 0xc0 | (b & 0x3f));
      } else {
        encoded.push(b);
      }
    }
    if ((i & 7) === 0) encoded.push(0x18); // bare trailing ZDLE

    const count = 1 + (rng() & 7);

    const libArr = encoded.slice(0);
    const lib = Zmodem.ZDLE.splice(libArr, 0, count);

    const mine = readDecodedBytes(Buffer.from(encoded), 0, count);

    if (lib === undefined) {
      assert.strictEqual(mine, null, `case ${i}: both incomplete`);
    } else {
      assert.ok(mine, `case ${i}: both complete`);
      assert.deepStrictEqual(Array.from(mine.bytes), lib, `case ${i}: bytes`);
      assert.strictEqual(mine.consumed, encoded.length - libArr.length, `case ${i}: consumed`);
    }
  }
});

//----------------------------------------------------------------------
// complete receive sessions
//----------------------------------------------------------------------

/**
 * Drive a complete download through a receive session of `lib` (patched
 * or original), feeding `chunkSize` bytes at a time as Buffers (fast
 * path) or plain arrays (original pipeline, like the Sentry used to do).
 *
 * Returns everything observable, so two runs can be compared:
 * { sentNames, receivedHex, trailing, ended, aborted, firstError }.
 */
function runSessionScenario({ lib, filePayload, chunkSize, asBuffers, trailingFeed, crc32 = false }) {
  const fileBuffer = Buffer.from(filePayload);

  const sent = [];
  const inputPayloads = [];
  const offers = [];
  let acceptPromise = null;

  const session = new lib.Session.Receive();
  session.set_sender((octets) => sent.push(Buffer.from(octets)));
  session.on("offer", (xfer) => {
    offers.push(xfer);
    acceptPromise = xfer.accept({
      on_input(payload) {
        inputPayloads.push(Buffer.from(payload));
      },
    });
  });

  session.start();

  const feed = (bytes) => {
    if (asBuffers) {
      session.consume(Buffer.from(bytes));
    } else {
      session.consume(Array.prototype.slice.call(bytes));
    }
  };

  let firstError = null;
  const feedAll = (chunks) => {
    for (const chunk of chunks) {
      try {
        feed(chunk);
      } catch (err) {
        if (!firstError) firstError = String((err && err.message) || err);
        break; // the session is broken from here on
      }
    }
  };

  const wire = buildSenderWire(lib, filePayload, { crc32 });
  const wireChunks = [];
  for (let i = 0; i < wire.length; i += chunkSize) {
    wireChunks.push(wire.subarray(i, Math.min(i + chunkSize, wire.length)));
  }
  feedAll(wireChunks);
  feedAll(trailingFeed.map((piece) => Buffer.from(piece)));

  return {
    offerCount: offers.length,
    offerName: offers.length ? offers[0].get_details().name : null,
    offerSize: offers.length ? offers[0].get_details().size : null,
    sentNames: sent.map((b) => sentHeaderName(lib, b)),
    receivedHex: Buffer.concat(inputPayloads).toString("hex"),
    trailing: session.has_ended() && !session.aborted()
      ? Buffer.from(session.get_trailing_bytes()).toString()
      : null,
    ended: session.has_ended(),
    aborted: session.aborted(),
    firstError,
    acceptResolved: Boolean(acceptPromise),
  };
}

const TRAILING_SPLIT = ["O", "Oprompt$ "]; // second O and the prompt together
const TRAILING_WHOLE = ["OOprompt$ "];

test("patched receive session: full CRC16 download, 1 byte at a time", async () => {
  const r = runSessionScenario({
    lib: Zmodem,
    filePayload: randomPayload(makeRng(777), 3000),
    chunkSize: 1,
    asBuffers: true,
    trailingFeed: TRAILING_SPLIT,
  });
  assert.strictEqual(r.firstError, null);
  assert.strictEqual(r.offerCount, 1);
  assert.strictEqual(r.offerName, "fastpath-test.bin");
  assert.strictEqual(r.offerSize, 3000);
  assert.strictEqual(r.ended, true);
  assert.strictEqual(r.aborted, false);
  assert.strictEqual(r.trailing, "prompt$ ");
  assert.deepStrictEqual(r.sentNames, ["ZRINIT", "ZRPOS", "ZRINIT", "ZFIN"]);
  assert.strictEqual(r.receivedHex, Buffer.from(randomPayload(makeRng(777), 3000)).toString("hex"));
});

test("patched receive session: full CRC32 download, OO in one chunk", () => {
  const r = runSessionScenario({
    lib: Zmodem,
    filePayload: randomPayload(makeRng(778), 2000),
    chunkSize: 7,
    asBuffers: true,
    trailingFeed: TRAILING_WHOLE,
    crc32: true,
  });
  assert.strictEqual(r.firstError, null);
  assert.strictEqual(r.ended, true);
  assert.strictEqual(r.trailing, "prompt$ ");
  assert.deepStrictEqual(r.sentNames, ["ZRINIT", "ZRPOS", "ZRINIT", "ZFIN"]);
});

test("fast receive keeps fragmented packets segmented until a frame is complete", () => {
  const wire = buildWire(Array.from(Buffer.alloc(64 * 1024, 0x5a)), { frameEnd: "end_no_ack" });
  const session = new Zmodem.Session.Receive();
  session._last_header_crc = 16;
  session._next_subpacket_handler = () => {};

  const originalConcat = Buffer.concat;
  let concatCount = 0;
  Buffer.concat = function countedConcat() {
    concatCount += 1;
    return originalConcat.apply(this, arguments);
  };

  try {
    for (const byte of wire) session.consume(Buffer.from([byte]));
  } finally {
    Buffer.concat = originalConcat;
  }

  assert.ok(concatCount <= 4, `fragmented packet was flattened ${concatCount} times`);
});

test("fast receive keeps abort detection after compacting an incomplete CRC", () => {
  const wire = buildWire([0x41], { frameEnd: "end_no_ack" });
  const marker = wire.lastIndexOf(Buffer.from([0x18, 0x68]));
  assert.ok(marker >= 0);
  const session = new Zmodem.Session.Receive();
  session._last_header_crc = 16;
  session._next_subpacket_handler = () => {};

  // Leave one CRC byte pending after the frame marker. This makes the fast
  // path compact its fragmented chunks before the remaining CRC and CAN
  // abort sequence arrive.
  for (let i = 0; i < marker + 3; i++) {
    session.consume(wire.subarray(i, i + 1));
  }
  assert.throws(
    () => session.consume(Buffer.from([wire[marker + 3], 0x18, 0x18, 0x18, 0x18, 0x18])),
    (err) => err && err.type === "peer_aborted",
  );
  assert.equal(session.aborted(), true);
});

test("pending ZSINIT restores its ZACK handler before waiting", async () => {
  const lib = requireFreshUnpatchedZmodem();
  applyZmodemSendSessionFixes(lib);
  const session = new lib.Session.Send(
    lib.Header.build("ZRINIT", ["CANFDX", "CANOVIO"], 0),
  );
  session._zsinit_pending = true;
  session._next_header_handler = { ZRINIT() {} };

  const pending = session._ensure_receiver_escapes_ctrl_chars();
  assert.equal(typeof session._next_header_handler.ZACK, "function");
  session._on_zsinit_ack();
  await pending;
});

test("patched send file parts are wire-equivalent to the original", () => {
  const originalLib = requireFreshUnpatchedZmodem();
  const patchedLib = requireFreshUnpatchedZmodem();
  applyZmodemSendFastPath(patchedLib);

  const payload = Buffer.alloc(8192 * 2 + 1);
  for (let i = 0; i < payload.length; i++) {
    payload[i] = (i * 73 + 19) & 0xff;
  }

  function sendFilePart(lib) {
    const zrinit = lib.Header.build("ZRINIT", ["CANFDX", "CANOVIO"], 0);
    const session = new lib.Session.Send(zrinit);
    const wire = [];
    session.set_sender((bytes) => wire.push(Buffer.from(bytes)));
    session._stop_keepalive();
    session._sending_file = true;
    session._send_file_part(new Uint8Array(payload), "end_no_ack");
    return wire;
  }

  assert.deepStrictEqual(sendFilePart(patchedLib), sendFilePart(originalLib));
});

test("session-level equivalence: fast path matches the original library pipeline", () => {
  const originalLib = requireFreshUnpatchedZmodem();
  assert.notStrictEqual(originalLib.Session.prototype.consume, Zmodem.Session.prototype.consume);

  const filePayload = randomPayload(makeRng(1234), 2500);
  const scenarios = [
    { chunkSize: 1, trailingFeed: TRAILING_SPLIT },
    { chunkSize: 7, trailingFeed: TRAILING_WHOLE },
    { chunkSize: 5, trailingFeed: TRAILING_SPLIT },
    // feed the trailing block as one chunk; exercises the trim-2 branch
    { chunkSize: 3, trailingFeed: TRAILING_WHOLE },
  ];

  for (const s of scenarios) {
    const original = runSessionScenario({
      lib: originalLib,
      filePayload,
      chunkSize: s.chunkSize,
      asBuffers: false, // arrays, like the Sentry's old conversion
      trailingFeed: s.trailingFeed,
    });
    const fast = runSessionScenario({
      lib: Zmodem,
      filePayload,
      chunkSize: s.chunkSize,
      asBuffers: true,
      trailingFeed: s.trailingFeed,
    });

    assert.deepStrictEqual(fast, original, `scenario ${JSON.stringify(s)}`);
    assert.strictEqual(fast.firstError, null, `scenario ${JSON.stringify(s)}: no errors`);
  }
});

test("patched Sentry: detection, fast consume, trailing bytes to terminal", () => {
  const filePayload = randomPayload(makeRng(888), 2000);
  const fileBuffer = Buffer.from(filePayload);

  const terminalBytes = [];
  const sent = [];
  let detection = null;
  let zsession = null;
  const inputPayloads = [];

  const sentry = new Zmodem.Sentry({
    to_terminal(bytes) {
      terminalBytes.push(Buffer.from(bytes));
    },
    on_detect(det) {
      detection = det;
    },
    on_retract() {},
    sender(bytes) {
      sent.push(Buffer.from(bytes));
    },
  });

  // the remote's `sz` starts with a ZRQINIT; the sentry detects it and
  // echoes the init bytes to the terminal, like Netcatty does today
  const zrqinitWire = Buffer.from(Zmodem.Header.build("ZRQINIT").to_hex());
  sentry.consume(zrqinitWire);
  assert.ok(detection, "detection fired");
  assert.strictEqual(
    Buffer.concat(terminalBytes).compare(zrqinitWire),
    0,
    "init bytes echoed to terminal",
  );

  zsession = detection.confirm();
  assert.strictEqual(zsession.type, "receive");

  // mimic handleDownload(): start the session, accept the offer
  zsession.start();
  zsession.on("offer", (xfer) => {
    xfer.accept({
      on_input(payload) {
        inputPayloads.push(Buffer.from(payload));
      },
    });
  });

  const wire = buildSenderWire(Zmodem, filePayload);
  for (let i = 0; i < wire.length; i += 5) {
    sentry.consume(wire.subarray(i, Math.min(i + 5, wire.length)));
  }
  sentry.consume(Buffer.from("OOprompt$ "));

  assert.strictEqual(zsession.has_ended(), true);
  assert.strictEqual(
    Buffer.concat(inputPayloads).compare(fileBuffer),
    0,
    "file reassembled",
  );

  // after the session ends, the sentry routes trailing bytes to the
  // terminal again
  const allTerminal = Buffer.concat(terminalBytes).toString();
  assert.ok(allTerminal.includes("prompt$ "), "prompt went to terminal");
  assert.strictEqual(sentry.get_confirmed_session(), null);
});
