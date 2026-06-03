const test = require("node:test");
const assert = require("node:assert/strict");
const iconv = require("iconv-lite");
const {
  normalizeTerminalEncoding,
  isUtf8Encoding,
  encodeTerminalInput,
} = require("./terminalEncoding.cjs");

test("normalizeTerminalEncoding maps GB variants onto the gb18030 superset", () => {
  assert.equal(normalizeTerminalEncoding("GB18030"), "gb18030");
  assert.equal(normalizeTerminalEncoding("gbk"), "gb18030");
  assert.equal(normalizeTerminalEncoding("GB2312"), "gb18030");
  assert.equal(normalizeTerminalEncoding("gb-18030"), "gb18030");
});

test("normalizeTerminalEncoding normalizes utf-8 spellings and defaults", () => {
  assert.equal(normalizeTerminalEncoding("UTF-8"), "utf-8");
  assert.equal(normalizeTerminalEncoding("utf8"), "utf-8");
  assert.equal(normalizeTerminalEncoding(""), "utf-8");
  assert.equal(normalizeTerminalEncoding(undefined), "utf-8");
  // Unknown / unsupported charset falls back to utf-8 rather than throwing.
  assert.equal(normalizeTerminalEncoding("not-a-real-charset"), "utf-8");
});

test("isUtf8Encoding recognizes utf-8 spellings and treats unset as utf-8", () => {
  assert.equal(isUtf8Encoding("utf-8"), true);
  assert.equal(isUtf8Encoding("UTF8"), true);
  assert.equal(isUtf8Encoding(undefined), true);
  assert.equal(isUtf8Encoding(""), true);
  assert.equal(isUtf8Encoding("gb18030"), false);
});

test("encodeTerminalInput leaves UTF-8 input as the original string", () => {
  // For UTF-8 we hand the string straight to the transport's native
  // serialization, so the value must be returned unchanged (no Buffer).
  assert.equal(encodeTerminalInput("ls -la 你好\r", "utf-8"), "ls -la 你好\r");
  // Unset encoding (mosh / local PTY) behaves like UTF-8.
  assert.equal(encodeTerminalInput("你好", undefined), "你好");
});

test("encodeTerminalInput encodes non-UTF-8 input to matching bytes", () => {
  const out = encodeTerminalInput("你好", "gb18030");
  assert.ok(Buffer.isBuffer(out), "non-UTF-8 input should produce a Buffer");
  assert.deepEqual([...out], [...iconv.encode("你好", "gb18030")]);
  // Crucially, the GB18030 bytes differ from the UTF-8 bytes — this is the bug:
  // the old path always sent UTF-8 bytes regardless of the configured charset.
  assert.notDeepEqual([...out], [...Buffer.from("你好", "utf8")]);
});

test("encodeTerminalInput preserves ASCII control bytes under GB18030", () => {
  // CSI cursor-up, CR, Ctrl-C — all ASCII, must pass through byte-for-byte so
  // escape sequences and control keys keep working on non-UTF-8 sessions.
  const input = "\x1b[A\r\x03";
  const out = encodeTerminalInput(input, "gb18030");
  assert.deepEqual([...out], [0x1b, 0x5b, 0x41, 0x0d, 0x03]);
});

test("encodeTerminalInput round-trips with the GB18030 output decoder", () => {
  // Input/output symmetry guarantee (issue #1216): bytes we write for a
  // keystroke decode back to the same text the output path would show.
  const text = "查看版本 v1.2\tabc\r";
  const wireBytes = encodeTerminalInput(text, "gb18030");
  const decoder = iconv.getDecoder("gb18030");
  assert.equal(decoder.write(wireBytes), text);
});

test("encodeTerminalInput round-trips with the UTF-8 output decoder", () => {
  const text = "echo 你好世界\r";
  // UTF-8 path returns a string; the transport serializes it natively, which is
  // byte-identical to encoding it as UTF-8.
  const wire = encodeTerminalInput(text, "utf-8");
  const wireBytes = typeof wire === "string" ? Buffer.from(wire, "utf8") : wire;
  const decoder = iconv.getDecoder("utf-8");
  assert.equal(decoder.write(wireBytes), text);
});

test("encodeTerminalInput falls back to the string for unknown encodings", () => {
  // A misconfigured charset must degrade to today's UTF-8 behavior instead of
  // throwing on the keystroke hot path.
  assert.equal(encodeTerminalInput("你好", "definitely-not-real"), "你好");
});

test("encodeTerminalInput refuses ASCII-incompatible encodings (UTF-16/UCS-2)", () => {
  // iconv accepts these, but encoding control bytes would widen "\r" to 0d 00
  // and "\x1b[A" to 1b 00 5b 00 ..., breaking Enter / arrows on the remote.
  // Fall back to the original string (today's UTF-8 behavior) instead.
  for (const enc of ["utf-16le", "utf-16be", "ucs2", "utf-16"]) {
    assert.equal(
      encodeTerminalInput("ls\r", enc),
      "ls\r",
      `${enc} should fall back to the original string`,
    );
  }
});

test("encodeTerminalInput still encodes other ASCII-superset CJK charsets", () => {
  // Sanity check that the ASCII-compat guard does not over-reject: legacy
  // multi-byte charsets that ARE ASCII supersets keep working for input.
  for (const enc of ["big5", "shift_jis", "euc-jp"]) {
    const out = encodeTerminalInput("\r", enc);
    assert.ok(Buffer.isBuffer(out), `${enc} should encode to a Buffer`);
    assert.deepEqual([...out], [0x0d], `${enc} must keep CR single-byte`);
  }
});

test("encodeTerminalInput passes non-string payloads through untouched", () => {
  const buf = Buffer.from([0x01, 0x02, 0x03]);
  assert.equal(encodeTerminalInput(buf, "gb18030"), buf);
});
