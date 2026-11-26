"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { WebSocket } = require("ws");
const rfb2 = require("rfb2");

const {
  VNC_S2C,
  VNC_C2S,
  isAllowedLoopbackOrigin,
  createRemoteDesktopService,
  buildDefaultRdpFileContent,
  rewriteRdpFullAddress,
  buildSystemVncUrl,
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
