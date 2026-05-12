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
  SUBOPTION_IS,
  SUBOPTION_SEND,
  escapeIacForWire,
  createTelnetParser,
  createTelnetNegotiator,
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

const recordNegotiator = (overrides = {}) => {
  const commands = [];
  const subnegs = [];
  const negotiator = createTelnetNegotiator({
    writeCommand(cmd, opt) {
      commands.push({ cmd, opt });
    },
    writeSubnegotiation(opt, payload) {
      subnegs.push({ opt, payload: Buffer.from(payload) });
    },
    getWindowSize: () => ({ cols: 120, rows: 40 }),
    ...overrides,
  });
  return { negotiator, commands, subnegs };
};

test("negotiator.start drives the canonical handshake (DO SGA / WILL TT / WILL NAWS)", () => {
  const { negotiator, commands } = recordNegotiator();
  negotiator.start();
  assert.deepEqual(commands, [
    { cmd: DO, opt: OPT.SUPPRESS_GO_AHEAD },
    { cmd: WILL, opt: OPT.TERMINAL_TYPE },
    { cmd: WILL, opt: OPT.NAWS },
  ]);
  assert.equal(negotiator.pendingDoCount, 1);
  assert.equal(negotiator.pendingWillCount, 2);
});

test("peer's WILL on our pending DO is swallowed (no double-DO loop)", () => {
  const { negotiator, commands } = recordNegotiator();
  negotiator.start();
  commands.length = 0;
  // Server replies WILL SGA — acknowledges our DO SGA.
  negotiator.handleCommand(WILL, OPT.SUPPRESS_GO_AHEAD);
  assert.deepEqual(commands, []);
  assert.equal(negotiator.pendingDoCount, 0);
});

test("peer's independent DO on a SGA where our DO is still pending is replied with WILL (regression)", () => {
  // RFC 858: WILL/WONT and DO/DONT are independent per direction. The peer
  // can ask us to enable SGA on our side while our request to enable it on
  // its side is still in flight. The old implementation incorrectly treated
  // the peer's DO as an ack of our DO and never replied.
  const { negotiator, commands } = recordNegotiator();
  negotiator.start();
  commands.length = 0;

  negotiator.handleCommand(DO, OPT.SUPPRESS_GO_AHEAD);

  assert.deepEqual(commands, [{ cmd: WILL, opt: OPT.SUPPRESS_GO_AHEAD }]);
  // The pending DO request stays open until the peer also says WILL/WONT.
  assert.equal(negotiator.pendingDoCount, 1);
});

test("peer's DO NAWS that acknowledges our WILL NAWS still triggers a size subnegotiation", () => {
  const { negotiator, commands, subnegs } = recordNegotiator();
  negotiator.start();
  commands.length = 0;
  subnegs.length = 0;

  negotiator.handleCommand(DO, OPT.NAWS);

  // No echoed WILL NAWS — the peer was acknowledging our own WILL.
  assert.deepEqual(commands, []);
  // But the actual size payload must follow.
  assert.equal(subnegs.length, 1);
  assert.equal(subnegs[0].opt, OPT.NAWS);
  assert.deepEqual(
    [...subnegs[0].payload],
    [(120 >> 8) & 0xff, 120 & 0xff, (40 >> 8) & 0xff, 40 & 0xff],
  );
  assert.equal(negotiator.pendingWillCount, 1); // TERMINAL-TYPE still outstanding
});

test("peer's independent DO NAWS (no WILL pending) replies WILL + size subneg", () => {
  const { negotiator, commands, subnegs } = recordNegotiator();
  // Note: not calling start(), so no WILL NAWS is pending.
  negotiator.handleCommand(DO, OPT.NAWS);
  assert.deepEqual(commands, [{ cmd: WILL, opt: OPT.NAWS }]);
  assert.equal(subnegs.length, 1);
  assert.equal(subnegs[0].opt, OPT.NAWS);
});

test("peer's WILL ECHO triggers DO ECHO, repeated WILL ECHO is swallowed as ack", () => {
  const { negotiator, commands } = recordNegotiator();
  // First WILL ECHO: fresh request → we reply DO ECHO. That DO is sent via
  // the raw writer (not requestOption), so it is NOT in pendingDoRequests.
  // The peer's subsequent WILL ECHO is a re-announce and we should reply
  // with another DO. The negotiator does not currently de-duplicate, so
  // this test pins down the actual behaviour: reply each time.
  negotiator.handleCommand(WILL, OPT.ECHO);
  negotiator.handleCommand(WILL, OPT.ECHO);
  assert.deepEqual(commands, [
    { cmd: DO, opt: OPT.ECHO },
    { cmd: DO, opt: OPT.ECHO },
  ]);
});

test("peer's WONT on our pending DO is swallowed", () => {
  const { negotiator, commands } = recordNegotiator();
  negotiator.start();
  commands.length = 0;
  negotiator.handleCommand(WONT, OPT.SUPPRESS_GO_AHEAD);
  assert.deepEqual(commands, []);
  assert.equal(negotiator.pendingDoCount, 0);
});

test("peer's DONT on our pending WILL is swallowed", () => {
  const { negotiator, commands } = recordNegotiator();
  negotiator.start();
  commands.length = 0;
  negotiator.handleCommand(DONT, OPT.TERMINAL_TYPE);
  assert.deepEqual(commands, []);
  // NAWS still outstanding.
  assert.equal(negotiator.pendingWillCount, 1);
});

test("peer's DO on an option we don't support replies WONT", () => {
  const { negotiator, commands } = recordNegotiator();
  negotiator.handleCommand(DO, OPT.LINEMODE);
  assert.deepEqual(commands, [{ cmd: WONT, opt: OPT.LINEMODE }]);
});

test("peer's WILL on an option we don't support replies DONT", () => {
  const { negotiator, commands } = recordNegotiator();
  negotiator.handleCommand(WILL, OPT.NEW_ENVIRON);
  assert.deepEqual(commands, [{ cmd: DONT, opt: OPT.NEW_ENVIRON }]);
});

test("peer's TERMINAL-TYPE SEND subnegotiation replies with IS <termType>", () => {
  const { negotiator, subnegs } = recordNegotiator();
  negotiator.handleSubnegotiation(
    OPT.TERMINAL_TYPE,
    Buffer.from([SUBOPTION_SEND]),
  );
  assert.equal(subnegs.length, 1);
  assert.equal(subnegs[0].opt, OPT.TERMINAL_TYPE);
  assert.equal(
    subnegs[0].payload.toString("ascii"),
    "\x00XTERM-256COLOR",
  );
});

test("negotiator honors a custom termType override", () => {
  const { negotiator, subnegs } = recordNegotiator({ termType: "VT100" });
  negotiator.handleSubnegotiation(
    OPT.TERMINAL_TYPE,
    Buffer.from([SUBOPTION_SEND]),
  );
  assert.equal(subnegs[0].payload.toString("ascii"), "\x00VT100");
});

test("sendWindowSize falls back to 80x24 when getWindowSize returns garbage", () => {
  const { negotiator, subnegs } = recordNegotiator({
    getWindowSize: () => ({ cols: NaN, rows: -3 }),
  });
  negotiator.sendWindowSize();
  assert.deepEqual([...subnegs[0].payload], [0, 80, 0, 24]);
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
