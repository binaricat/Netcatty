const test = require("node:test");
const assert = require("node:assert/strict");
const { Duplex } = require("node:stream");
const { EventEmitter } = require("node:events");

const {
  attachX11Forwarding,
  readLocalX11AuthCookie,
  rewriteX11AuthSetupPacket,
  resolveX11DisplaySpec,
} = require("./x11Forwarding.cjs");

const buildX11SetupPacket = ({ cookie, endian = "l" }) => {
  const protocol = Buffer.from("MIT-MAGIC-COOKIE-1", "ascii");
  const cookieBytes = Buffer.from(cookie, "hex");
  const protocolPad = (4 - (protocol.length % 4)) % 4;
  const cookiePad = (4 - (cookieBytes.length % 4)) % 4;
  const packet = Buffer.alloc(12 + protocol.length + protocolPad + cookieBytes.length + cookiePad);
  packet[0] = endian.charCodeAt(0);
  const writeUInt16 = endian === "l"
    ? packet.writeUInt16LE.bind(packet)
    : packet.writeUInt16BE.bind(packet);
  writeUInt16(11, 2);
  writeUInt16(0, 4);
  writeUInt16(protocol.length, 6);
  writeUInt16(cookieBytes.length, 8);
  protocol.copy(packet, 12);
  cookieBytes.copy(packet, 12 + protocol.length + protocolPad);
  return packet;
};

test("resolveX11DisplaySpec maps unix display to the X11 socket path", () => {
  assert.deepEqual(
    resolveX11DisplaySpec(":2", { platform: "linux" }),
    { path: "/tmp/.X11-unix/X2" },
  );
});

test("resolveX11DisplaySpec treats a bare colon as display zero", () => {
  assert.deepEqual(
    resolveX11DisplaySpec(":", { platform: "darwin" }),
    { path: "/tmp/.X11-unix/X0" },
  );
});

test("resolveX11DisplaySpec maps tcp display numbers to X11 ports", () => {
  assert.deepEqual(
    resolveX11DisplaySpec("localhost:1", { platform: "win32" }),
    { host: "localhost", port: 6001 },
  );
});

test("resolveX11DisplaySpec accepts explicit unix socket paths", () => {
  assert.deepEqual(
    resolveX11DisplaySpec("/private/tmp/com.apple.launchd.test/org.xquartz:0", { platform: "darwin" }),
    { path: "/private/tmp/com.apple.launchd.test/org.xquartz:0" },
  );
});

test("resolveX11DisplaySpec maps unix-prefixed displays to local X11 sockets", () => {
  assert.deepEqual(
    resolveX11DisplaySpec("unix:1", { platform: "linux" }),
    { path: "/tmp/.X11-unix/X1" },
  );
});

test("rewriteX11AuthSetupPacket replaces the SSH fake cookie with the local X11 cookie", () => {
  const fakeCookie = "11111111111111111111111111111111";
  const realCookie = "22222222222222222222222222222222";
  const rewritten = rewriteX11AuthSetupPacket(buildX11SetupPacket({ cookie: fakeCookie }), {
    fakeCookie,
    realCookie: Buffer.from(realCookie, "hex"),
  });

  assert.equal(rewritten.complete, true);
  assert.equal(rewritten.rewritten, true);
  assert.match(rewritten.buffer.toString("hex"), new RegExp(realCookie));
  assert.doesNotMatch(rewritten.buffer.toString("hex"), new RegExp(fakeCookie));
});

test("readLocalX11AuthCookie selects the cookie for the requested display", () => {
  const cookie0 = "00000000000000000000000000000000";
  const cookie10 = "10101010101010101010101010101010";
  const cookie = readLocalX11AuthCookie({
    display: ":0",
    readXauthOutput: () => [
      `host/unix:10  MIT-MAGIC-COOKIE-1  ${cookie10}`,
      `host/unix:0  MIT-MAGIC-COOKIE-1  ${cookie0}`,
    ].join("\n"),
  });

  assert.equal(cookie.toString("hex"), cookie0);
});

test("readLocalX11AuthCookie matches explicit unix socket display paths", () => {
  const cookie0 = "00000000000000000000000000000000";
  const cookie1 = "11111111111111111111111111111111";
  const cookie = readLocalX11AuthCookie({
    display: "/tmp/.X11-unix/X1",
    readXauthOutput: () => [
      `host/unix:0  MIT-MAGIC-COOKIE-1  ${cookie0}`,
      `host/unix:1  MIT-MAGIC-COOKIE-1  ${cookie1}`,
    ].join("\n"),
  });

  assert.equal(cookie.toString("hex"), cookie1);
});

test("attachX11Forwarding reuses a session-level local X11 cookie", async () => {
  const conn = new EventEmitter();
  const localSockets = [];
  const acceptedChannels = [];
  const cookieReads = [];

  const makeDuplex = () => new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  attachX11Forwarding(conn, {
    display: ":0",
    fakeCookie: "11111111111111111111111111111111",
    readLocalAuthCookie: () => {
      cookieReads.push(Date.now());
      return Buffer.from("22222222222222222222222222222222", "hex");
    },
    createSocket: () => {
      const socket = makeDuplex();
      socket.connect = () => {
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      };
      localSockets.push(socket);
      return socket;
    },
    sendMessage: () => {},
    platform: "linux",
  });

  for (let i = 0; i < 2; i++) {
    conn.emit("x11", { srcIP: "127.0.0.1", srcPort: 1234 + i }, () => {
      const channel = makeDuplex();
      acceptedChannels.push(channel);
      return channel;
    }, () => {
      throw new Error("unexpected reject");
    });
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(localSockets.length, 2);
  assert.equal(acceptedChannels.length, 2);
  assert.equal(cookieReads.length, 1);
});

test("attachX11Forwarding pipes accepted X11 channels to the local display socket", async () => {
  const conn = new EventEmitter();
  const localSocket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      localSocket.written = Buffer.concat([localSocket.written ?? Buffer.alloc(0), Buffer.from(chunk)]);
      callback();
    },
  });
  const acceptedChannel = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      acceptedChannel.written = Buffer.concat([acceptedChannel.written ?? Buffer.alloc(0), Buffer.from(chunk)]);
      callback();
    },
  });
  localSocket.connect = () => {
    queueMicrotask(() => localSocket.emit("connect"));
    return localSocket;
  };
  let accepted = false;
  const messages = [];

  attachX11Forwarding(conn, {
    display: ":0",
    createSocket: () => localSocket,
    readLocalAuthCookie: () => null,
    sendMessage: (message) => messages.push(message),
    platform: "linux",
  });

  conn.emit("x11", { srcIP: "127.0.0.1", srcPort: 1234 }, () => {
    accepted = true;
    return acceptedChannel;
  }, () => {
    throw new Error("unexpected reject");
  });

  await new Promise((resolve) => setImmediate(resolve));
  acceptedChannel.push("remote");
  localSocket.push("local");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(accepted, true);
  assert.equal(localSocket.written.toString(), "remote");
  assert.equal(acceptedChannel.written.toString(), "local");
  assert.deepEqual(messages, []);
});

for (const rewriteCookie of [false, true]) {
  test(`attachX11Forwarding hides fd extensions with cookie rewriting ${rewriteCookie ? "enabled" : "disabled"}`, async (t) => {
    const conn = new EventEmitter();
    const capturedLocal = [];
    const capturedRemote = [];
    const warnings = [];
    const makeDuplex = (captured) => new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        captured.push(Buffer.from(chunk));
        callback();
      },
    });
    const localSocket = makeDuplex(capturedLocal);
    const acceptedChannel = makeDuplex(capturedRemote);
    t.after(() => {
      localSocket.destroy();
      acceptedChannel.destroy();
    });
    localSocket.connect = () => {
      queueMicrotask(() => localSocket.emit("connect"));
      return localSocket;
    };
    const fakeCookie = "11111111111111111111111111111111";
    const realCookie = "22222222222222222222222222222222";
    attachX11Forwarding(conn, {
      display: ":0",
      platform: "linux",
      createSocket: () => localSocket,
      fakeCookie: rewriteCookie ? fakeCookie : undefined,
      readLocalAuthCookie: () => rewriteCookie ? Buffer.from(realCookie, "hex") : null,
      logger: { warn: (message) => warnings.push(message) },
    });
    conn.emit("x11", {}, () => acceptedChannel, () => assert.fail("unexpected reject"));
    await new Promise((resolve) => setImmediate(resolve));

    const setup = buildX11SetupPacket({ cookie: fakeCookie });
    const queries = ["DRI3", "MIT-SHM", "GLX"].map((name) => {
      const packet = Buffer.alloc(8 + Math.ceil(name.length / 4) * 4);
      packet[0] = 98;
      packet.writeUInt16LE(packet.length / 4, 2);
      packet.writeUInt16LE(name.length, 4);
      packet.write(name, 8, "ascii");
      return packet;
    });
    // Fragment the auth packet, coalescing its tail with the first requests.
    acceptedChannel.push(setup.subarray(0, 7));
    acceptedChannel.push(Buffer.concat([setup.subarray(7), ...queries]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(Buffer.concat(capturedLocal), Buffer.concat([
      buildX11SetupPacket({ cookie: rewriteCookie ? realCookie : fakeCookie }), ...queries,
    ]));

    const setupReply = Buffer.from([1, 0, 11, 0, 0, 0, 0, 0]);
    const replies = queries.map((_, index) => {
      const packet = Buffer.alloc(32);
      packet[0] = 1;
      packet.writeUInt16LE(index + 1, 2);
      packet[8] = 1;
      return packet;
    });
    const response = Buffer.concat([setupReply, ...replies]);
    for (const byte of response) localSocket.push(Buffer.from([byte]));
    await new Promise((resolve) => setImmediate(resolve));
    const expected = Buffer.from(response);
    expected[8 + 8] = 0;
    expected[8 + 32 + 8] = 0;
    assert.deepEqual(Buffer.concat(capturedRemote), expected);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^\[X11\] hiding DRI3/);
  });
}

test("attachX11Forwarding rejects the remote channel and explains local display failures", async () => {
  const conn = new EventEmitter();
  const localSocket = new EventEmitter();
  localSocket.connect = () => {
    queueMicrotask(() => localSocket.emit("error", new Error("ECONNREFUSED")));
    return localSocket;
  };
  localSocket.destroy = () => {};
  let rejected = false;
  const messages = [];

  attachX11Forwarding(conn, {
    display: "localhost:0",
    createSocket: () => localSocket,
    sendMessage: (message) => messages.push(message),
    platform: "win32",
  });

  conn.emit("x11", { srcIP: "127.0.0.1", srcPort: 1234 }, () => {
    throw new Error("unexpected accept");
  }, () => {
    rejected = true;
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rejected, true);
  assert.match(messages.join("\n"), /Could not connect to the local X11 server/);
  assert.match(messages.join("\n"), /VcXsrv/);
});
