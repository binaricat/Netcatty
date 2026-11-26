"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const http = require("node:http");
const { WebSocket, WebSocketServer } = require("ws");

const {
  RDCLEANPATH_VERSION_1,
  GENERAL_ERROR_CODE,
  TLS_HANDSHAKE_FAILED_ERROR_CODE,
  decodeRDCleanPathPdu,
  encodeRDCleanPathRequest,
  encodeRDCleanPathResponse,
  encodeRDCleanPathError,
  computeCertSha256Fingerprint,
  extractPeerCertInfo,
  parseX224ConfirmNegotiation,
  handleRdpCleanPathConnection,
} = require("./rdpCleanPathProxy.cjs");

function generateSelfSignedCert() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-rdp-cert-"));
  const keyPath = path.join(tmpDir, "key.pem");
  const certPath = path.join(tmpDir, "cert.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048",
        "-keyout", keyPath,
        "-out", certPath,
        "-days", "1",
        "-nodes",
        "-subj", "/CN=rdp-test.local/O=NetcattyTest",
      ],
      { stdio: "ignore" },
    );
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function buildX224RequestTpkt() {
  // Minimal TPKT (4B) + X.224 CR (7B) + RDP_NEG_REQ (8B) = 19 bytes
  const buf = Buffer.alloc(19);
  buf[0] = 0x03; // TPKT v3
  buf[1] = 0x00;
  buf.writeUInt16BE(19, 2);
  buf[4] = 14; // X.224 length indicator
  buf[5] = 0xe0; // Connection Request
  buf[11] = 0x01; // TYPE_RDP_NEG_REQ
  buf.writeUInt16LE(8, 13);
  buf.writeUInt32LE(0x00000003, 15); // TLS | HYBRID
  return buf;
}

function buildX224ConfirmTpkt(selectedProtocol = 0x00000002) {
  const buf = Buffer.alloc(19);
  buf[0] = 0x03;
  buf[1] = 0x00;
  buf.writeUInt16BE(19, 2);
  buf[4] = 14;
  buf[5] = 0xd0; // Connection Confirm
  buf[11] = 0x02; // TYPE_RDP_NEG_RSP
  buf.writeUInt16LE(8, 13);
  buf.writeUInt32LE(selectedProtocol, 15);
  return buf;
}

describe("rdpCleanPathProxy ASN.1 DER codec", () => {
  it("round-trips RDCleanPathPdu request with all optional fields and long lengths", () => {
    const x224 = Buffer.alloc(320, 0xab);
    const encoded = encodeRDCleanPathRequest({
      version: RDCLEANPATH_VERSION_1,
      destination: "win11.corp.local:3389",
      proxyAuth: "one-time-token",
      serverAuth: "kerberos-hint",
      preconnectionBlob: "vm-id-12345",
      x224ConnectionPdu: x224,
    });

    const decoded = decodeRDCleanPathPdu(encoded);
    assert.equal(decoded.version, 3390);
    assert.equal(decoded.destination, "win11.corp.local:3389");
    assert.equal(decoded.proxyAuth, "one-time-token");
    assert.equal(decoded.serverAuth, "kerberos-hint");
    assert.equal(decoded.preconnectionBlob, "vm-id-12345");
    assert.deepEqual(decoded.x224ConnectionPdu, x224);
  });

  it("round-trips RDCleanPathPdu response with cert chain and serverAddr", () => {
    const cert1 = Buffer.alloc(600, 0x30);
    const cert2 = Buffer.alloc(200, 0x31);
    const x224 = buildX224ConfirmTpkt(2);
    const encoded = encodeRDCleanPathResponse({
      x224ConnectionPdu: x224,
      serverCertChain: [cert1, cert2],
      serverAddr: "10.0.0.42:3389",
    });

    const decoded = decodeRDCleanPathPdu(encoded);
    assert.equal(decoded.version, 3390);
    assert.deepEqual(decoded.x224ConnectionPdu, x224);
    assert.equal(decoded.serverCertChain.length, 2);
    assert.deepEqual(decoded.serverCertChain[0], cert1);
    assert.deepEqual(decoded.serverCertChain[1], cert2);
    assert.equal(decoded.serverAddr, "10.0.0.42:3389");
  });

  it("round-trips RDCleanPathErr PDU", () => {
    const encoded = encodeRDCleanPathError({
      errorCode: TLS_HANDSHAKE_FAILED_ERROR_CODE,
      httpStatusCode: 502,
      wsaLastError: 10061,
      tlsAlertCode: 42,
    });
    const decoded = decodeRDCleanPathPdu(encoded);
    assert.equal(decoded.version, 3390);
    assert.deepEqual(decoded.error, {
      errorCode: TLS_HANDSHAKE_FAILED_ERROR_CODE,
      httpStatusCode: 502,
      wsaLastError: 10061,
      tlsAlertCode: 42,
    });
  });

  it("rejects wrong version and truncated DER", () => {
    const badVersion = encodeRDCleanPathRequest({ version: 1234 });
    assert.throws(() => decodeRDCleanPathPdu(badVersion), /Unsupported RDCleanPathPdu version/);
    assert.throws(() => decodeRDCleanPathPdu(Buffer.from([0x30, 0x10, 0x02])), /exceeds remaining/);
  });

  it("computes SHA-256 fingerprint and handles self-signed cert cycle safely", () => {
    const raw = Buffer.from("synthetic-der-cert-bytes");
    const fp = computeCertSha256Fingerprint(raw);
    assert.match(fp, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

    const selfSigned = {
      raw,
      subject: { CN: "rdp.example", O: "Netcatty" },
      issuer: { CN: "rdp.example", O: "Netcatty" },
      valid_from: "Jan  1 00:00:00 2026 GMT",
      valid_to: "Jan  1 00:00:00 2027 GMT",
      serialNumber: "01",
    };
    selfSigned.issuerCertificate = selfSigned;

    const info = extractPeerCertInfo({ getPeerCertificate: () => selfSigned });
    assert.equal(info.certChainDer.length, 1);
    assert.equal(info.fingerprintSha256, fp);
    assert.equal(info.subject, "CN=rdp.example, O=Netcatty");
  });

  it("classifies X.224 Connection Confirm negotiation protocols", () => {
    assert.equal(parseX224ConfirmNegotiation(buildX224ConfirmTpkt(0x02)).requiresTls, true);
    assert.equal(parseX224ConfirmNegotiation(buildX224ConfirmTpkt(0x01)).requiresTls, true);
    assert.equal(parseX224ConfirmNegotiation(buildX224ConfirmTpkt(0x00)).requiresTls, false);
  });
});

describe("rdpCleanPathProxy end-to-end TLS + TOFU + binary relay", () => {
  it("runs X.224 -> TLS upgrade -> TOFU callback BEFORE sending response -> bidirectional relay", async () => {
    const { key, cert } = generateSelfSignedCert();
    const x224Confirm = buildX224ConfirmTpkt(0x02);
    const events = [];

    // Mock RDP server: reads X.224 CR, replies X.224 CC, upgrades to TLS, echoes data prefixed with "ECHO:"
    const rdpServer = net.createServer((rawSocket) => {
      rawSocket.once("data", () => {
        rawSocket.write(x224Confirm);
        const tlsServerSock = new tls.TLSSocket(rawSocket, {
          isServer: true,
          key,
          cert,
        });
        tlsServerSock.on("data", (chunk) => {
          tlsServerSock.write(Buffer.concat([Buffer.from("ECHO:"), chunk]));
        });
        tlsServerSock.on("error", () => {});
      });
    });

    await new Promise((resolve) => rdpServer.listen(0, "127.0.0.1", resolve));
    const rdpPort = rdpServer.address().port;

    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const wsPort = httpServer.address().port;

    let proxyPromise;
    wss.on("connection", (ws) => {
      proxyPromise = handleRdpCleanPathConnection({
        ws,
        host: "127.0.0.1",
        port: rdpPort,
        dial: async () => {
          const sock = net.connect(rdpPort, "127.0.0.1");
          await new Promise((resolve, reject) => {
            sock.once("connect", resolve);
            sock.once("error", reject);
          });
          return { stream: sock, cleanup: () => sock.destroy() };
        },
        verifyCertificate: async (certInfo) => {
          events.push("verifyCertificate");
          assert.match(certInfo.fingerprintSha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
          assert.match(certInfo.subject, /CN=rdp-test\.local/);
          return { accepted: true };
        },
      });
    });

    const clientWs = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise((resolve) => clientWs.once("open", resolve));

    const respPromise = new Promise((resolve) => {
      clientWs.once("message", (data) => {
        events.push("wsResponseReceived");
        resolve(Buffer.from(data));
      });
    });

    clientWs.send(encodeRDCleanPathRequest({
      destination: `127.0.0.1:${rdpPort}`,
      x224ConnectionPdu: buildX224RequestTpkt(),
    }), { binary: true });

    const respBuf = await respPromise;
    // Critical invariant: TOFU verification happened strictly BEFORE sending RDCleanPathPdu response
    assert.deepEqual(events, ["verifyCertificate", "wsResponseReceived"]);

    const decoded = decodeRDCleanPathPdu(respBuf);
    assert.equal(decoded.version, RDCLEANPATH_VERSION_1);
    assert.deepEqual(decoded.x224ConnectionPdu, x224Confirm);
    assert.equal(decoded.serverCertChain.length, 1);
    assert.ok(decoded.serverAddr.includes(String(rdpPort)));

    // Verify bidirectional TLS relay works
    const echoPromise = new Promise((resolve) => {
      clientWs.once("message", (data) => resolve(Buffer.from(data).toString("utf8")));
    });
    clientWs.send(Buffer.from("hello-rdp"), { binary: true });
    assert.equal(await echoPromise, "ECHO:hello-rdp");

    clientWs.close();
    await proxyPromise;
    wss.close();
    httpServer.close();
    rdpServer.close();
  });

  it("aborts with RDCleanPathErr and sends zero credentials when TOFU rejects certificate", async () => {
    const { key, cert } = generateSelfSignedCert();
    const x224Confirm = buildX224ConfirmTpkt(0x02);
    let serverReceivedPostTlsData = false;

    const rdpServer = net.createServer((rawSocket) => {
      rawSocket.once("data", () => {
        rawSocket.write(x224Confirm);
        const tlsServerSock = new tls.TLSSocket(rawSocket, { isServer: true, key, cert });
        tlsServerSock.on("data", () => { serverReceivedPostTlsData = true; });
        tlsServerSock.on("error", () => {});
      });
    });

    await new Promise((resolve) => rdpServer.listen(0, "127.0.0.1", resolve));
    const rdpPort = rdpServer.address().port;

    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const wsPort = httpServer.address().port;

    let proxyPromise;
    wss.on("connection", (ws) => {
      proxyPromise = handleRdpCleanPathConnection({
        ws,
        host: "127.0.0.1",
        port: rdpPort,
        dial: async () => {
          const sock = net.connect(rdpPort, "127.0.0.1");
          await new Promise((resolve, reject) => {
            sock.once("connect", resolve);
            sock.once("error", reject);
          });
          return { stream: sock, cleanup: () => sock.destroy() };
        },
        verifyCertificate: async () => ({ accepted: false, reason: "User rejected" }),
      });
    });

    const clientWs = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise((resolve) => clientWs.once("open", resolve));

    const errPromise = new Promise((resolve) => {
      clientWs.once("message", (data) => resolve(Buffer.from(data)));
    });

    clientWs.send(encodeRDCleanPathRequest({
      destination: `127.0.0.1:${rdpPort}`,
      x224ConnectionPdu: buildX224RequestTpkt(),
    }), { binary: true });

    const errBuf = await errPromise;
    const decoded = decodeRDCleanPathPdu(errBuf);
    assert.equal(decoded.error?.errorCode, TLS_HANDSHAKE_FAILED_ERROR_CODE);
    assert.equal(decoded.serverCertChain, undefined);
    assert.equal(serverReceivedPostTlsData, false);

    await proxyPromise;
    wss.close();
    httpServer.close();
    rdpServer.close();
  });

  it("emits RDP RTT and smoothed RX/TX bandwidth telemetry for direct connections and cleans up timers on close", async () => {
    const { key, cert } = generateSelfSignedCert();
    const x224Confirm = buildX224ConfirmTpkt(0x02);
    let tcpConnections = 0;

    const rdpServer = net.createServer((rawSocket) => {
      tcpConnections += 1;
      rawSocket.once("data", () => {
        rawSocket.write(x224Confirm);
        const tlsServerSock = new tls.TLSSocket(rawSocket, { isServer: true, key, cert });
        tlsServerSock.on("data", (chunk) => {
          tlsServerSock.write(Buffer.concat([Buffer.from("RSP:"), chunk]));
        });
        tlsServerSock.on("error", () => {});
      });
      rawSocket.on("error", () => {});
    });

    await new Promise((resolve) => rdpServer.listen(0, "127.0.0.1", resolve));
    const rdpPort = rdpServer.address().port;

    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const wsPort = httpServer.address().port;

    const statsSamples = [];
    let proxyPromise;
    wss.on("connection", (ws) => {
      proxyPromise = handleRdpCleanPathConnection({
        ws,
        host: "127.0.0.1",
        port: rdpPort,
        isDirectConnection: true,
        statsIntervalMs: 80,
        rttProbeIntervalMs: 120,
        rttProbeTimeoutMs: 1000,
        dial: async () => {
          const sock = net.connect(rdpPort, "127.0.0.1");
          await new Promise((resolve, reject) => {
            sock.once("connect", resolve);
            sock.once("error", reject);
          });
          return { stream: sock, cleanup: () => sock.destroy() };
        },
        verifyCertificate: async () => ({ accepted: true }),
        onStats: (sample) => statsSamples.push(sample),
      });
    });

    const clientWs = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise((resolve) => clientWs.once("open", resolve));

    const respPromise = new Promise((resolve) => {
      clientWs.once("message", (data) => resolve(Buffer.from(data)));
    });
    clientWs.send(encodeRDCleanPathRequest({
      destination: `127.0.0.1:${rdpPort}`,
      x224ConnectionPdu: buildX224RequestTpkt(),
    }), { binary: true });
    await respPromise;

    const echoPromise = new Promise((resolve) => {
      clientWs.once("message", (data) => resolve(Buffer.from(data)));
    });
    const payload = Buffer.alloc(1024, 0x41);
    clientWs.send(payload, { binary: true });
    await echoPromise;

    // Wait for periodic stats ticks + at least one live TCP RTT probe
    await new Promise((resolve) => setTimeout(resolve, 260));

    clientWs.close();
    await proxyPromise;

    const countAtClose = statsSamples.length;
    assert.ok(countAtClose >= 2, `Expected at least 2 RDP stats samples, got ${countAtClose}`);
    const last = statsSamples[statsSamples.length - 1];
    assert.equal(last.protocol, "rdp");
    assert.equal(typeof last.rttMs, "number");
    assert.ok(last.rttMs >= 0);
    assert.equal(last.totalTxBytes, 1024);
    assert.equal(last.totalRxBytes, 1028);
    assert.ok(statsSamples.some((s) => s.rxBps > 0 && s.txBps > 0));
    assert.ok(tcpConnections >= 2, `Expected live direct TCP RTT probe connection, got ${tcpConnections}`);

    // Verify no further stats arrive after disconnect (all timers cleaned up)
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(statsSamples.length, countAtClose);

    wss.close();
    httpServer.close();
    rdpServer.close();
  });

  it("uses passive turnaround RTT and skips direct TCP probes for tunneled RDP connections", async () => {
    const { key, cert } = generateSelfSignedCert();
    const x224Confirm = buildX224ConfirmTpkt(0x02);
    let tcpConnections = 0;

    const rdpServer = net.createServer((rawSocket) => {
      tcpConnections += 1;
      rawSocket.once("data", () => {
        rawSocket.write(x224Confirm);
        const tlsServerSock = new tls.TLSSocket(rawSocket, { isServer: true, key, cert });
        tlsServerSock.on("data", (chunk) => {
          setTimeout(() => {
            try { tlsServerSock.write(chunk); } catch { /* ignore */ }
          }, 20);
        });
        tlsServerSock.on("error", () => {});
      });
      rawSocket.on("error", () => {});
    });

    await new Promise((resolve) => rdpServer.listen(0, "127.0.0.1", resolve));
    const rdpPort = rdpServer.address().port;

    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const wsPort = httpServer.address().port;

    const statsSamples = [];
    let proxyPromise;
    wss.on("connection", (ws) => {
      proxyPromise = handleRdpCleanPathConnection({
        ws,
        host: "127.0.0.1",
        port: rdpPort,
        isDirectConnection: false,
        statsIntervalMs: 80,
        rttProbeIntervalMs: 100,
        dial: async () => {
          const sock = net.connect(rdpPort, "127.0.0.1");
          await new Promise((resolve, reject) => {
            sock.once("connect", resolve);
            sock.once("error", reject);
          });
          return { stream: sock, cleanup: () => sock.destroy() };
        },
        verifyCertificate: async () => ({ accepted: true }),
        onStats: (sample) => statsSamples.push(sample),
      });
    });

    const clientWs = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise((resolve) => clientWs.once("open", resolve));

    const respPromise = new Promise((resolve) => {
      clientWs.once("message", (data) => resolve(Buffer.from(data)));
    });
    clientWs.send(encodeRDCleanPathRequest({
      destination: `127.0.0.1:${rdpPort}`,
      x224ConnectionPdu: buildX224RequestTpkt(),
    }), { binary: true });
    await respPromise;

    const echoPromise = new Promise((resolve) => {
      clientWs.once("message", (data) => resolve(Buffer.from(data)));
    });
    clientWs.send(Buffer.from("tunneled-ping"), { binary: true });
    await echoPromise;
    await new Promise((resolve) => setTimeout(resolve, 220));

    clientWs.close();
    await proxyPromise;

    assert.equal(tcpConnections, 1, "Tunneled RDP session must never open direct TCP RTT probe sockets");
    assert.ok(statsSamples.length >= 2);
    const last = statsSamples[statsSamples.length - 1];
    assert.equal(typeof last.rttMs, "number");
    assert.ok(last.rttMs >= 0);

    wss.close();
    httpServer.close();
    rdpServer.close();
  });

  it("cleans up late-resolving upstream socket when aborted during dial and survives upstream close during TOFU", async () => {
    // Part 1: Abort during dial cleans up socket returned after abort
    let lateCleanupCalled = false;
    let resolveDial;
    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const wsPort = httpServer.address().port;

    const ac = new AbortController();
    let proxyPromise;
    wss.on("connection", (ws) => {
      proxyPromise = handleRdpCleanPathConnection({
        ws,
        host: "127.0.0.1",
        port: 3389,
        signal: ac.signal,
        dial: () => new Promise((resolve) => {
          resolveDial = resolve;
        }),
      });
    });

    const clientWs = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise((resolve) => clientWs.once("open", resolve));
    clientWs.send(encodeRDCleanPathRequest({
      destination: "127.0.0.1:3389",
      x224ConnectionPdu: buildX224RequestTpkt(),
    }), { binary: true });

    await new Promise((resolve) => setTimeout(resolve, 30));
    ac.abort();
    const fakeStream = new net.Socket();
    resolveDial({
      stream: fakeStream,
      cleanup: () => {
        lateCleanupCalled = true;
        fakeStream.destroy();
      },
    });
    await proxyPromise;
    assert.equal(lateCleanupCalled, true);
    assert.equal(fakeStream.destroyed, true);

    clientWs.close();
    wss.close();
    httpServer.close();
  });
});
