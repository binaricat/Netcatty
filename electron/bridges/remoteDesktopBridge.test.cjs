"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { WebSocket } = require("ws");
const rfb2 = require("rfb2");

const {
  VNC_S2C,
  VNC_C2S,
  buildPreferredVncSecurity,
  isAllowedLoopbackOrigin,
  createRemoteDesktopService,
  buildDefaultRdpFileContent,
  rewriteRdpFullAddress,
  buildSystemVncUrl,
  registerMainOsHandlers,
} = require("./remoteDesktopBridge.cjs");

function connectWsExpectReject(url, origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin !== undefined ? { headers: { Origin: origin } } : {});
    ws.once("open", () => {
      ws.close();
      reject(new Error("Expected WebSocket upgrade to be rejected, but it opened"));
    });
    ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode);
    });
    ws.once("error", (err) => {
      if (err && /401|403|404/.test(String(err.message))) {
        const match = String(err.message).match(/(401|403|404)/);
        resolve(Number(match[1]));
      }
    });
  });
}

describe("remoteDesktopBridge loopback WS security (Origin + one-time 256-bit token)", () => {
  it("validates allowed Origin rules strictly", () => {
    assert.equal(isAllowedLoopbackOrigin("app://netcatty"), true);
    assert.equal(isAllowedLoopbackOrigin("http://localhost:5173"), true);
    assert.equal(isAllowedLoopbackOrigin("http://127.0.0.1:5173"), true);
    assert.equal(isAllowedLoopbackOrigin(""), false);
    assert.equal(isAllowedLoopbackOrigin(undefined), false);
    assert.equal(isAllowedLoopbackOrigin("null"), false);
    assert.equal(isAllowedLoopbackOrigin("https://evil.example.com"), false);
    assert.equal(isAllowedLoopbackOrigin("http://localhost.evil.com"), false);
    assert.equal(isAllowedLoopbackOrigin("http://localhost:5173", { allowDevOrigins: false }), false);
  });

  it("rejects missing Origin, untrusted Origin, invalid token, and token reuse", async () => {
    const service = createRemoteDesktopService({
      dial: async () => {
        throw new Error("should not dial during auth rejection test");
      },
    });
    try {
      const fakeEvent = { sender: { id: 101, isDestroyed: () => false, send: () => {} } };
      const started = await service.startSession(fakeEvent, {
        protocol: "vnc",
        hostname: "127.0.0.1",
        port: 5900,
      });

      assert.match(started.wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/rd\?sessionId=/);
      const parsed = new URL(started.wsUrl);
      const token = parsed.searchParams.get("token");
      assert.equal(token.length, 64); // 256-bit hex

      // 1. Missing Origin -> 403
      assert.equal(await connectWsExpectReject(started.wsUrl, undefined), 403);
      // 2. Evil Origin -> 403
      assert.equal(await connectWsExpectReject(started.wsUrl, "https://attacker.invalid"), 403);
      // 3. Valid Origin + wrong token -> 401 (also consumes token to prevent brute-force)
      const badTokenUrl = `ws://127.0.0.1:${started.port}/rd?sessionId=${encodeURIComponent(started.sessionId)}&token=${"0".repeat(64)}`;
      assert.equal(await connectWsExpectReject(badTokenUrl, "app://netcatty"), 401);
      // 4. Original token was burned after failed attempt -> 401
      assert.equal(await connectWsExpectReject(started.wsUrl, "app://netcatty"), 401);

      // 5. Start fresh session, open once with valid Origin + valid token, then verify reuse is 401
      const started2 = await service.startSession(fakeEvent, {
        protocol: "vnc",
        hostname: "127.0.0.1",
        port: 5900,
      });
      const ws = new WebSocket(started2.wsUrl, { headers: { Origin: "app://netcatty" } });
      await new Promise((resolve) => ws.once("open", resolve));
      // Replay of same one-time token must fail with 401
      assert.equal(await connectWsExpectReject(started2.wsUrl, "app://netcatty"), 401);
      ws.close();
    } finally {
      await service.stopAll();
    }
  });
});

describe("remoteDesktopBridge rfb2 binary framing against in-memory mock RFB server", () => {
  it("streams READY, RAW_RGBA, COPY_RECT, Tight JPEG passthrough, CURSOR, DESKTOP_SIZE, CLIPBOARD, BELL and handles client input", async () => {
    const serverEvents = {
      pointer: [],
      key: [],
      clipboard: [],
      updateRequests: 0,
    };

    // Minimal valid JPEG with SOI + SOF0 (4x4) + EOI so rfb2's jpegSize() validation passes
    const syntheticJpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x04, 0x00, 0x04, 0x01, 0x01, 0x11, 0x00,
      0xff, 0xd9,
    ]);
    // Tight JPEG encoding body: control byte 0x90 (JPEG) + compact length + raw JPEG bytes
    const tightJpegBody = Buffer.concat([
      Buffer.from([0x90, syntheticJpeg.length]),
      syntheticJpeg,
    ]);

    let serverConnRef = null;
    const mockRfbServer = rfb2.createServer(
      {
        width: 320,
        height: 240,
        name: "MockVncDesktop",
        password: "secret",
      },
      (conn) => {
        serverConnRef = conn;
        conn.on("pointer", (ev) => serverEvents.pointer.push(ev));
        conn.on("key", (ev) => serverEvents.key.push(ev));
        conn.on("clipboard", (text) => serverEvents.clipboard.push(text));
        conn.on("updateRequest", () => {
          serverEvents.updateRequests += 1;
          if (serverEvents.updateRequests === 1) {
            // Send 2x2 raw red pixels (BGRX: B=0, G=0, R=255, X=0)
            const rawPixels = Buffer.alloc(2 * 2 * 4);
            for (let i = 0; i < 4; i += 1) {
              rawPixels[i * 4 + 0] = 0;
              rawPixels[i * 4 + 1] = 0;
              rawPixels[i * 4 + 2] = 255;
              rawPixels[i * 4 + 3] = 0;
            }
            const cursorPixels = Buffer.alloc(2 * 2 * 4, 0xff);
            const cursorMask = Buffer.from([0xc0, 0xc0]);
            conn.sendUpdate([
              { type: "pixels", x: 10, y: 20, width: 2, height: 2, data: rawPixels },
              { type: "copy", x: 30, y: 40, width: 8, height: 8, src: { x: 1, y: 2 } },
              {
                type: "encoded",
                x: 50,
                y: 60,
                width: 4,
                height: 4,
                encoding: rfb2.encodings.tight,
                body: tightJpegBody,
              },
              { type: "cursor", x: 1, y: 1, width: 2, height: 2, data: cursorPixels, mask: cursorMask },
              { type: "desktopSize", width: 640, height: 480 },
            ]);
            conn.cutText("hello-from-vnc-server");
            conn.bell();
          }
        });
      },
    );

    await new Promise((resolve) => mockRfbServer.listen(0, "127.0.0.1", resolve));
    const rfbPort = mockRfbServer.address().port;

    const service = createRemoteDesktopService();
    try {
      const fakeEvent = { sender: { id: 202, isDestroyed: () => false, send: () => {} } };
      const started = await service.startSession(fakeEvent, {
        protocol: "vnc",
        hostname: "127.0.0.1",
        port: rfbPort,
        password: "secret",
      });

      const received = [];
      const ws = new WebSocket(started.wsUrl, { headers: { Origin: "app://netcatty" } });

      const allFramesPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for VNC frames; got opcodes: ${received.map((f) => f[0])}`)), 5000);
        ws.on("message", (data) => {
          const buf = Buffer.from(data);
          received.push(buf);
          const opcodes = new Set(received.map((b) => b[0]));
          if (
            opcodes.has(VNC_S2C.READY)
            && opcodes.has(VNC_S2C.RAW_RGBA)
            && opcodes.has(VNC_S2C.COPY_RECT)
            && opcodes.has(VNC_S2C.JPEG)
            && opcodes.has(VNC_S2C.CURSOR)
            && opcodes.has(VNC_S2C.DESKTOP_SIZE)
            && opcodes.has(VNC_S2C.CLIPBOARD)
            && opcodes.has(VNC_S2C.BELL)
          ) {
            clearTimeout(timer);
            resolve();
          }
        });
        ws.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      await allFramesPromise;

      const readyFrame = received.find((f) => f[0] === VNC_S2C.READY);
      const ready = JSON.parse(readyFrame.subarray(1).toString("utf8"));
      assert.equal(ready.width, 320);
      assert.equal(ready.height, 240);
      assert.equal(ready.name, "MockVncDesktop");

      const rawFrame = received.find((f) => f[0] === VNC_S2C.RAW_RGBA);
      assert.equal(rawFrame.readUInt16BE(1), 10);
      assert.equal(rawFrame.readUInt16BE(3), 20);
      assert.equal(rawFrame.readUInt16BE(5), 2);
      assert.equal(rawFrame.readUInt16BE(7), 2);
      // RGBA pixel 0 should be R=255, G=0, B=0, A=255
      assert.deepEqual([...rawFrame.subarray(9, 13)], [255, 0, 0, 255]);

      const copyFrame = received.find((f) => f[0] === VNC_S2C.COPY_RECT);
      assert.equal(copyFrame.readUInt16BE(1), 30);
      assert.equal(copyFrame.readUInt16BE(3), 40);
      assert.equal(copyFrame.readUInt16BE(5), 8);
      assert.equal(copyFrame.readUInt16BE(7), 8);
      assert.equal(copyFrame.readUInt16BE(9), 1);
      assert.equal(copyFrame.readUInt16BE(11), 2);

      const jpegFrame = received.find((f) => f[0] === VNC_S2C.JPEG);
      assert.equal(jpegFrame.readUInt16BE(1), 50);
      assert.equal(jpegFrame.readUInt16BE(3), 60);
      assert.deepEqual(jpegFrame.subarray(9), syntheticJpeg);

      const cursorFrame = received.find((f) => f[0] === VNC_S2C.CURSOR);
      assert.equal(cursorFrame.readUInt16BE(1), 1);
      assert.equal(cursorFrame.readUInt16BE(3), 1);
      assert.equal(cursorFrame.readUInt16BE(5), 2);
      assert.equal(cursorFrame.readUInt16BE(7), 2);
      assert.equal(cursorFrame.length, 9 + 2 * 2 * 4);

      const sizeFrame = received.find((f) => f[0] === VNC_S2C.DESKTOP_SIZE);
      assert.equal(sizeFrame.readUInt16BE(1), 640);
      assert.equal(sizeFrame.readUInt16BE(3), 480);

      const clipFrame = received.find((f) => f[0] === VNC_S2C.CLIPBOARD);
      assert.equal(clipFrame.subarray(1).toString("utf8"), "hello-from-vnc-server");

      // Send client -> server binary frames (pointer, key, clipboard)
      const ptrBuf = Buffer.alloc(6);
      ptrBuf[0] = VNC_C2S.POINTER;
      ptrBuf.writeUInt16BE(123, 1);
      ptrBuf.writeUInt16BE(234, 3);
      ptrBuf[5] = 1;
      ws.send(ptrBuf, { binary: true });

      const keyBuf = Buffer.alloc(6);
      keyBuf[0] = VNC_C2S.KEY;
      keyBuf.writeUInt32BE(0x0041, 1); // 'A'
      keyBuf[5] = 1;
      ws.send(keyBuf, { binary: true });

      ws.send(Buffer.concat([Buffer.from([VNC_C2S.CLIPBOARD]), Buffer.from("from-client")]), { binary: true });

      await new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
          if (serverEvents.pointer.length > 0 && serverEvents.key.length > 0 && serverEvents.clipboard.length > 0) {
            resolve();
            return;
          }
          if (Date.now() - start > 3000) {
            reject(new Error("Timed out waiting for client->server VNC input events"));
            return;
          }
          setTimeout(check, 20);
        };
        check();
      });

      assert.deepEqual(serverEvents.pointer[0], { x: 123, y: 234, buttons: 1 });
      assert.deepEqual(serverEvents.key[0], { keysym: 0x0041, down: true });
      assert.equal(serverEvents.clipboard[0], "from-client");

      ws.close();
      serverConnRef?.end?.();
    } finally {
      await service.stopAll();
      mockRfbServer.close();
    }
  });
});

describe("remoteDesktopBridge system client helpers", () => {
  it("generates .rdp content without plaintext passwords and rewrites full address for tunnels", () => {
    const content = buildDefaultRdpFileContent({
      host: "10.1.2.3",
      port: 33890,
      username: "alice|token-uuid",
      domain: "CORP",
      loadBalanceInfo: "tsv://MS Terminal Services Plugin.1.Desktop",
    });
    assert.match(content, /^full address:s:10\.1\.2\.3:33890/m);
    assert.match(content, /^username:s:alice\|token-uuid/m);
    assert.match(content, /^domain:s:CORP/m);
    assert.match(content, /^loadbalanceinfo:s:tsv:\/\//m);
    assert.doesNotMatch(content, /password/i);

    const rewritten = rewriteRdpFullAddress(content, "127.0.0.1", 54321);
    assert.match(rewritten, /^full address:s:127\.0\.0\.1:54321/m);
  });

  it("builds vnc:// URL safely without embedding passwords", () => {
    assert.equal(buildSystemVncUrl("10.0.0.5", 5901, "bob"), "vnc://bob@10.0.0.5:5901");
    assert.equal(buildSystemVncUrl("10.0.0.5", 5900, ""), "vnc://10.0.0.5:5900");
    assert.equal(buildSystemVncUrl("::1", 5900, ""), "vnc://[::1]:5900");
  });
});

describe("remoteDesktopBridge VNC Fence RTT, stats IPC, and RDPDR OS handler wiring", () => {
  it("measures VNC Fence RTT and RX/TX bandwidth via netcatty:remote-desktop:stats and cleans up timers on close", async () => {
    let fenceRequestsSent = 0;
    const fakeRfb2 = {
      encodings: rfb2.encodings,
      jpegQuality: rfb2.jpegQuality,
      compressionLevel: rfb2.compressionLevel,
      defaultSecurity: rfb2.defaultSecurity,
      securityName: () => "VNCAuth",
      toRgba: (_pf, data) => data,
      createConnection: () => {
        const client = new EventEmitter();
        client.width = 640;
        client.height = 480;
        client.name = "FenceTestDesktop";
        client.securityType = 2;
        client.closed = false;
        client.autoUpdate = false;
        client.pixelFormat = {};
        client.colorMap = null;
        client.supports = {
          fence: true,
          extendedDesktopSize: false,
          unicodeClipboard: false,
          extendedClipboard: false,
          qemuExtendedKeyEvent: false,
          continuousUpdates: false,
        };
        client.fence = (_flags, payload) => {
          fenceRequestsSent += 1;
          const copy = Buffer.from(payload);
          setTimeout(() => {
            if (!client.closed) {
              client.emit("fence", { flags: 0, payload: copy });
            }
          }, 15);
        };
        client.requestUpdate = () => {
          setTimeout(() => {
            if (!client.closed) {
              client.emit("rect", {
                type: "pixels",
                x: 0,
                y: 0,
                width: 16,
                height: 16,
                data: Buffer.alloc(16 * 16 * 4, 0xaa),
              });
            }
          }, 5);
        };
        client.pointerEvent = () => {};
        client.keyEvent = () => {};
        client.destroy = () => {
          if (client.closed) return;
          client.closed = true;
          client.emit("close");
        };
        setImmediate(() => client.emit("connect"));
        return client;
      },
    };

    const statsEvents = [];
    const fakeEvent = {
      sender: {
        id: 303,
        isDestroyed: () => false,
        send: (channel, payload) => {
          if (channel === "netcatty:remote-desktop:stats") {
            statsEvents.push(payload);
          }
        },
      },
    };

    const service = createRemoteDesktopService({
      rfb2Module: fakeRfb2,
      dial: async () => ({
        stream: new EventEmitter(),
        serverAddr: "127.0.0.1:5900",
        cleanup: () => {},
      }),
      statsIntervalMs: 80,
      fenceIntervalMs: 90,
    });

    try {
      const started = await service.startSession(fakeEvent, {
        protocol: "vnc",
        hostname: "127.0.0.1",
        port: 5900,
      });

      const ws = new WebSocket(started.wsUrl, { headers: { Origin: "app://netcatty" } });
      await new Promise((resolve) => ws.once("open", resolve));

      // Send client pointer bytes to populate txBytes
      const ptrBuf = Buffer.alloc(6);
      ptrBuf[0] = VNC_C2S.POINTER;
      ptrBuf.writeUInt16BE(50, 1);
      ptrBuf.writeUInt16BE(60, 3);
      ptrBuf[5] = 1;
      ws.send(ptrBuf, { binary: true });

      await new Promise((resolve) => setTimeout(resolve, 260));

      ws.close();
      await new Promise((resolve) => setTimeout(resolve, 60));

      const countAfterClose = statsEvents.length;
      assert.ok(fenceRequestsSent >= 2, `Expected >= 2 VNC Fence probes, got ${fenceRequestsSent}`);
      assert.ok(countAfterClose >= 2, `Expected >= 2 VNC stats IPC events, got ${countAfterClose}`);

      const last = statsEvents[statsEvents.length - 1];
      assert.equal(last.sessionId, started.sessionId);
      assert.equal(last.protocol, "vnc");
      assert.equal(typeof last.rttMs, "number");
      assert.ok(last.rttMs >= 1, `Expected measured Fence RTT >= 1ms, got ${last.rttMs}`);
      assert.ok(last.totalRxBytes >= 16 * 16 * 4);
      assert.ok(last.totalTxBytes >= 6);
      assert.equal(typeof last.ts, "number");

      // Verify timers stopped after disconnect
      await new Promise((resolve) => setTimeout(resolve, 180));
      assert.equal(statsEvents.length, countAfterClose);
    } finally {
      await service.stopAll();
    }
  });

  it("registers RDPDR and get-local-displays IPC channels in registerMainOsHandlers", async () => {
    const handlers = new Map();
    const fakeIpcMain = {
      handle: (channel, fn) => handlers.set(channel, fn),
    };
    const res = registerMainOsHandlers(fakeIpcMain, {
      electronModule: {
        screen: {
          getAllDisplays: () => [],
          getPrimaryDisplay: () => null,
        },
      },
    });
    assert.ok(handlers.has("netcatty:remote-desktop:rdpdr:pick-folder"));
    assert.ok(handlers.has("netcatty:remote-desktop:rdpdr:register-drives"));
    assert.ok(handlers.has("netcatty:remote-desktop:rdpdr:op"));
    assert.ok(handlers.has("netcatty:remote-desktop:rdpdr:cleanup"));
    assert.ok(handlers.has("netcatty:remote-desktop:get-local-displays"));
    await res.cleanupMainOsResources();
  });

  it("emits VNC_S2C.CAPABILITIES on late server capability updates and handles live SET_ENCODINGS, SET_READ_ONLY, and XVP", async () => {
    const calls = {
      setEncodings: [],
      resizes: [],
      xvpOps: [],
      continuousUpdates: [],
    };
    let activeClient = null;
    const fakeRfb2 = {
      encodings: rfb2.encodings,
      jpegQuality: rfb2.jpegQuality,
      compressionLevel: rfb2.compressionLevel,
      defaultSecurity: rfb2.defaultSecurity,
      securityName: () => "VeNCrypt",
      toRgba: (_pf, data) => data,
      createConnection: () => {
        const client = new EventEmitter();
        activeClient = client;
        client.width = 800;
        client.height = 600;
        client.name = "CapTestDesktop";
        client.securityType = 19;
        client.closed = false;
        client.autoUpdate = false;
        client.pixelFormat = {};
        client.colorMap = null;
        client.supports = {
          fence: false,
          extendedDesktopSize: false,
          unicodeClipboard: false,
          extendedClipboard: false,
          qemuExtendedKeyEvent: false,
          continuousUpdates: false,
          xvp: false,
        };
        client.setEncodings = (enc) => calls.setEncodings.push(enc);
        client.setDesktopSize = async (w, h) => { calls.resizes.push([w, h]); };
        client.xvp = (action) => calls.xvpOps.push(action);
        client.enableContinuousUpdates = (enable) => calls.continuousUpdates.push(enable);
        client.requestUpdate = () => {};
        client.pointerEvent = () => {};
        client.keyEvent = () => {};
        client.destroy = () => {
          if (client.closed) return;
          client.closed = true;
          client.emit("close");
        };
        setImmediate(() => {
          client.emit("connect");
          // Simulate server announcing capabilities AFTER initial connect
          setTimeout(() => {
            if (client.closed) return;
            client.supports.extendedDesktopSize = true;
            client.supports.qemuExtendedKeyEvent = true;
            client.supports.continuousUpdates = true;
            client.supports.xvp = true;
            client.emit("update", []);
          }, 25);
        });
        return client;
      },
    };

    const fakeEvent = { sender: { id: 404, isDestroyed: () => false, send: () => {} } };
    const service = createRemoteDesktopService({
      rfb2Module: fakeRfb2,
      dial: async () => ({
        stream: new EventEmitter(),
        serverAddr: "127.0.0.1:5900",
        cleanup: () => {},
      }),
    });

    try {
      const started = await service.startSession(fakeEvent, {
        protocol: "vnc",
        hostname: "127.0.0.1",
        port: 5900,
      });

      const ws = new WebSocket(started.wsUrl, { headers: { Origin: "app://netcatty" } });
      const capPayload = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for VNC_S2C.CAPABILITIES")), 3000);
        ws.on("message", (data) => {
          const buf = Buffer.from(data);
          if (buf[0] === VNC_S2C.CAPABILITIES) {
            clearTimeout(timer);
            resolve(JSON.parse(buf.subarray(1).toString("utf8")));
          }
        });
      });

      assert.equal(capPayload.supports.extendedDesktopSize, true);
      assert.equal(capPayload.supports.qemuExtendedKeyEvent, true);
      assert.equal(capPayload.supports.xvp, true);
      assert.deepEqual(calls.continuousUpdates, [true]);

      // Live quality switch via SET_ENCODINGS ("lossless")
      ws.send(Buffer.concat([Buffer.from([VNC_C2S.SET_ENCODINGS]), Buffer.from("lossless")]), { binary: true });

      // Toggle read-only ON, then attempt RESIZE (must be blocked)
      ws.send(Buffer.from([VNC_C2S.SET_READ_ONLY, 1]), { binary: true });
      const blockedResize = Buffer.alloc(5);
      blockedResize[0] = VNC_C2S.RESIZE;
      blockedResize.writeUInt16BE(1280, 1);
      blockedResize.writeUInt16BE(720, 3);
      ws.send(blockedResize, { binary: true });

      // Toggle read-only OFF, then send RESIZE and XVP reboot
      ws.send(Buffer.from([VNC_C2S.SET_READ_ONLY, 0]), { binary: true });
      const allowedResize = Buffer.alloc(5);
      allowedResize[0] = VNC_C2S.RESIZE;
      allowedResize.writeUInt16BE(1440, 1);
      allowedResize.writeUInt16BE(900, 3);
      ws.send(allowedResize, { binary: true });
      ws.send(Buffer.concat([Buffer.from([VNC_C2S.XVP]), Buffer.from("reboot")]), { binary: true });

      await new Promise((resolve) => setTimeout(resolve, 60));

      assert.equal(calls.setEncodings.length, 1);
      assert.deepEqual(calls.resizes, [[1440, 900]]);
      assert.deepEqual(calls.xvpOps, ["reboot"]);

      ws.close();
      activeClient?.destroy();
    } finally {
      await service.stopAll();
    }
  });

  it("buildPreferredVncSecurity filters anonymous-DH VeNCrypt subtypes when BoringSSL disallows aNULL while preferring X509/RA2 over plaintext", () => {
    const boringOrder = buildPreferredVncSecurity(rfb2, false, { allowAnonymousDh: false });
    const S = rfb2.security;
    assert.equal(boringOrder.includes(S.TLSNone), false);
    assert.equal(boringOrder.includes(S.TLSVnc), false);
    assert.equal(boringOrder.includes(S.TLSPlain), false);
    assert.equal(boringOrder.includes(S.X509Vnc), true);
    assert.ok(boringOrder.indexOf(S.X509Vnc) < boringOrder.indexOf(S.VNC));

    const opensslOrder = buildPreferredVncSecurity(rfb2, false, { allowAnonymousDh: true });
    assert.equal(opensslOrder.includes(S.TLSVnc), true);
    assert.ok(opensslOrder.indexOf(S.TLSVnc) < opensslOrder.indexOf(S.VNC));
  });
});
