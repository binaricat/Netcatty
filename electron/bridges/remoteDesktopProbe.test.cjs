"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const tls = require("node:tls");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Duplex } = require("node:stream");

const {
  buildX224ConnectionRequest,
  classifyCertTrustStatus,
  probeRemoteDesktop,
} = require("./remoteDesktopProbe.cjs");
const {
  createRemoteDesktopService,
  registerHandlers,
} = require("./remoteDesktopBridge.cjs");

function generateSelfSignedCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-probe-cert-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", keyPath,
      "-out", certPath,
      "-days", "1",
      "-nodes",
      "-subj", "/CN=rdp-probe.example.test",
    ], { stdio: "ignore" });
    return {
      key: fs.readFileSync(keyPath, "utf8"),
      cert: fs.readFileSync(certPath, "utf8"),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let cachedSelfSigned = null;
function getSelfSigned() {
  if (!cachedSelfSigned) cachedSelfSigned = generateSelfSignedCert();
  return cachedSelfSigned;
}

function buildX224Confirm({ selectedProtocol = null, failureCode = null } = {}) {
  if (failureCode !== null) {
    const buf = Buffer.alloc(19);
    buf[0] = 0x03;
    buf[1] = 0x00;
    buf.writeUInt16BE(19, 2);
    buf[4] = 0x0e;
    buf[5] = 0xd0;
    buf[11] = 0x03; // TYPE_RDP_NEG_FAILURE
    buf[12] = 0x00;
    buf.writeUInt16LE(8, 13);
    buf.writeUInt32LE(failureCode, 15);
    return buf;
  }
  const buf = Buffer.alloc(19);
  buf[0] = 0x03;
  buf[1] = 0x00;
  buf.writeUInt16BE(19, 2);
  buf[4] = 0x0e;
  buf[5] = 0xd0;
  buf[11] = 0x02; // TYPE_RDP_NEG_RSP
  buf[12] = 0x00;
  buf.writeUInt16LE(8, 13);
  buf.writeUInt32LE(selectedProtocol ?? 0, 15);
  return buf;
}

function listenServer(onConnection) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(onConnection);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("buildX224ConnectionRequest emits exact 19-byte PDU without loadBalanceInfo and adjusts length with routing token", () => {
  const autoPdu = buildX224ConnectionRequest({ securityMode: "auto" });
  assert.equal(autoPdu.length, 19);
  assert.equal(autoPdu.toString("hex"), "030000130ee000000000000100080003000000");

  const rdpOnly = buildX224ConnectionRequest({ securityMode: "rdp" });
  assert.equal(rdpOnly.readUInt32LE(15), 0);

  const tlsOnly = buildX224ConnectionRequest({ securityMode: "tls" });
  assert.equal(tlsOnly.readUInt32LE(15), 1);

  const withLb = buildX224ConnectionRequest({
    securityMode: "nla",
    loadBalanceInfo: "Cookie: mstshash=farm",
  });
  const token = "Cookie: mstshash=farm\r\n";
  assert.equal(withLb.length, 19 + token.length);
  assert.equal(withLb.readUInt16BE(2), withLb.length);
  assert.equal(withLb[4], 14 + token.length);
  assert.equal(withLb.subarray(11, 11 + token.length).toString("ascii"), token);
});

test("RDP probe negotiates NLA/TLS, extracts X.509 SHA-256 fingerprint, classifies TOFU status, and sends zero credentials", async () => {
  const { key, cert } = getSelfSigned();
  const receivedChunks = [];

  const { server, port } = await listenServer((socket) => {
    socket.once("data", (chunk) => {
      receivedChunks.push(Buffer.from(chunk));
      socket.write(buildX224Confirm({ selectedProtocol: 2 /* NLA / CredSSP */ }));
      const tlsServer = new tls.TLSSocket(socket, { isServer: true, key, cert });
      tlsServer.on("data", (d) => receivedChunks.push(Buffer.from(d)));
      tlsServer.on("error", () => {});
    });
    socket.on("error", () => {});
  });

  try {
    // First-seen check (even if caller mistakenly passed password/username, zero creds are sent!)
    const first = await probeRemoteDesktop({
      protocol: "rdp",
      hostname: "127.0.0.1",
      port,
      username: "SECRET_ADMIN",
      password: "SUPER_SECRET_PASSWORD",
      domain: "SECRET_DOMAIN",
      securityMode: "auto",
      mode: "full",
    });

    assert.equal(first.ok, true);
    assert.equal(first.protocol, "rdp");
    assert.equal(first.bannerVerified, true);
    assert.equal(first.rdpSecurity, "nla");
    assert.equal(typeof first.rttMs, "number");
    assert.ok(first.tlsVersion);
    assert.ok(first.tlsCipher);
    assert.ok(first.cert?.fingerprintSha256);
    assert.equal(first.cert?.trustStatus, "first-seen");
    assert.match(first.cert?.subject || "", /rdp-probe\.example\.test/);

    const wireText = Buffer.concat(receivedChunks).toString("utf8");
    assert.ok(!wireText.includes("SECRET_ADMIN"));
    assert.ok(!wireText.includes("SUPER_SECRET_PASSWORD"));
    assert.ok(!wireText.includes("SECRET_DOMAIN"));

    // Trusted check when fingerprint matches
    const trusted = await probeRemoteDesktop({
      protocol: "rdp",
      hostname: "127.0.0.1",
      port,
      knownCertFingerprints: [first.cert.fingerprintSha256],
      mode: "full",
    });
    assert.equal(trusted.ok, true);
    assert.equal(trusted.cert?.trustStatus, "trusted");

    // Changed check when fingerprint differs
    const changed = await probeRemoteDesktop({
      protocol: "rdp",
      hostname: "127.0.0.1",
      port,
      knownCertFingerprints: ["AA:BB:CC:DD"],
      mode: "full",
    });
    assert.equal(changed.ok, true);
    assert.equal(changed.cert?.trustStatus, "changed");
  } finally {
    await closeServer(server);
  }
});

test("RDP probe handles Standard RDP (no TLS) and maps RDP_NEG_FAILURE codes cleanly", async () => {
  const stdSrv = await listenServer((socket) => {
    socket.once("data", () => {
      socket.write(buildX224Confirm({ selectedProtocol: 0 }));
    });
    socket.on("error", () => {});
  });
  const failSrv = await listenServer((socket) => {
    socket.once("data", () => {
      socket.write(buildX224Confirm({ failureCode: 5 /* HYBRID_REQUIRED_BY_SERVER */ }));
    });
    socket.on("error", () => {});
  });

  try {
    const std = await probeRemoteDesktop({
      protocol: "rdp",
      hostname: "127.0.0.1",
      port: stdSrv.port,
      securityMode: "rdp",
      mode: "full",
    });
    assert.equal(std.ok, true);
    assert.equal(std.rdpSecurity, "rdp");
    assert.equal(std.cert, undefined);

    const fail = await probeRemoteDesktop({
      protocol: "rdp",
      hostname: "127.0.0.1",
      port: failSrv.port,
      securityMode: "tls",
      mode: "full",
    });
    assert.equal(fail.ok, false);
    assert.match(fail.error || "", /HYBRID_REQUIRED_BY_SERVER/);
  } finally {
    await closeServer(stdSrv.server);
    await closeServer(failSrv.server);
  }
});

test("VNC probe parses RFB 3.8, RFB 3.3, Apple ARD 3.889, rejection reasons, and VeNCrypt 0.2 X.509 certificates", async () => {
  const { key, cert } = getSelfSigned();

  // RFB 3.8 with VeNCrypt (19) -> X509None (260) -> TLS cert
  const vencryptSrv = await listenServer((socket) => {
    let step = 0;
    let buf = Buffer.alloc(0);
    socket.write(Buffer.from("RFB 003.008\n", "ascii"));
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (step === 0 && buf.length >= 12) {
        buf = buf.subarray(12);
        step = 1;
        // Offer 3 types: VNCAuth (2), VeNCrypt (19), Apple ARD (30)
        socket.write(Buffer.from([3, 2, 19, 30]));
      }
      if (step === 1 && buf.length >= 1) {
        assert.equal(buf[0], 19);
        buf = buf.subarray(1);
        step = 2;
        socket.write(Buffer.from([0, 2])); // VeNCrypt 0.2
      }
      if (step === 2 && buf.length >= 2) {
        buf = buf.subarray(2);
        step = 3;
        // status=0 (ok), subCount=2: X509None (260), X509Vnc (261)
        const resp = Buffer.alloc(2 + 8);
        resp[0] = 0;
        resp[1] = 2;
        resp.writeUInt32BE(260, 2);
        resp.writeUInt32BE(261, 6);
        socket.write(resp);
      }
      if (step === 3 && buf.length >= 4) {
        const chosen = buf.readUInt32BE(0);
        assert.equal(chosen, 260);
        step = 4;
        socket.write(Buffer.from([1])); // VeNCrypt ack = proceed to TLS
        const tlsSock = new tls.TLSSocket(socket, { isServer: true, key, cert });
        tlsSock.on("error", () => {});
      }
    });
    socket.on("error", () => {});
  });

  // RFB 3.3 server returning VNCAuth (2)
  const rfb33Srv = await listenServer((socket) => {
    socket.write(Buffer.from("RFB 003.003\n", "ascii"));
    socket.once("data", () => {
      const resp = Buffer.alloc(4);
      resp.writeUInt32BE(2, 0);
      socket.write(resp);
    });
    socket.on("error", () => {});
  });

  // RFB 3.8 server rejecting with count=0 + reason
  const rejectSrv = await listenServer((socket) => {
    socket.write(Buffer.from("RFB 003.008\n", "ascii"));
    socket.once("data", () => {
      const msg = Buffer.from("Too many authentication failures", "utf8");
      const resp = Buffer.alloc(1 + 4 + msg.length);
      resp[0] = 0;
      resp.writeUInt32BE(msg.length, 1);
      msg.copy(resp, 5);
      socket.write(resp);
    });
    socket.on("error", () => {});
  });

  try {
    const ven = await probeRemoteDesktop({
      protocol: "vnc",
      hostname: "127.0.0.1",
      port: vencryptSrv.port,
      mode: "full",
    });
    assert.equal(ven.ok, true);
    assert.equal(ven.rfbVersion, "RFB 003.008");
    assert.ok(ven.vncSecurityTypes.some((s) => s.id === 19 && s.name === "VeNCrypt"));
    assert.ok(ven.vncSecurityTypes.some((s) => s.id === 30 && s.name === "Apple ARD"));
    assert.ok(ven.vncSecurityTypes.some((s) => s.id === 260 && s.name === "VeNCrypt:X509None"));
    assert.ok(ven.cert?.fingerprintSha256);
    assert.equal(ven.cert?.trustStatus, "first-seen");

    const r33 = await probeRemoteDesktop({
      protocol: "vnc",
      hostname: "127.0.0.1",
      port: rfb33Srv.port,
      mode: "full",
    });
    assert.equal(r33.ok, true);
    assert.equal(r33.rfbVersion, "RFB 003.003");
    assert.deepEqual(r33.vncSecurityTypes, [{ id: 2, name: "VNCAuth" }]);

    const rej = await probeRemoteDesktop({
      protocol: "vnc",
      hostname: "127.0.0.1",
      port: rejectSrv.port,
      mode: "full",
    });
    assert.equal(rej.ok, false);
    assert.match(rej.error || "", /Too many authentication failures/);
  } finally {
    await closeServer(vencryptSrv.server);
    await closeServer(rfb33Srv.server);
    await closeServer(rejectSrv.server);
  }
});

test("heartbeat mode supports non-matching banner fallback, companion SSH forwardOut, proxy dialer, and abort", async () => {
  // Server that accepts TCP but sends garbage instead of RFB banner
  const nonRfbSrv = await listenServer((socket) => {
    socket.write(Buffer.from("HELLO WORLD!\n", "ascii"));
    socket.on("error", () => {});
  });
  // Silent server for abort test
  const silentSrv = await listenServer((socket) => {
    socket.on("error", () => {});
  });

  try {
    const mismatch = await probeRemoteDesktop({
      protocol: "vnc",
      hostname: "127.0.0.1",
      port: nonRfbSrv.port,
      mode: "heartbeat",
      timeoutMs: 1000,
      handshakeTimeoutMs: 500,
    });
    assert.equal(mismatch.ok, true);
    assert.equal(mismatch.reachable, true);
    assert.equal(mismatch.bannerVerified, false);
    assert.equal(typeof mismatch.rttMs, "number");

    // Companion SSH forwardOut path
    let forwardTarget = null;
    const fakeConn = {
      forwardOut(_srcIp, _srcPort, dstHost, dstPort, cb) {
        forwardTarget = { dstHost, dstPort };
        const stream = new Duplex({
          read() {},
          write(_chunk, _enc, done) { done(); },
        });
        cb(null, stream);
        setImmediate(() => stream.push(Buffer.from("RFB 003.008\n", "ascii")));
      },
    };
    const comp = await probeRemoteDesktop(
      {
        protocol: "vnc",
        hostname: "127.0.0.1",
        port: 5901,
        tunnelViaHostSsh: true,
        tunnelTargetHost: "127.0.0.1",
        mode: "heartbeat",
      },
      { sshConn: fakeConn },
    );
    assert.equal(comp.ok, true);
    assert.equal(comp.bannerVerified, true);
    assert.equal(comp.bannerDetail, "RFB 3.8");
    assert.deepEqual(forwardTarget, { dstHost: "127.0.0.1", dstPort: 5901 });

    // Proxy dialer path
    let proxyCalled = false;
    const proxied = await probeRemoteDesktop(
      {
        protocol: "vnc",
        hostname: "vnc.internal",
        port: 5900,
        proxy: { type: "socks5", host: "127.0.0.1", port: 1080 },
        mode: "heartbeat",
      },
      {
        proxyDialer: async () => {
          proxyCalled = true;
          const s = new Duplex({
            read() {},
            write(_c, _e, done) { done(); },
          });
          setImmediate(() => s.push(Buffer.from("RFB 003.889\n", "ascii")));
          return s;
        },
      },
    );
    assert.equal(proxyCalled, true);
    assert.equal(proxied.ok, true);
    assert.equal(proxied.bannerDetail, "RFB 3.889");

    // Abort mid-handshake
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const aborted = await probeRemoteDesktop(
      {
        protocol: "vnc",
        hostname: "127.0.0.1",
        port: silentSrv.port,
        mode: "full",
        handshakeTimeoutMs: 5000,
      },
      { signal: ac.signal },
    );
    assert.equal(aborted.ok, false);
    assert.match(aborted.error || "", /cancelled/i);
  } finally {
    await closeServer(nonRfbSrv.server);
    await closeServer(silentSrv.server);
  }
});

test("remoteDesktopBridge testConnection & cancelTestConnection route cleanly and preserve companion SSH target for worker forwarding", async () => {
  const { server, port } = await listenServer((socket) => {
    socket.on("error", () => {});
  });
  try {
    const service = createRemoteDesktopService();
    const sent = [];
    const fakeEvent = {
      sender: {
        id: 11,
        isDestroyed: () => false,
        send: (ch, payload) => sent.push({ ch, payload }),
      },
    };
    const pending = service.testConnection(fakeEvent, {
      sessionId: "probe-cancel-1",
      protocol: "vnc",
      hostname: "127.0.0.1",
      port,
      handshakeTimeoutMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 30));
    const cancelled = service.cancelTestConnection(fakeEvent, { sessionId: "probe-cancel-1" });
    assert.equal(cancelled.ok, true);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.ok(sent.some((m) => m.ch === "netcatty:chain:progress" && m.payload.sessionId === "probe-cancel-1"));

    // Verify worker IPC forwarding attaches _macLocalNetworkMainProbed onto sshTunnelConfig for companion tunnels
    const handlers = new Map();
    const forwarded = [];
    registerHandlers(
      { handle: (ch, fn) => handlers.set(ch, fn) },
      {
        registerOsHandlers: false,
        terminalWorkerManager: {
          request: async (ch, payload, meta) => {
            forwarded.push({ ch, payload, meta });
            return { ok: true };
          },
        },
      },
    );
    assert.ok(handlers.has("netcatty:remote-desktop:test"));
    assert.ok(handlers.has("netcatty:remote-desktop:test:cancel"));

    await handlers.get("netcatty:remote-desktop:test")(fakeEvent, {
      protocol: "rdp",
      hostname: "127.0.0.1",
      port: 3389,
      tunnelViaHostSsh: true,
      sshTunnelConfig: { hostname: "192.168.1.50", port: 22, username: "alice" },
    });
    assert.equal(forwarded[0].ch, "netcatty:remote-desktop:test");
    assert.equal(forwarded[0].payload._macLocalNetworkMainProbed, true);
    assert.equal(forwarded[0].payload.sshTunnelConfig._macLocalNetworkMainProbed, true);
  } finally {
    await closeServer(server);
  }
});

test("classifyCertTrustStatus normalizes formatting", () => {
  assert.equal(classifyCertTrustStatus("aa:bb:cc", []), "first-seen");
  assert.equal(classifyCertTrustStatus("SHA-256:aa-bb-cc", ["AA:BB:CC"]), "trusted");
  assert.equal(classifyCertTrustStatus("AA:BB:DD", ["AA:BB:CC"]), "changed");
});
