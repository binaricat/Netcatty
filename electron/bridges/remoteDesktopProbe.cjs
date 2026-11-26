"use strict";

/**
 * Zero-credential RDP & VNC reachability and protocol probe engine.
 *
 * Shared by:
 * - P1-B Host Connection Test (`remoteDesktopBridge.cjs` -> `netcatty:remote-desktop:test`)
 * - P2-A Monitoring Heartbeat (`monitorBridge.cjs` -> standalone & companion RDP/VNC probes)
 *
 * Security guarantee:
 * NEVER transmits usernames, domains, passwords, NTLM/CredSSP tokens, or RFB
 * authentication responses. Zero Windows NLA account-lockout risk.
 */

const net = require("node:net");
const { performance } = require("node:perf_hooks");
const {
  readTpktPacket,
  parseX224ConfirmNegotiation,
  upgradeToTls,
  extractPeerCertInfo,
  isBoringSslKeyUsageError,
} = require("./rdpCleanPathProxy.cjs");
const { createProxySocket } = require("./proxyUtils.cjs");
const { openBoundedForwardOutCallback } = require("./boundedSshChannelOpen.cjs");

const DEFAULT_TCP_TIMEOUT_MS = 8_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 8_000;
const DEFAULT_HEARTBEAT_TCP_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_BANNER_TIMEOUT_MS = 2_000;

const RDP_NEG_FAILURE_REASONS = Object.freeze({
  1: "SSL_REQUIRED_BY_SERVER: Server requires TLS/SSL security (use TLS or Auto mode)",
  2: "SSL_NOT_ALLOWED_BY_SERVER: Server does not allow TLS/SSL (try Standard RDP mode)",
  3: "SSL_CERT_NOT_ON_SERVER: Server has no TLS certificate configured",
  4: "INCONSISTENT_FLAGS: Inconsistent RDP negotiation flags",
  5: "HYBRID_REQUIRED_BY_SERVER: Server requires Network Level Authentication (NLA / CredSSP)",
  6: "SSL_WITH_USER_AUTH_REQUIRED_BY_SERVER: Server requires TLS with user authentication",
});

const RDP_PROTOCOL_MAP = Object.freeze({
  0: { id: "rdp", label: "Standard RDP" },
  1: { id: "tls", label: "TLS" },
  2: { id: "nla", label: "NLA / CredSSP" },
  4: { id: "rdstls", label: "RDSTLS" },
  8: { id: "nla-ext", label: "NLA / CredSSP Extended" },
});

const VNC_SECURITY_TYPE_NAMES = Object.freeze({
  1: "None",
  2: "VNCAuth",
  5: "RA2",
  6: "RA2ne",
  16: "Tight",
  18: "TLS",
  19: "VeNCrypt",
  20: "SASL",
  21: "MD5",
  22: "xvp",
  30: "Apple ARD",
  35: "Apple DH",
  113: "MSLogonII",
  129: "RA2-256",
  130: "RA2ne-256",
});

const VENCRYPT_SUBTYPE_NAMES = Object.freeze({
  256: "Plain",
  257: "TLSNone",
  258: "TLSVnc",
  259: "TLSPlain",
  260: "X509None",
  261: "X509Vnc",
  262: "X509Plain",
});

// Prefer X509None (260) before X509Vnc (261) / X509Plain (262); we destroy immediately after TLS handshake.
const VENCRYPT_X509_SUBTYPES = Object.freeze([260, 261, 262]);

function normalizeFingerprint(fingerprint) {
  if (typeof fingerprint !== "string") return "";
  const hex = fingerprint
    .trim()
    .replace(/^sha-?256:/i, "")
    .replace(/[^0-9a-fA-F]/g, "")
    .toUpperCase();
  if (!hex) return "";
  if (hex.length % 2 === 0) {
    const pairs = [];
    for (let i = 0; i < hex.length; i += 2) {
      pairs.push(hex.slice(i, i + 2));
    }
    return pairs.join(":");
  }
  return hex;
}

function classifyCertTrustStatus(fingerprintSha256, knownCertFingerprints) {
  const normalized = normalizeFingerprint(fingerprintSha256);
  const knownList = Array.isArray(knownCertFingerprints)
    ? knownCertFingerprints.map(normalizeFingerprint).filter(Boolean)
    : [];
  if (knownList.length === 0) return "first-seen";
  if (normalized && knownList.includes(normalized)) return "trusted";
  return "changed";
}

function formatRdpNegFailure(code) {
  return RDP_NEG_FAILURE_REASONS[code] || `RDP negotiation failed (code ${code})`;
}

/**
 * Build a TPKT v3 + X.224 Connection Request PDU (19 bytes without loadBalanceInfo).
 * Never contains credentials or user identity.
 */
function buildX224ConnectionRequest({ securityMode = "auto", loadBalanceInfo } = {}) {
  let requestedProtocols = 0x00000003; // PROTOCOL_SSL (1) | PROTOCOL_HYBRID (2)
  if (securityMode === "rdp") {
    requestedProtocols = 0x00000000;
  } else if (securityMode === "tls" || securityMode === "tls-legacy") {
    requestedProtocols = 0x00000001;
  } else if (securityMode === "nla" || securityMode === "auto") {
    requestedProtocols = 0x00000003;
  }

  let routingBuf = Buffer.alloc(0);
  if (typeof loadBalanceInfo === "string" && loadBalanceInfo.trim().length > 0) {
    const trimmed = loadBalanceInfo.replace(/\r?\n$/, "");
    routingBuf = Buffer.from(`${trimmed}\r\n`, "ascii");
  }

  const negReq = Buffer.alloc(8);
  negReq[0] = 0x01; // TYPE_RDP_NEG_REQ
  negReq[1] = 0x00; // flags
  negReq.writeUInt16LE(8, 2); // length = 8
  negReq.writeUInt32LE(requestedProtocols, 4);

  const x224LengthIndicator = 6 + routingBuf.length + negReq.length;
  const totalLen = 4 + 1 + x224LengthIndicator;

  const pdu = Buffer.alloc(totalLen);
  // TPKT header
  pdu[0] = 0x03; // version
  pdu[1] = 0x00; // reserved
  pdu.writeUInt16BE(totalLen, 2);
  // X.224 Connection Request fixed header
  pdu[4] = x224LengthIndicator;
  pdu[5] = 0xe0; // TPDU code = CR
  pdu.writeUInt16BE(0x0000, 6); // DST-REF
  pdu.writeUInt16BE(0x0000, 8); // SRC-REF
  pdu[10] = 0x00; // CLASS 0

  let offset = 11;
  if (routingBuf.length > 0) {
    routingBuf.copy(pdu, offset);
    offset += routingBuf.length;
  }
  negReq.copy(pdu, offset);
  return pdu;
}

/**
 * Buffered exact-byte reader over a Node stream/socket with AbortSignal + per-read timeout.
 */
function createBufferedSocketReader(socket, { signal } = {}) {
  let buffer = Buffer.alloc(0);
  let endedError = null;
  let pending = null;
  let detached = false;

  const rejectPending = (err) => {
    if (!pending) return;
    const p = pending;
    pending = null;
    if (p.timer) clearTimeout(p.timer);
    p.reject(err);
  };

  const tryFulfill = () => {
    if (!pending) return;
    if (buffer.length >= pending.count) {
      const p = pending;
      pending = null;
      if (p.timer) clearTimeout(p.timer);
      const slice = Buffer.from(buffer.subarray(0, p.count));
      buffer = buffer.subarray(p.count);
      p.resolve(slice);
    } else if (endedError) {
      rejectPending(endedError);
    }
  };

  const onData = (chunk) => {
    if (detached) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = buffer.length === 0 ? buf : Buffer.concat([buffer, buf]);
    tryFulfill();
  };

  const onError = (err) => {
    endedError = err || new Error("Socket error during protocol probe");
    rejectPending(endedError);
  };

  const onClose = () => {
    if (!endedError) endedError = new Error("Connection closed during protocol probe");
    rejectPending(endedError);
  };

  const onEnd = () => {
    if (!endedError) endedError = new Error("Connection ended during protocol probe");
    rejectPending(endedError);
  };

  const onAbort = () => {
    const err = new Error("Connection probe cancelled");
    err.code = "ABORT_ERR";
    endedError = err;
    rejectPending(err);
    try { socket.destroy?.(); } catch { /* ignore */ }
  };

  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);
  socket.on("end", onEnd);
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  function readExact(count, timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS) {
    if (count === 0) return Promise.resolve(Buffer.alloc(0));
    if (buffer.length >= count) {
      const slice = Buffer.from(buffer.subarray(0, count));
      buffer = buffer.subarray(count);
      return Promise.resolve(slice);
    }
    if (endedError) return Promise.reject(endedError);
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (pending && pending.reject === reject) {
            pending = null;
          }
          const err = new Error(`Timed out waiting for protocol response (${timeoutMs}ms)`);
          err.code = "ETIMEDOUT";
          reject(err);
        }, timeoutMs);
        timer.unref?.();
      }
      pending = { count, resolve, reject, timer };
      socket.resume?.();
    });
  }

  function detach() {
    if (detached) return;
    detached = true;
    socket.removeListener("data", onData);
    socket.removeListener("error", onError);
    socket.removeListener("close", onClose);
    socket.removeListener("end", onEnd);
    signal?.removeEventListener?.("abort", onAbort);
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending = null;
    }
    if (buffer.length > 0 && typeof socket.unshift === "function") {
      socket.pause?.();
      socket.unshift(Buffer.from(buffer));
      buffer = Buffer.alloc(0);
    }
  }

  return { readExact, detach };
}

function makeAbortError() {
  const err = new Error("Connection probe cancelled");
  err.code = "ABORT_ERR";
  return err;
}

/**
 * Probe an already-connected RDP stream using X.224 Connection Request + optional TLS cert read.
 */
async function probeRdpStream(stream, options = {}) {
  const {
    host = "",
    securityMode = "auto",
    loadBalanceInfo,
    allowLegacyTls = false,
    knownCertFingerprints,
    inspectTls = true,
    timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    signal,
    onPhase,
  } = options;

  if (signal?.aborted) throw makeAbortError();

  const onAbort = () => {
    try { stream.destroy?.(); } catch { /* ignore */ }
  };
  signal?.addEventListener?.("abort", onAbort, { once: true });

  let tlsSocket = null;
  try {
    const reqPdu = buildX224ConnectionRequest({ securityMode, loadBalanceInfo });
    stream.write(reqPdu);

    const confirmBuf = await readTpktPacket(stream, timeoutMs);
    if (signal?.aborted) throw makeAbortError();

    const negotiation = parseX224ConfirmNegotiation(confirmBuf);
    if (!negotiation.isConfirm) {
      throw new Error("Unexpected response: server did not return an X.224 Connection Confirm");
    }

    if (negotiation.failureCode !== null) {
      const err = new Error(formatRdpNegFailure(negotiation.failureCode));
      err.rdpFailureCode = negotiation.failureCode;
      err.bannerVerified = true;
      throw err;
    }

    const mapped = RDP_PROTOCOL_MAP[negotiation.selectedProtocol] || {
      id: negotiation.requiresTls ? "tls" : "rdp",
      label: negotiation.requiresTls ? "TLS" : "Standard RDP",
    };
    const rdpSecurity = mapped.id;
    const bannerDetail = `RDP (${mapped.label})`;
    onPhase?.("x224-negotiated", { rdpSecurity, bannerDetail });

    let tlsVersion;
    let tlsCipher;
    let cert;

    if (negotiation.requiresTls && inspectTls) {
      onPhase?.("tls-handshake");
      tlsSocket = await upgradeToTls(stream, {
        host,
        allowLegacyTls: allowLegacyTls === true || securityMode === "tls-legacy",
        preferRsaKeyExchange: options.preferRsaKeyExchange === true,
        timeoutMs,
      });
      if (signal?.aborted) throw makeAbortError();

      tlsVersion = typeof tlsSocket.getProtocol === "function"
        ? (tlsSocket.getProtocol() || undefined)
        : undefined;
      const cipherObj = typeof tlsSocket.getCipher === "function" ? tlsSocket.getCipher() : null;
      tlsCipher = cipherObj?.name || undefined;

      const peerCert = extractPeerCertInfo(tlsSocket);
      if (peerCert && peerCert.fingerprintSha256) {
        cert = {
          fingerprintSha256: peerCert.fingerprintSha256,
          ...(peerCert.subject ? { subject: peerCert.subject } : {}),
          ...(peerCert.issuer ? { issuer: peerCert.issuer } : {}),
          ...(peerCert.validFrom ? { validFrom: peerCert.validFrom } : {}),
          ...(peerCert.validTo ? { validTo: peerCert.validTo } : {}),
          trustStatus: classifyCertTrustStatus(peerCert.fingerprintSha256, knownCertFingerprints),
        };
      }
      try { tlsSocket.destroy(); } catch { /* ignore */ }
      tlsSocket = null;
    }

    return {
      bannerVerified: true,
      bannerDetail,
      rdpSecurity,
      ...(tlsVersion ? { tlsVersion } : {}),
      ...(tlsCipher ? { tlsCipher } : {}),
      ...(cert ? { cert } : {}),
    };
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
    try { tlsSocket?.destroy?.(); } catch { /* ignore */ }
  }
}

/**
 * Probe an already-connected VNC stream: 12-byte RFB banner, offered security types,
 * and optional VeNCrypt 0.2 subtype + X.509 certificate inspection.
 * Never sends passwords, usernames, or RFB auth responses.
 */
async function probeVncStream(stream, options = {}) {
  const {
    host = "",
    knownCertFingerprints,
    inspectSecurity = true,
    inspectVencrypt = true,
    timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    signal,
    onPhase,
  } = options;

  if (signal?.aborted) throw makeAbortError();

  const reader = createBufferedSocketReader(stream, { signal });
  let tlsSocket = null;
  try {
    const bannerBuf = await reader.readExact(12, timeoutMs);
    const bannerStr = bannerBuf.toString("ascii");
    const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(bannerStr);
    if (!match) {
      throw new Error("Invalid VNC/RFB protocol banner");
    }

    const major = Number.parseInt(match[1], 10);
    const minor = Number.parseInt(match[2], 10);
    const rfbVersion = `RFB ${match[1]}.${match[2]}`;
    const bannerDetail = `RFB ${major}.${minor}`;
    onPhase?.("rfb-banner", { rfbVersion, bannerDetail });

    if (!inspectSecurity) {
      return {
        bannerVerified: true,
        bannerDetail,
        rfbVersion,
      };
    }

    // Echo negotiated client RFB version (never higher than 3.8).
    let clientBanner = "RFB 003.008\n";
    let negotiatedMinor = 8;
    if (major < 3 || (major === 3 && minor < 7)) {
      clientBanner = "RFB 003.003\n";
      negotiatedMinor = 3;
    } else if (major === 3 && minor === 7) {
      clientBanner = "RFB 003.007\n";
      negotiatedMinor = 7;
    }
    stream.write(Buffer.from(clientBanner, "ascii"));

    const vncSecurityTypes = [];
    if (negotiatedMinor >= 7) {
      const countBuf = await reader.readExact(1, timeoutMs);
      const count = countBuf[0];
      if (count === 0) {
        let reason = "Server rejected connection";
        try {
          const lenBuf = await reader.readExact(4, Math.min(timeoutMs, 2000));
          const reasonLen = Math.min(4096, lenBuf.readUInt32BE(0));
          if (reasonLen > 0) {
            const reasonBuf = await reader.readExact(reasonLen, Math.min(timeoutMs, 2000));
            const text = reasonBuf.toString("utf8").trim();
            if (text) reason = text;
          }
        } catch {
          // keep default rejection reason
        }
        const err = new Error(reason);
        err.bannerVerified = true;
        err.rfbVersion = rfbVersion;
        throw err;
      }
      const typesBuf = await reader.readExact(count, timeoutMs);
      for (let i = 0; i < typesBuf.length; i += 1) {
        const id = typesBuf[i];
        vncSecurityTypes.push({
          id,
          name: VNC_SECURITY_TYPE_NAMES[id] || `Type ${id}`,
        });
      }
    } else {
      // RFB 3.3: server sends a single u32be security type
      const typeBuf = await reader.readExact(4, timeoutMs);
      const secType = typeBuf.readUInt32BE(0);
      if (secType === 0) {
        let reason = "Server rejected connection";
        try {
          const lenBuf = await reader.readExact(4, Math.min(timeoutMs, 2000));
          const reasonLen = Math.min(4096, lenBuf.readUInt32BE(0));
          if (reasonLen > 0) {
            const reasonBuf = await reader.readExact(reasonLen, Math.min(timeoutMs, 2000));
            const text = reasonBuf.toString("utf8").trim();
            if (text) reason = text;
          }
        } catch {
          // keep default rejection reason
        }
        const err = new Error(reason);
        err.bannerVerified = true;
        err.rfbVersion = rfbVersion;
        throw err;
      }
      vncSecurityTypes.push({
        id: secType,
        name: VNC_SECURITY_TYPE_NAMES[secType] || `Type ${secType}`,
      });
    }

    onPhase?.("rfb-security", { vncSecurityTypes });

    let tlsVersion;
    let tlsCipher;
    let cert;

    // Optional VeNCrypt 0.2 subtype + X.509 cert inspection.
    if (
      inspectVencrypt
      && negotiatedMinor >= 7
      && vncSecurityTypes.some((entry) => entry.id === 19)
    ) {
      const subTimeoutMs = Math.min(timeoutMs, 4_000);
      try {
        stream.write(Buffer.from([19]));
        const verBuf = await reader.readExact(2, subTimeoutMs);
        const vMajor = verBuf[0];
        const vMinor = verBuf[1];
        if (vMajor === 0 && vMinor >= 2) {
          stream.write(Buffer.from([0, 2]));
          const statusBuf = await reader.readExact(1, subTimeoutMs);
          if (statusBuf[0] === 0) {
            const subCountBuf = await reader.readExact(1, subTimeoutMs);
            const subCount = subCountBuf[0];
            if (subCount > 0 && subCount <= 64) {
              const rawSubtypes = await reader.readExact(subCount * 4, subTimeoutMs);
              const subtypeIds = [];
              for (let i = 0; i < subCount; i += 1) {
                const subId = rawSubtypes.readUInt32BE(i * 4);
                subtypeIds.push(subId);
                const subLabel = VENCRYPT_SUBTYPE_NAMES[subId];
                vncSecurityTypes.push({
                  id: subId,
                  name: subLabel ? `VeNCrypt:${subLabel}` : `VeNCrypt:${subId}`,
                });
              }

              const chosenX509 = VENCRYPT_X509_SUBTYPES.find((id) => subtypeIds.includes(id));
              if (chosenX509 !== undefined) {
                const selectBuf = Buffer.alloc(4);
                selectBuf.writeUInt32BE(chosenX509, 0);
                stream.write(selectBuf);
                const ackBuf = await reader.readExact(1, subTimeoutMs);
                if (ackBuf[0] === 1) {
                  reader.detach();
                  onPhase?.("tls-handshake");
                  tlsSocket = await upgradeToTls(stream, {
                    host,
                    allowLegacyTls: false,
                    timeoutMs: subTimeoutMs,
                  });
                  if (!signal?.aborted) {
                    tlsVersion = typeof tlsSocket.getProtocol === "function"
                      ? (tlsSocket.getProtocol() || undefined)
                      : undefined;
                    const cipherObj = typeof tlsSocket.getCipher === "function" ? tlsSocket.getCipher() : null;
                    tlsCipher = cipherObj?.name || undefined;
                    const peerCert = extractPeerCertInfo(tlsSocket);
                    if (peerCert && peerCert.fingerprintSha256) {
                      cert = {
                        fingerprintSha256: peerCert.fingerprintSha256,
                        ...(peerCert.subject ? { subject: peerCert.subject } : {}),
                        ...(peerCert.issuer ? { issuer: peerCert.issuer } : {}),
                        ...(peerCert.validFrom ? { validFrom: peerCert.validFrom } : {}),
                        ...(peerCert.validTo ? { validTo: peerCert.validTo } : {}),
                        trustStatus: classifyCertTrustStatus(peerCert.fingerprintSha256, knownCertFingerprints),
                      };
                    }
                  }
                  try { tlsSocket.destroy(); } catch { /* ignore */ }
                  tlsSocket = null;
                }
              }
            }
          }
        }
      } catch {
        // Fall back cleanly to top-level RFB security types if VeNCrypt subtype probe fails or closes.
      }
    }

    return {
      bannerVerified: true,
      bannerDetail,
      rfbVersion,
      vncSecurityTypes,
      ...(tlsVersion ? { tlsVersion } : {}),
      ...(tlsCipher ? { tlsCipher } : {}),
      ...(cert ? { cert } : {}),
    };
  } finally {
    reader.detach();
    try { tlsSocket?.destroy?.(); } catch { /* ignore */ }
  }
}

function dialDirectTcp(host, port, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    let settled = false;
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);
    let timer = null;

    const cleanupListeners = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      signal?.removeEventListener?.("abort", onAbort);
    };

    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      resolve({
        stream: socket,
        cleanup: () => {
          try { socket.destroy(); } catch { /* ignore */ }
        },
      });
    };

    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      try { socket.destroy(); } catch { /* ignore */ }
      reject(err);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      try { socket.destroy(); } catch { /* ignore */ }
      reject(makeAbortError());
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        try { socket.destroy(); } catch { /* ignore */ }
        const err = new Error(`Connection timed out to ${host}:${port}`);
        err.code = "ETIMEDOUT";
        reject(err);
      }, timeoutMs);
      timer.unref?.();
    }

    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function openForwardOutWithTimeout(conn, targetHost, targetPort, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    let settled = false;
    const ac = new AbortController();
    const onExternalAbort = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { ac.abort(makeAbortError()); } catch { /* ignore */ }
      reject(makeAbortError());
    };
    signal?.addEventListener?.("abort", onExternalAbort, { once: true });

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener?.("abort", onExternalAbort);
          const err = new Error(`SSH forwardOut timed out to ${targetHost}:${targetPort}`);
          err.code = "ETIMEDOUT";
          try { ac.abort(err); } catch { /* ignore */ }
          reject(err);
        }, timeoutMs)
      : null;
    timer?.unref?.();

    openBoundedForwardOutCallback(
      conn,
      "127.0.0.1",
      0,
      targetHost,
      targetPort,
      (err, stream) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener?.("abort", onExternalAbort);
        if (settled) {
          try { stream?.destroy?.(); } catch { /* ignore */ }
          return;
        }
        settled = true;
        if (err) {
          reject(err);
          return;
        }
        resolve({
          stream,
          cleanup: () => {
            try { stream.destroy?.(); } catch { /* ignore */ }
          },
        });
      },
      { signal: ac.signal },
    );
  });
}

/**
 * Dial a heartbeat probe stream for P2-A monitoring.
 * - Companion SSH: reuses the provided already-connected SSH `sshConn` via `forwardOut`.
 * - Jump chain: only reuses an active pooled SSH transport (never pops a modal).
 * - Proxy: uses `createProxySocket`.
 * - Direct: `net.connect`.
 */
async function dialMonitorProbeStream(options, { sshConn, signal, sshPool, proxyDialer = createProxySocket } = {}) {
  const protocol = String(options.protocol || "").toLowerCase();
  const port = Number(options.port) || (protocol === "rdp" ? 3389 : 5900);
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_HEARTBEAT_TCP_TIMEOUT_MS;

  if (sshConn && options.tunnelViaHostSsh !== false) {
    const targetHost = options.tunnelTargetHost || "127.0.0.1";
    return openForwardOutWithTimeout(sshConn, targetHost, port, timeoutMs, signal);
  }

  const host = String(options.hostname || options.host || "").trim();
  if (!host) {
    throw new Error("Remote desktop hostname is required");
  }

  if (Array.isArray(options.jumpHosts) && options.jumpHosts.length > 0) {
    const pool = sshPool || require("./sshConnectionPool.cjs");
    const lastJump = options.jumpHosts[options.jumpHosts.length - 1];
    const priorJumps = options.jumpHosts.slice(0, -1);
    const endpoint = pool.buildConnectionReuseEndpoint({
      hostname: lastJump.hostname,
      port: lastJump.port || 22,
      username: lastJump.username,
      authMethod: lastJump.authMethod,
      keyId: lastJump.keyId,
      identityId: lastJump.identityId,
      proxy: lastJump.proxy || options.proxy,
      jumpHosts: priorJumps,
      agentForwarding: false,
      protocol: "ssh",
      sftpSudo: false,
    }, { sftpSudo: false });
    const existing = pool.findTransportByEndpoint(endpoint);
    if (!existing || !existing.conn || existing.state === "dead" || existing.state === "closing") {
      const err = new Error("SSH jump host requires an active session");
      err.requiresLogin = true;
      throw err;
    }
    const holder = {};
    pool.borrowTransport(existing, {
      kind: pool.LEASE_KINDS.monitor,
      holder,
      meta: { source: "monitor-probe" },
    });
    try {
      const forwarded = await openForwardOutWithTimeout(existing.conn, host, port, timeoutMs, signal);
      let released = false;
      const cleanup = () => {
        if (released) return;
        released = true;
        forwarded.cleanup();
        try { pool.returnTransport(holder); } catch { /* ignore */ }
      };
      return { stream: forwarded.stream, cleanup };
    } catch (err) {
      try { pool.returnTransport(holder); } catch { /* ignore */ }
      throw err;
    }
  }

  if (options.proxy && options.proxy.type) {
    const sock = await proxyDialer(options.proxy, host, port, { timeoutMs });
    if (signal?.aborted) {
      try { sock.destroy(); } catch { /* ignore */ }
      throw makeAbortError();
    }
    return {
      stream: sock,
      cleanup: () => {
        try { sock.destroy(); } catch { /* ignore */ }
      },
    };
  }

  return dialDirectTcp(host, port, timeoutMs, signal);
}

/**
 * Full zero-credential RDP/VNC probe (P1-B connection test or P2-A heartbeat monitor).
 */
async function probeRemoteDesktop(options = {}, deps = {}) {
  const protocol = String(options.protocol || "").toLowerCase();
  const host = String(options.hostname || options.host || "").trim();
  const port = Number(options.port) || (protocol === "rdp" ? 3389 : 5900);
  const mode = options.mode === "heartbeat" ? "heartbeat" : "full";
  const tcpTimeoutMs = Number(options.connectTimeoutMs || options.timeoutMs)
    || (mode === "heartbeat" ? DEFAULT_HEARTBEAT_TCP_TIMEOUT_MS : DEFAULT_TCP_TIMEOUT_MS);
  const handshakeTimeoutMs = Number(options.handshakeTimeoutMs)
    || (mode === "heartbeat" ? DEFAULT_HEARTBEAT_BANNER_TIMEOUT_MS : DEFAULT_HANDSHAKE_TIMEOUT_MS);
  const signal = deps.signal;
  const onPhase = deps.onPhase;
  const now = deps.now || Date.now;
  const clock = deps.clock || (() => performance.now());

  if (protocol !== "rdp" && protocol !== "vnc") {
    return {
      ok: false,
      reachable: false,
      protocol: protocol === "rdp" ? "rdp" : "vnc",
      host,
      port,
      rttMs: null,
      error: `Unsupported remote desktop protocol: ${options.protocol}`,
      checkedAt: now(),
    };
  }

  if (!host && !(deps.sshConn && options.tunnelViaHostSsh !== false)) {
    return {
      ok: false,
      reachable: false,
      protocol,
      host,
      port,
      rttMs: null,
      error: "Remote desktop hostname is required",
      checkedAt: now(),
    };
  }

  let upstream = null;
  let rttMs = null;

  try {
    if (signal?.aborted) throw makeAbortError();
    onPhase?.("resolving");

    const dialUpstream = async () => {
      if (typeof deps.dial === "function") {
        return deps.dial();
      }
      if (mode === "heartbeat") {
        return dialMonitorProbeStream(
          { ...options, protocol, hostname: host, port, timeoutMs: tcpTimeoutMs },
          { sshConn: deps.sshConn, signal, sshPool: deps.sshPool, proxyDialer: deps.proxyDialer },
        );
      }
      const { defaultDialRemoteDesktop } = require("./remoteDesktopBridge.cjs");
      // Strip any RDP/VNC credentials before passing to dialer; only SSH tunnel/jump creds survive.
      const sanitizedConfig = {
        ...options,
        protocol,
        hostname: host,
        port,
        connectTimeoutMs: tcpTimeoutMs,
        username: undefined,
        password: undefined,
        domain: undefined,
      };
      return defaultDialRemoteDesktop(deps.event, sanitizedConfig, options.sessionId || `probe-${now()}`);
    };

    const dialStart = clock();
    upstream = await dialUpstream();

    rttMs = Math.max(0, Math.round(clock() - dialStart));
    if (signal?.aborted) throw makeAbortError();
    onPhase?.("tcp-connected", { rttMs });

    const bannerCheck = options.bannerCheck !== false;
    if (!bannerCheck) {
      onPhase?.("probe-complete", { rttMs });
      return {
        ok: true,
        reachable: true,
        protocol,
        host,
        port,
        rttMs,
        bannerVerified: false,
        checkedAt: now(),
      };
    }

    try {
      const rdpHost = options.tunnelViaHostSsh && options.sshTunnelConfig?.hostname
        ? options.sshTunnelConfig.hostname
        : host;
      let handshake;
      if (protocol === "rdp") {
        try {
          handshake = await probeRdpStream(upstream.stream, {
            host: rdpHost,
            securityMode: options.securityMode || "auto",
            loadBalanceInfo: options.loadBalanceInfo,
            allowLegacyTls: options.allowLegacyTls === true,
            knownCertFingerprints: options.knownCertFingerprints,
            inspectTls: mode === "full",
            timeoutMs: handshakeTimeoutMs,
            signal,
            onPhase,
          });
        } catch (rdpErr) {
          if (isBoringSslKeyUsageError(rdpErr) && !signal?.aborted) {
            try { upstream.stream?.destroy?.(); } catch { /* ignore */ }
            try { upstream.cleanup?.(); } catch { /* ignore */ }
            upstream = await dialUpstream();
            handshake = await probeRdpStream(upstream.stream, {
              host: rdpHost,
              securityMode: options.securityMode || "auto",
              loadBalanceInfo: options.loadBalanceInfo,
              allowLegacyTls: options.allowLegacyTls === true,
              preferRsaKeyExchange: true,
              knownCertFingerprints: options.knownCertFingerprints,
              inspectTls: mode === "full",
              timeoutMs: handshakeTimeoutMs,
              signal,
              onPhase,
            });
          } else {
            throw rdpErr;
          }
        }
      } else {
        handshake = await probeVncStream(upstream.stream, {
          host: rdpHost,
          knownCertFingerprints: options.knownCertFingerprints,
          inspectSecurity: mode === "full",
          inspectVencrypt: mode === "full",
          timeoutMs: handshakeTimeoutMs,
          signal,
          onPhase,
        });
      }

      onPhase?.("probe-complete", { rttMs, ...handshake });
      return {
        ok: true,
        reachable: true,
        protocol,
        host,
        port,
        rttMs,
        ...handshake,
        checkedAt: now(),
      };
    } catch (bannerErr) {
      if (signal?.aborted || bannerErr?.code === "ABORT_ERR") {
        throw bannerErr;
      }
      // In heartbeat monitoring mode, TCP connect succeeded even if banner timed out or mismatched.
      // Report Online (`ok: true, reachable: true`) with `bannerVerified: false` so tooltip can warn.
      if (mode === "heartbeat") {
        return {
          ok: true,
          reachable: true,
          protocol,
          host,
          port,
          rttMs,
          bannerVerified: false,
          error: bannerErr?.message || String(bannerErr),
          checkedAt: now(),
        };
      }
      throw bannerErr;
    }
  } catch (err) {
    const message = err?.message || String(err);
    return {
      ok: false,
      reachable: false,
      protocol,
      host,
      port,
      rttMs,
      ...(err?.bannerVerified ? { bannerVerified: true } : {}),
      ...(err?.rfbVersion ? { rfbVersion: err.rfbVersion } : {}),
      ...(err?.requiresLogin ? { requiresLogin: true } : {}),
      error: message,
      checkedAt: now(),
    };
  } finally {
    try { upstream?.stream?.destroy?.(); } catch { /* ignore */ }
    try { upstream?.cleanup?.(); } catch { /* ignore */ }
  }
}

module.exports = {
  RDP_NEG_FAILURE_REASONS,
  RDP_PROTOCOL_MAP,
  VNC_SECURITY_TYPE_NAMES,
  VENCRYPT_SUBTYPE_NAMES,
  normalizeFingerprint,
  classifyCertTrustStatus,
  formatRdpNegFailure,
  buildX224ConnectionRequest,
  probeRdpStream,
  probeVncStream,
  dialMonitorProbeStream,
  probeRemoteDesktop,
};
