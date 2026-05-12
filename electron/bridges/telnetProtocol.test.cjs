const test = require("node:test");
const assert = require("node:assert/strict");

const {
  IAC,
  SE,
  NOP,
  SB,
  WILL,
  WONT,
  DO,
  DONT,
  OPT,
  escapeIacForWire,
  createTelnetParser,
} = require("./telnetProtocol.cjs");

const collect = () => {
  const data = [];
  const commands = [];
  const subnegs = [];
  return {
    data,
    commands,
    subnegs,
    parser: createTelnetParser({
      onData(buf) {
        data.push(Buffer.from(buf));
      },
      onCommand(cmd, opt) {
        commands.push({ cmd, opt });
      },
      onSubnegotiation(opt, payload) {
        subnegs.push({ opt, payload: Buffer.from(payload) });
      },
    }),
  };
};

test("escapeIacForWire — passthrough when no 0xFF byte", () => {
  const input = Buffer.from([0x61, 0x62, 0x63]);
  assert.equal(escapeIacForWire(input), input);
});

test("escapeIacForWire — doubles each 0xFF", () => {
  const input = Buffer.from([0xff, 0x61, 0xff, 0xff, 0x62]);
  const got = escapeIacForWire(input);
  assert.deepEqual(
    [...got],
    [0xff, 0xff, 0x61, 0xff, 0xff, 0xff, 0xff, 0x62],
  );
});

test("parser emits clean data when no IAC bytes are present", () => {
  const { parser, data, commands, subnegs } = collect();
  parser.feed(Buffer.from("hello world"));
  assert.equal(Buffer.concat(data).toString("utf8"), "hello world");
  assert.equal(commands.length, 0);
  assert.equal(subnegs.length, 0);
});

test("parser handles a complete DO option command in one feed", () => {
  const { parser, data, commands } = collect();
  parser.feed(Buffer.from([IAC, DO, OPT.SUPPRESS_GO_AHEAD]));
  assert.equal(data.length, 0);
  assert.deepEqual(commands, [{ cmd: DO, opt: OPT.SUPPRESS_GO_AHEAD }]);
});

test("parser splits clean data around an option command", () => {
  const { parser, data, commands } = collect();
  parser.feed(
    Buffer.concat([
      Buffer.from("login: "),
      Buffer.from([IAC, WILL, OPT.ECHO]),
      Buffer.from("admin"),
    ]),
  );
  assert.equal(Buffer.concat(data).toString("utf8"), "login: admin");
  assert.deepEqual(commands, [{ cmd: WILL, opt: OPT.ECHO }]);
});

test("parser unescapes IAC IAC into a literal 0xFF in the data stream", () => {
  const { parser, data } = collect();
  parser.feed(Buffer.from([0x61, IAC, IAC, 0x62]));
  assert.deepEqual([...Buffer.concat(data)], [0x61, 0xff, 0x62]);
});

test("parser ignores stand-alone IAC verbs (NOP)", () => {
  const { parser, data, commands } = collect();
  parser.feed(Buffer.from([0x61, IAC, NOP, 0x62]));
  assert.deepEqual([...Buffer.concat(data)], [0x61, 0x62]);
  assert.equal(commands.length, 0);
});

test("parser parses a complete subnegotiation in one feed", () => {
  const { parser, data, subnegs } = collect();
  // IAC SB TERMINAL_TYPE IS "XTERM" IAC SE
  parser.feed(
    Buffer.concat([
      Buffer.from([IAC, SB, OPT.TERMINAL_TYPE, 0]),
      Buffer.from("XTERM"),
      Buffer.from([IAC, SE]),
    ]),
  );
  assert.equal(data.length, 0);
  assert.equal(subnegs.length, 1);
  assert.equal(subnegs[0].opt, OPT.TERMINAL_TYPE);
  assert.deepEqual(
    [...subnegs[0].payload],
    [0, 0x58, 0x54, 0x45, 0x52, 0x4d],
  );
});

test("parser tolerates IAC IAC inside a subnegotiation payload", () => {
  const { parser, subnegs } = collect();
  // SB STATUS 0xFF (encoded as IAC IAC) 0x01 SE
  parser.feed(Buffer.from([IAC, SB, OPT.STATUS, IAC, IAC, 0x01, IAC, SE]));
  assert.equal(subnegs.length, 1);
  assert.deepEqual([...subnegs[0].payload], [0xff, 0x01]);
});

test("parser preserves a lone IAC at end-of-chunk for the next feed", () => {
  const { parser, data, commands } = collect();
  parser.feed(Buffer.concat([Buffer.from("hi"), Buffer.from([IAC])]));
  assert.equal(Buffer.concat(data).toString("utf8"), "hi");
  assert.equal(commands.length, 0);
  assert.equal(parser.pendingByteCount, 1);

  // Next chunk completes the command.
  parser.feed(Buffer.from([DO, OPT.NAWS, 0x61]));
  assert.equal(parser.pendingByteCount, 0);
  assert.deepEqual(commands, [{ cmd: DO, opt: OPT.NAWS }]);
  // The trailing 'a' must have been emitted as data.
  assert.equal(Buffer.concat(data).toString("utf8"), "hia");
});

test("parser preserves a half-finished option command (IAC DO) for the next feed", () => {
  const { parser, data, commands } = collect();
  parser.feed(Buffer.from([0x61, IAC, DO]));
  assert.equal(Buffer.concat(data).toString("utf8"), "a");
  assert.equal(commands.length, 0);
  assert.equal(parser.pendingByteCount, 2);

  parser.feed(Buffer.from([OPT.TERMINAL_TYPE, 0x62]));
  assert.deepEqual(commands, [{ cmd: DO, opt: OPT.TERMINAL_TYPE }]);
  assert.equal(Buffer.concat(data).toString("utf8"), "ab");
});

test("parser preserves an unterminated subnegotiation across multiple frames", () => {
  const { parser, data, subnegs } = collect();
  // Send IAC SB TT 0 "XTE" — the SE is intentionally missing.
  parser.feed(
    Buffer.concat([
      Buffer.from("prefix"),
      Buffer.from([IAC, SB, OPT.TERMINAL_TYPE, 0]),
      Buffer.from("XTE"),
    ]),
  );
  assert.equal(Buffer.concat(data).toString("utf8"), "prefix");
  assert.equal(subnegs.length, 0);

  // Now the remaining payload + IAC SE arrive together with trailing data.
  parser.feed(
    Buffer.concat([
      Buffer.from("RM-256COLOR"),
      Buffer.from([IAC, SE]),
      Buffer.from(" tail"),
    ]),
  );

  assert.equal(subnegs.length, 1);
  assert.equal(subnegs[0].opt, OPT.TERMINAL_TYPE);
  assert.deepEqual(
    Buffer.from(subnegs[0].payload).toString("utf8"),
    "\x00XTERM-256COLOR",
  );
  assert.equal(Buffer.concat(data).toString("utf8"), "prefix tail");
});

test("parser does not leak SB payload as data when the SE never arrives", () => {
  // Regression: in the old stateless implementation, an unterminated SB block
  // would fall through to "skip IAC SB and emit the rest as data" — leaking
  // option-type names and other text into the terminal.
  const { parser, data, subnegs } = collect();
  parser.feed(
    Buffer.concat([
      Buffer.from([IAC, SB, OPT.TERMINAL_TYPE, 0]),
      Buffer.from("XTERM-PARTIAL"),
    ]),
  );
  assert.equal(data.length, 0);
  assert.equal(subnegs.length, 0);
  assert.ok(parser.pendingByteCount > 0);
});

test("parser handles two consecutive option commands without losing either", () => {
  const { parser, commands } = collect();
  parser.feed(
    Buffer.from([IAC, WILL, OPT.ECHO, IAC, DO, OPT.SUPPRESS_GO_AHEAD]),
  );
  assert.deepEqual(commands, [
    { cmd: WILL, opt: OPT.ECHO },
    { cmd: DO, opt: OPT.SUPPRESS_GO_AHEAD },
  ]);
});

test("parser feed is no-op for empty / null chunks", () => {
  const { parser, data, commands } = collect();
  parser.feed(Buffer.alloc(0));
  parser.feed(null);
  parser.feed(undefined);
  assert.equal(data.length, 0);
  assert.equal(commands.length, 0);
});

test("parser reset clears pending state", () => {
  const { parser } = collect();
  parser.feed(Buffer.from([IAC]));
  assert.equal(parser.pendingByteCount, 1);
  parser.reset();
  assert.equal(parser.pendingByteCount, 0);
});

test("data emitted before a command is delivered before that command's callback", () => {
  const order = [];
  const parser = createTelnetParser({
    onData(buf) {
      order.push(`data:${buf.toString("utf8")}`);
    },
    onCommand(cmd, opt) {
      order.push(`cmd:${cmd}:${opt}`);
    },
  });
  parser.feed(
    Buffer.concat([
      Buffer.from("hi"),
      Buffer.from([IAC, WONT, OPT.LINEMODE]),
      Buffer.from("bye"),
    ]),
  );
  assert.deepEqual(order, [
    "data:hi",
    `cmd:${WONT}:${OPT.LINEMODE}`,
    "data:bye",
  ]);
});
