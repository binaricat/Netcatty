"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  computeCertSha256Fingerprint,
  extractPeerCertInfo,
  handleRdpCleanPathConnection,
  probeTcpConnectRtt,
} = require("./rdpCleanPathProxy.cjs");
const { registerRdpdrHandlers } = require("./remoteDesktopRdpdrBridge.cjs");
const { createProxySocket } = require("./proxyUtils.cjs");
const { safeSend } = require("./ipcUtils.cjs");
const { openBoundedForwardOutCallback } = require("./boundedSshChannelOpen.cjs");
const { probeRemoteDesktop } = require("./remoteDesktopProbe.cjs");

// ── VNC Binary WebSocket Protocol Opcodes ──
// Server -> Client
const VNC_S2C = Object.freeze({
  READY: 0x01,        // [0x01][json utf8: { width, height, name, securityType, securityName, supports }]
  RAW_RGBA: 0x02,     // [0x02][x:u16be][y:u16be][w:u16be][h:u16be][rgba bytes: w*h*4]
  COPY_RECT: 0x03,    // [0x03][x:u16be][y:u16be][w:u16be][h:u16be][srcX:u16be][srcY:u16be]
  JPEG: 0x04,         // [0x04][x:u16be][y:u16be][w:u16be][h:u16be][raw jpeg bytes]
  CURSOR: 0x05,       // [0x05][hotX:u16be][hotY:u16be][w:u16be][h:u16be][rgba bytes: w*h*4]
  DESKTOP_SIZE: 0x06, // [0x06][width:u16be][height:u16be]
  CLIPBOARD: 0x07,    // [0x07][utf8 bytes]
  BELL: 0x08,         // [0x08]
  DESKTOP_NAME: 0x09, // [0x09][utf8 bytes]
  ERROR: 0x0a,        // [0x0a][json utf8: { code, message }]
  FRAME_SYNC: 0x0b,   // [0x0b]
  CAPABILITIES: 0x0c, // [0x0c][json utf8: { supports }]
});

// Client -> Server (binary frames; JSON text frames also accepted)
const VNC_C2S = Object.freeze({
  POINTER: 0x10,       // [0x10][x:u16be][y:u16be][buttons:u8]
  KEY: 0x11,           // [0x11][keysym:u32be][down:u8]
  QEMU_KEY: 0x12,      // [0x12][keysym:u32be][keycode:u32be][down:u8]
  RESIZE: 0x13,        // [0x13][width:u16be][height:u16be]
  CLIPBOARD: 0x14,     // [0x14][utf8 bytes]
  REFRESH: 0x15,       // [0x15][incremental:u8]
  PAUSE: 0x16,         // [0x16][paused:u8]
  SET_ENCODINGS: 0x17, // [0x17][utf8 qualityPreset]
  SET_READ_ONLY: 0x18, // [0x18][readOnly:u8]
  XVP: 0x19,           // [0x19][utf8 action: shutdown|reboot|reset]
});

const TOKEN_TTL_MS = 60_000;
const CERT_DECISION_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const CERT_UNTRUSTED_ABORT_CODE = "NETCATTY_VNC_CERT_UNTRUSTED";

// ── Origin & Token Security Helpers ──

function isAllowedLoopbackOrigin(origin, options = {}) {
  if (typeof origin !== "string" || !origin.trim()) return false;
  const trimmed = origin.trim();
  if (trimmed === "app://netcatty") return true;
  if (Array.isArray(options.extraAllowedOrigins) && options.extraAllowedOrigins.includes(trimmed)) {
    return true;
  }
  const allowDev = options.allowDevOrigins !== false;
  if (!allowDev) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return false;
    return parsed.hostname === "localhost"
      || parsed.hostname === "127.0.0.1"
      || parsed.hostname === "[::1]"
      || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

function timingSafeTokenEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── VNC Binary Frame Encoders ──

function encodeVncJsonFrame(opcode, obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const frame = Buffer.allocUnsafe(1 + payload.length);
  frame[0] = opcode;
  payload.copy(frame, 1);
  return frame;
}

function encodeVncRawRgbaFrame(x, y, width, height, rgba) {
  const frame = Buffer.allocUnsafe(9 + rgba.length);
  frame[0] = VNC_S2C.RAW_RGBA;
  frame.writeUInt16BE(x & 0xffff, 1);
  frame.writeUInt16BE(y & 0xffff, 3);
  frame.writeUInt16BE(width & 0xffff, 5);
  frame.writeUInt16BE(height & 0xffff, 7);
  rgba.copy(frame, 9);
  return frame;
}

function encodeVncCopyRectFrame(x, y, width, height, srcX, srcY) {
  const frame = Buffer.allocUnsafe(13);
  frame[0] = VNC_S2C.COPY_RECT;
  frame.writeUInt16BE(x & 0xffff, 1);
  frame.writeUInt16BE(y & 0xffff, 3);
  frame.writeUInt16BE(width & 0xffff, 5);
  frame.writeUInt16BE(height & 0xffff, 7);
  frame.writeUInt16BE(srcX & 0xffff, 9);
  frame.writeUInt16BE(srcY & 0xffff, 11);
  return frame;
}

function encodeVncJpegFrame(x, y, width, height, jpeg) {
  const frame = Buffer.allocUnsafe(9 + jpeg.length);
  frame[0] = VNC_S2C.JPEG;
  frame.writeUInt16BE(x & 0xffff, 1);
  frame.writeUInt16BE(y & 0xffff, 3);
  frame.writeUInt16BE(width & 0xffff, 5);
  frame.writeUInt16BE(height & 0xffff, 7);
  jpeg.copy(frame, 9);
  return frame;
}

function encodeVncCursorFrame(hotspotX, hotspotY, width, height, rgba) {
  const pixels = rgba && rgba.length > 0 ? rgba : Buffer.alloc(0);
  const frame = Buffer.allocUnsafe(9 + pixels.length);
  frame[0] = VNC_S2C.CURSOR;
  frame.writeUInt16BE(hotspotX & 0xffff, 1);
  frame.writeUInt16BE(hotspotY & 0xffff, 3);
  frame.writeUInt16BE(width & 0xffff, 5);
  frame.writeUInt16BE(height & 0xffff, 7);
  if (pixels.length > 0) pixels.copy(frame, 9);
  return frame;
}

function encodeVncDesktopSizeFrame(width, height) {
  const frame = Buffer.allocUnsafe(5);
  frame[0] = VNC_S2C.DESKTOP_SIZE;
  frame.writeUInt16BE(width & 0xffff, 1);
  frame.writeUInt16BE(height & 0xffff, 3);
  return frame;
}

function encodeVncTextFrame(opcode, text) {
  const utf8 = Buffer.from(String(text || ""), "utf8");
  const frame = Buffer.allocUnsafe(1 + utf8.length);
  frame[0] = opcode;
  utf8.copy(frame, 1);
  return frame;
}

let cachedSupportsAnonymousDhTls = null;
function supportsAnonymousDhTls() {
  if (cachedSupportsAnonymousDhTls !== null) return cachedSupportsAnonymousDhTls;
  try {
    const tls = require("node:tls");
    tls.createSecureContext({
      ciphers: "aNULL:!eNULL@SECLEVEL=0",
      maxVersion: "TLSv1.2",
    });
    cachedSupportsAnonymousDhTls = true;
  } catch {
    // Electron links BoringSSL which rejects OpenSSL @SECLEVEL=0 and anonymous aNULL suites.
    cachedSupportsAnonymousDhTls = false;
  }
  return cachedSupportsAnonymousDhTls;
}

function buildPreferredVncSecurity(rfb2, hasUsername, opts = {}) {
  const defaults = typeof rfb2.defaultSecurity === "function" ? rfb2.defaultSecurity(hasUsername) : [];
  if (!Array.isArray(defaults) || defaults.length <= 1) return defaults;
  // Prefer X509/RA2/ARD encrypted types ahead of plaintext VNC (2) and None (1).
  // Filter out anonymous-DH VeNCrypt subtypes (TLSNone=257, TLSVnc=258, TLSPlain=259)
  // when the runtime TLS stack (e.g. Electron's BoringSSL) cannot negotiate aNULL@SECLEVEL=0,
  // preventing OPENSSL_internal:INVALID_COMMAND handshake failures on TigerVNC.
  const S = rfb2.security || {};
  const allowAnonDh = typeof opts.allowAnonymousDh === "boolean"
    ? opts.allowAnonymousDh
    : supportsAnonymousDhTls();
  const anonDhTypes = new Set([
    S.TLSNone ?? 257,
    S.TLSVnc ?? 258,
    S.TLSPlain ?? 259,
  ]);
  const plaintext = new Set([S.None ?? S.none ?? 1, S.VNC ?? S.vnc ?? 2, S.Plain ?? 256]);
  const encrypted = [];
  const plain = [];
  for (const entry of defaults) {
    if (!allowAnonDh && anonDhTypes.has(entry)) continue;
    if (plaintext.has(entry)) plain.push(entry);
    else encrypted.push(entry);
  }
  return [...encrypted, ...plain];
}

function buildVncEncodings(rfb2, qualityPreset, customOpts = {}) {
  const E = rfb2.encodings;
  const list = [
    E.tight,
    E.tightPng,
    E.zrle,
    E.trle,
    E.copyRect,
    E.hextile,
    E.zlib,
    E.raw,
    E.pseudoDesktopSize,
    E.pseudoExtendedDesktopSize,
    E.pseudoDesktopName,
    E.pseudoCursor,
    E.pseudoCursorWithAlpha,
    E.pseudoXCursor,
    E.pseudoVMwareCursor,
    E.pseudoExtendedClipboard,
    E.pseudoQemuExtendedKeyEvent,
    E.pseudoContinuousUpdates,
    E.pseudoFence,
    E.pseudoXvp,
    E.pseudoLastRect,
  ];
  // Map quality preset (or saved host numeric quality/compressionLevel) to Tight pseudo-encodings
  if (qualityPreset === "low") {
    list.push(rfb2.jpegQuality(3), rfb2.compressionLevel(7));
  } else if (qualityPreset === "medium") {
    list.push(rfb2.jpegQuality(6), rfb2.compressionLevel(5));
  } else if (qualityPreset === "lossless") {
    list.push(rfb2.compressionLevel(6));
  } else if (qualityPreset === "high") {
    list.push(rfb2.jpegQuality(9), rfb2.compressionLevel(2));
  } else {
    const q = Number.isInteger(customOpts?.jpegQuality)
      ? Math.max(0, Math.min(9, customOpts.jpegQuality))
      : 8;
    const c = Number.isInteger(customOpts?.compressionLevel)
      ? Math.max(0, Math.min(9, customOpts.compressionLevel))
      : 3;
    list.push(rfb2.jpegQuality(q), rfb2.compressionLevel(c));
  }
  return list.filter((entry) => typeof entry === "number");
}

function dispatchVncClientMessage(
  client,
  data,
  isBinary,
  { readOnly = false, setReadOnly, rfb2Module, onSetEncodings } = {},
) {
  if (!client || client.closed) return;

  const applyEncodings = (preset) => {
    if (typeof onSetEncodings === "function") {
      onSetEncodings(preset);
      return;
    }
    if (rfb2Module && typeof client.setEncodings === "function") {
      try {
        client.setEncodings(buildVncEncodings(rfb2Module, preset));
      } catch {
        // ignore unsupported encoding updates
      }
    }
  };

  if (!isBinary) {
    let msg;
    try {
      msg = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "pointer":
        if (readOnly) return;
        client.pointerEvent(
          Math.max(0, Math.min(65535, Math.round(Number(msg.x) || 0))),
          Math.max(0, Math.min(65535, Math.round(Number(msg.y) || 0))),
          (Number(msg.buttons) || 0) & 0xff,
        );
        break;
      case "key":
        if (readOnly) return;
        client.keyEvent(Number(msg.keysym) >>> 0, Boolean(msg.down));
        break;
      case "qemuKey":
        if (readOnly) return;
        client.qemuKeyEvent(Number(msg.keysym) >>> 0, Number(msg.keycode) >>> 0, Boolean(msg.down));
        break;
      case "resize": {
        if (readOnly) return;
        const w = Math.max(1, Math.min(8192, Math.round(Number(msg.width) || 0)));
        const h = Math.max(1, Math.min(8192, Math.round(Number(msg.height) || 0)));
        if (client.supports?.extendedDesktopSize) {
          client.setDesktopSize(w, h).catch(() => {});
        }
        break;
      }
      case "clipboard":
        if (readOnly) return;
        if (typeof msg.text === "string") {
          client.updateClipboard(msg.text);
        }
        break;
      case "refresh":
        client.requestUpdate(msg.incremental === true);
        break;
      case "pause":
        client.autoUpdate = !msg.paused;
        if (!msg.paused) client.requestUpdate(true);
        break;
      case "setEncodings":
        if (typeof msg.quality === "string") {
          applyEncodings(msg.quality);
        }
        break;
      case "setReadOnly":
        setReadOnly?.(Boolean(msg.readOnly));
        break;
      case "xvp":
        if (readOnly) return;
        if (
          client.supports?.xvp
          && typeof client.xvp === "function"
          && (msg.action === "shutdown" || msg.action === "reboot" || msg.action === "reset")
        ) {
          try { client.xvp(msg.action); } catch { /* ignore */ }
        }
        break;
      default:
        break;
    }
    return;
  }

  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 1) return;
  const opcode = buf[0];
  switch (opcode) {
    case VNC_C2S.POINTER:
      if (readOnly || buf.length < 6) return;
      client.pointerEvent(buf.readUInt16BE(1), buf.readUInt16BE(3), buf[5]);
      break;
    case VNC_C2S.KEY:
      if (readOnly || buf.length < 6) return;
      client.keyEvent(buf.readUInt32BE(1), buf[5] !== 0);
      break;
    case VNC_C2S.QEMU_KEY:
      if (readOnly || buf.length < 10) return;
      client.qemuKeyEvent(buf.readUInt32BE(1), buf.readUInt32BE(5), buf[9] !== 0);
      break;
    case VNC_C2S.RESIZE:
      if (readOnly || buf.length < 5) return;
      if (client.supports?.extendedDesktopSize) {
        client.setDesktopSize(buf.readUInt16BE(1), buf.readUInt16BE(3)).catch(() => {});
      }
      break;
    case VNC_C2S.CLIPBOARD:
      if (readOnly) return;
      client.updateClipboard(buf.subarray(1).toString("utf8"));
      break;
    case VNC_C2S.REFRESH:
      client.requestUpdate(buf.length >= 2 && buf[1] !== 0);
      break;
    case VNC_C2S.PAUSE: {
      const paused = buf.length >= 2 && buf[1] !== 0;
      client.autoUpdate = !paused;
      if (!paused) client.requestUpdate(true);
      break;
    }
    case VNC_C2S.SET_ENCODINGS: {
      const preset = buf.subarray(1).toString("utf8").trim();
      if (preset) applyEncodings(preset);
      break;
    }
    case VNC_C2S.SET_READ_ONLY: {
      setReadOnly?.(buf.length >= 2 && buf[1] !== 0);
      break;
    }
    case VNC_C2S.XVP: {
      if (readOnly) return;
      const action = buf.subarray(1).toString("utf8").trim();
      if (
        client.supports?.xvp
        && typeof client.xvp === "function"
        && (action === "shutdown" || action === "reboot" || action === "reset")
      ) {
        try { client.xvp(action); } catch { /* ignore */ }
      }
      break;
    }
    default:
      break;
  }
}

// ── Unified Dialer (Direct / Proxy / SSH Chain / Companion SSH Pool) ──

function dialDirectTcp(host, port, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
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
    };

    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      resolve({
        stream: socket,
        serverAddr: socket.remoteAddress
          ? (socket.remoteAddress.includes(":")
            ? `[${socket.remoteAddress}]:${socket.remotePort || port}`
            : `${socket.remoteAddress}:${socket.remotePort || port}`)
          : `${host}:${port}`,
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
  });
}

function cleanupChainConnections(connections) {
  if (!Array.isArray(connections)) return;
  for (let i = connections.length - 1; i >= 0; i -= 1) {
    try {
      connections[i]?.end?.();
      connections[i]?.destroy?.();
    } catch {
      // ignore
    }
  }
}

function openForwardOutPromise(conn, targetHost, targetPort, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ac = new AbortController();
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          try { ac.abort(new Error(`SSH forwardOut timed out to ${targetHost}:${targetPort}`)); } catch { /* ignore */ }
          reject(new Error(`SSH forwardOut timed out to ${targetHost}:${targetPort}`));
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
        if (settled) {
          try { stream?.destroy?.(); } catch { /* ignore */ }
          return;
        }
        settled = true;
        if (err) {
          reject(err);
          return;
        }
        resolve(stream);
      },
      { signal: ac.signal },
    );
  });
}

async function dialThroughCompanionSsh(event, config, sessionId) {
  const sshCfg = config.sshTunnelConfig || {};
  const targetHost = config.tunnelTargetHost || "127.0.0.1";
  const targetPort = Number(config.port);
  const timeoutMs = Number(config.connectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS;

  // 1. Try reusing an active pooled SSH transport for this host (shared with terminal/SFTP/PF).
  try {
    const sshPool = require("./sshConnectionPool.cjs");
    const endpoint = sshPool.buildConnectionReuseEndpoint({
      hostname: sshCfg.hostname || config.hostname,
      port: sshCfg.port || 22,
      username: sshCfg.username,
      authMethod: sshCfg.authMethod,
      keyId: sshCfg.keyId,
      identityId: sshCfg.identityId,
      proxy: sshCfg.proxy || config.proxy,
      jumpHosts: sshCfg.jumpHosts || config.jumpHosts,
      agentForwarding: false,
      protocol: "ssh",
      sftpSudo: false,
    }, { sftpSudo: false });
    const existing = sshPool.findTransportByEndpoint(endpoint);
    if (existing && existing.conn) {
      const holder = { sessionId };
      sshPool.borrowTransport(existing, {
        kind: sshPool.LEASE_KINDS.forward,
        holder,
        leaseId: `remote-desktop:${sessionId}`,
        meta: { source: "remote-desktop" },
      });
      try {
        const stream = await openForwardOutPromise(existing.conn, targetHost, targetPort, timeoutMs);
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          try { stream.destroy(); } catch { /* ignore */ }
          try { sshPool.returnTransport(holder); } catch { /* ignore */ }
        };
        stream.once("close", release);
        return {
          stream,
          serverAddr: `${targetHost}:${targetPort}`,
          cleanup: release,
        };
      } catch (err) {
        try { sshPool.returnTransport(holder); } catch { /* ignore */ }
        throw err;
      }
    }
  } catch (poolErr) {
    // Fall through to dialing a fresh SSH chain for the companion host.
    if (poolErr?.message && /forwardOut/i.test(poolErr.message)) {
      throw poolErr;
    }
  }

  // 2. Dial the companion SSH host (plus any of its own jump hosts) via sshBridge.connectThroughChain.
  const { connectThroughChain } = require("./sshBridge.cjs");
  const companionHop = {
    hostname: sshCfg.hostname || config.hostname,
    port: sshCfg.port || 22,
    username: sshCfg.username || "root",
    authMethod: sshCfg.authMethod,
    password: sshCfg.password,
    privateKey: sshCfg.privateKey,
    passphrase: sshCfg.passphrase,
    certificate: sshCfg.certificate,
    keyId: sshCfg.keyId,
    useSshAgent: sshCfg.useSshAgent,
    identityAgent: sshCfg.identityAgent,
    identityFilePaths: sshCfg.identityFilePaths,
    identitiesOnly: sshCfg.identitiesOnly,
    addKeysToAgent: sshCfg.addKeysToAgent,
    useKeychain: sshCfg.useKeychain,
    useFidoAgent: sshCfg.useFidoAgent,
    agentPublicKeys: sshCfg.agentPublicKeys,
    totp: sshCfg.totp,
    hostId: sshCfg.hostId || config.hostId,
    label: sshCfg.label || config.label || sshCfg.hostname || config.hostname,
    legacyAlgorithms: sshCfg.legacyAlgorithms,
    skipEcdsaHostKey: sshCfg.skipEcdsaHostKey,
    algorithmOverrides: sshCfg.algorithmOverrides,
    verifyHostKeys: sshCfg.verifyHostKeys,
    proxy: sshCfg.proxy || config.proxy,
  };
  const baseJumps = Array.isArray(sshCfg.jumpHosts)
    ? sshCfg.jumpHosts
    : Array.isArray(config.jumpHosts)
      ? config.jumpHosts
      : [];
  const fullChain = [...baseJumps, companionHop];
  const chainResult = await connectThroughChain(
    event,
    {
      hostname: targetHost,
      port: targetPort,
      knownHosts: config.knownHosts || sshCfg.knownHosts,
      verifyHostKeys: config.verifyHostKeys ?? sshCfg.verifyHostKeys,
      proxy: sshCfg.proxy || config.proxy,
      sessionId,
      _keyboardInteractiveScope: "external",
    },
    fullChain,
    targetHost,
    targetPort,
    sessionId,
  );
  return {
    stream: chainResult.socket,
    serverAddr: `${targetHost}:${targetPort}`,
    cleanup: () => {
      try { chainResult.socket?.destroy?.(); } catch { /* ignore */ }
      cleanupChainConnections(chainResult.connections);
    },
  };
}

async function defaultDialRemoteDesktop(event, config, sessionId) {
  const targetHost = config.hostname || config.host;
  const targetPort = Number(config.port) || (config.protocol === "rdp" ? 3389 : 5900);
  const timeoutMs = Number(config.connectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS;

  // (d) Companion SSH tunnel
  if (config.tunnelViaHostSsh === true && config.sshTunnelConfig) {
    return dialThroughCompanionSsh(event, { ...config, port: targetPort }, sessionId);
  }

  // (c) SSH Jump Host Chain
  if (Array.isArray(config.jumpHosts) && config.jumpHosts.length > 0) {
    const { connectThroughChain } = require("./sshBridge.cjs");
    const chainResult = await connectThroughChain(
      event,
      {
        hostname: targetHost,
        port: targetPort,
        knownHosts: config.knownHosts,
        verifyHostKeys: config.verifyHostKeys,
        proxy: config.proxy,
        sessionId,
        _keyboardInteractiveScope: "external",
      },
      config.jumpHosts,
      targetHost,
      targetPort,
      sessionId,
    );
    return {
      stream: chainResult.socket,
      serverAddr: `${targetHost}:${targetPort}`,
      cleanup: () => {
        try { chainResult.socket?.destroy?.(); } catch { /* ignore */ }
        cleanupChainConnections(chainResult.connections);
      },
    };
  }

  // (b) Proxy (SOCKS5 / HTTP CONNECT / ProxyCommand)
  if (config.proxy && config.proxy.type) {
    const sock = await createProxySocket(config.proxy, targetHost, targetPort, { timeoutMs });
    return {
      stream: sock,
      serverAddr: `${targetHost}:${targetPort}`,
      cleanup: () => {
        try { sock.destroy(); } catch { /* ignore */ }
      },
    };
  }

  // (a) Direct TCP
  return dialDirectTcp(targetHost, targetPort, timeoutMs);
}

const VNC_FENCE_MAGIC = Buffer.from("NCFT", "ascii");

function isDirectRemoteDesktopConfig(config) {
  if (!config || typeof config !== "object") return true;
  if (config.tunnelViaHostSsh === true && config.sshTunnelConfig) return false;
  if (Array.isArray(config.jumpHosts) && config.jumpHosts.length > 0) return false;
  if (config.proxy && config.proxy.type) return false;
  return true;
}

// ── VNC (rfb2) Session Handler ──

async function attachVncSessionToWebSocket({
  ws,
  config,
  dial,
  verifyCertificate,
  trustedFingerprints,
  signal,
  rfb2Module,
  onStats,
  statsIntervalMs = 1500,
  fenceIntervalMs = 3000,
  rttProbeIntervalMs = 4000,
  rttProbeTimeoutMs = 3000,
}) {
  const rfb2 = rfb2Module || require("rfb2");
  let readOnly = config.readOnly === true || config.viewOnly === true;
  const host = config.hostname || config.host || "127.0.0.1";
  const port = Number(config.port) || 5900;
  const ignoreCertErrors = config.ignoreCertErrors === true;
  const isDirectConnection = isDirectRemoteDesktopConfig(config);
  const sessionTrusted = trustedFingerprints instanceof Set ? trustedFingerprints : new Set();

  if (Array.isArray(config.knownCertFingerprints)) {
    for (const fp of config.knownCertFingerprints) {
      if (typeof fp === "string" && fp.trim()) {
        sessionTrusted.add(fp.trim().toUpperCase());
      }
    }
  }

  let currentClient = null;
  let currentUpstream = null;
  let closed = false;
  let statsTimer = null;
  let fenceTimer = null;
  let backpressureTimer = null;
  let activeRttProbe = null;
  let totalRxBytes = 0;
  let totalTxBytes = 0;
  let intervalRxBytes = 0;
  let intervalTxBytes = 0;
  const pendingFences = new Map();

  const stopTelemetry = () => {
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
    if (fenceTimer) {
      clearInterval(fenceTimer);
      fenceTimer = null;
    }
    if (backpressureTimer) {
      clearTimeout(backpressureTimer);
      backpressureTimer = null;
    }
    if (activeRttProbe) {
      try { activeRttProbe.cancel(); } catch { /* ignore */ }
      activeRttProbe = null;
    }
    pendingFences.clear();
  };

  const sendBinary = (buf) => {
    if (closed || ws.readyState !== 1) return;
    const len = buf?.length || 0;
    totalRxBytes += len;
    intervalRxBytes += len;
    try {
      ws.send(buf, { binary: true });
    } catch {
      // ignore send errors during teardown
    }
  };

  const cleanupCurrent = () => {
    stopTelemetry();
    try { currentClient?.removeAllListeners?.(); } catch { /* ignore */ }
    try { currentClient?.destroy?.(); } catch { /* ignore */ }
    currentClient = null;
    try { currentUpstream?.cleanup?.(); } catch { /* ignore */ }
    currentUpstream = null;
  };

  const cleanupAll = () => {
    if (closed) return;
    closed = true;
    cleanupCurrent();
    try {
      if (ws.readyState === 0 || ws.readyState === 1) {
        ws.close();
      }
    } catch {
      // ignore
    }
  };

  const onAbort = () => cleanupAll();
  signal?.addEventListener?.("abort", onAbort, { once: true });
  ws.once("close", cleanupAll);
  ws.once("error", cleanupAll);

  const checkPeerTlsCertificate = (client) => {
    const stream = client?.stream;
    if (!stream || typeof stream.getPeerCertificate !== "function") {
      return { untrusted: false, certInfo: null };
    }
    const certInfo = extractPeerCertInfo(stream);
    if (!certInfo || !certInfo.fingerprintSha256) {
      return { untrusted: false, certInfo: null };
    }
    if (ignoreCertErrors || sessionTrusted.has(certInfo.fingerprintSha256.toUpperCase())) {
      return { untrusted: false, certInfo };
    }
    return { untrusted: true, certInfo };
  };

  try {
    // Allow at most one TOFU abort-prompt-reconnect cycle (or multiple if cert changes)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (closed || signal?.aborted) return;

      const dialStart = performance.now();
      const upstream = await dial();
      const initialDialRttMs = Math.max(0, performance.now() - dialStart);
      if (closed || signal?.aborted) {
        upstream.cleanup?.();
        return;
      }
      currentUpstream = upstream;

      let capturedUntrustedCert = null;
      const hasUsername = typeof config.username === "string" && config.username.length > 0;
      const encodings = buildVncEncodings(rfb2, config.quality, {
        jpegQuality: config.vncQuality,
        compressionLevel: config.vncCompressionLevel,
      });

      let client;
      const connectResult = await new Promise((resolve, reject) => {
        let settled = false;
        const onHandshakeError = (err) => finishErr(err);
        const onHandshakeClose = () => finishErr(new Error("VNC connection closed during handshake"));
        const cleanupHandshakeListeners = () => {
          client?.removeListener?.("error", onHandshakeError);
          client?.removeListener?.("close", onHandshakeClose);
        };
        const finishOk = () => {
          if (settled) return;
          settled = true;
          cleanupHandshakeListeners();
          resolve({ ok: true });
        };
        const finishErr = (err) => {
          if (settled) return;
          settled = true;
          cleanupHandshakeListeners();
          if (capturedUntrustedCert) {
            resolve({ ok: false, untrustedCert: capturedUntrustedCert });
            return;
          }
          reject(err);
        };

        client = rfb2.createConnection({
          stream: upstream.stream,
          host,
          port,
          pixelFormat: "rgbx",
          shared: config.shared !== false,
          encodings,
          security: buildPreferredVncSecurity(rfb2, hasUsername),
          tls: {
            rejectUnauthorized: false,
            ...(net.isIP(host) === 0 ? { servername: host } : {}),
          },
          // Omit decodeJpeg so Tight JPEG rects arrive raw for GPU createImageBitmap!
          initialUpdate: false,
          autoUpdate: false,
          credentials: async ({ needs }) => {
            // VeNCrypt TLS handshake has just completed (if TLS subtype was chosen),
            // and ZERO credentials have been sent over the wire yet.
            const check = checkPeerTlsCertificate(client);
            if (check.untrusted) {
              capturedUntrustedCert = check.certInfo;
              const abortErr = new Error("Untrusted VNC TLS certificate");
              abortErr.code = CERT_UNTRUSTED_ABORT_CODE;
              throw abortErr;
            }
            const creds = {};
            if (needs.includes("username")) {
              creds.username = typeof config.username === "string" ? config.username : "";
            }
            if (needs.includes("password")) {
              creds.password = typeof config.password === "string" ? config.password : "";
            }
            return creds;
          },
        });
        currentClient = client;

        client.once("connect", () => {
          // Also check peer cert for X509None (where credentials callback is skipped).
          const check = checkPeerTlsCertificate(client);
          if (check.untrusted) {
            capturedUntrustedCert = check.certInfo;
            try { client.destroy(); } catch { /* ignore */ }
            finishErr(new Error("Untrusted VNC TLS certificate"));
            return;
          }
          finishOk();
        });

        client.once("error", onHandshakeError);
        client.once("close", onHandshakeClose);
      });

      if (!connectResult.ok && connectResult.untrustedCert) {
        // Phase 1 aborted cleanly before auth. Tear down socket, ask user for TOFU decision,
        // and reconnect cleanly if trusted.
        cleanupCurrent();
        if (typeof verifyCertificate !== "function") {
          throw new Error("Untrusted VNC TLS certificate and no verification handler available");
        }
        const verdict = await verifyCertificate({
          ...connectResult.untrustedCert,
          host,
          port,
          protocol: "vnc",
        });
        if (!verdict || verdict.accepted !== true) {
          sendBinary(encodeVncJsonFrame(VNC_S2C.ERROR, {
            code: "CERT_REJECTED",
            message: verdict?.reason || "Certificate rejected by user",
          }));
          cleanupAll();
          return;
        }
        sessionTrusted.add(connectResult.untrustedCert.fingerprintSha256.toUpperCase());
        continue;
      }

      // Connected and verified! Wire RFB events <-> WS binary framing.
      if (closed || signal?.aborted) {
        cleanupAll();
        return;
      }

      const WS_BACKPRESSURE_HIGH_WATER = 8 * 1024 * 1024;
      let userPaused = false;
      let backpressurePaused = false;
      let continuousUpdatesEnabled = false;

      const snapshotSupports = () => ({
        extendedDesktopSize: Boolean(client.supports?.extendedDesktopSize),
        unicodeClipboard: Boolean(client.supports?.unicodeClipboard),
        extendedClipboard: Boolean(client.supports?.extendedClipboard),
        qemuExtendedKeyEvent: Boolean(client.supports?.qemuExtendedKeyEvent),
        continuousUpdates: Boolean(client.supports?.continuousUpdates),
        fence: Boolean(client.supports?.fence),
        xvp: Boolean(client.supports?.xvp),
      });

      let lastSupportsJson = "";
      const syncCapabilitiesIfChanged = () => {
        const supports = snapshotSupports();
        const nextJson = JSON.stringify(supports);
        if (nextJson !== lastSupportsJson) {
          lastSupportsJson = nextJson;
          sendBinary(encodeVncJsonFrame(VNC_S2C.CAPABILITIES, { supports }));
        }
        // Enable RFB Continuous Updates as soon as the server confirms support
        if (
          supports.continuousUpdates
          && !continuousUpdatesEnabled
          && !userPaused
          && !backpressurePaused
          && typeof client.enableContinuousUpdates === "function"
        ) {
          continuousUpdatesEnabled = true;
          try {
            client.enableContinuousUpdates(true, 0, 0, client.width, client.height);
          } catch {
            continuousUpdatesEnabled = false;
          }
        }
      };

      const checkBackpressure = () => {
        if (closed || !client || client.closed) return;
        const buffered = Number(ws.bufferedAmount) || 0;
        if (buffered > WS_BACKPRESSURE_HIGH_WATER && !backpressurePaused) {
          backpressurePaused = true;
          client.autoUpdate = false;
          if (!backpressureTimer) {
            backpressureTimer = setTimeout(() => {
              backpressureTimer = null;
              if (closed || !client || client.closed) return;
              if ((Number(ws.bufferedAmount) || 0) <= WS_BACKPRESSURE_HIGH_WATER / 2) {
                backpressurePaused = false;
                if (!userPaused) {
                  client.autoUpdate = true;
                  client.requestUpdate(true);
                }
              } else {
                checkBackpressure();
              }
            }, 80);
            backpressureTimer.unref?.();
          }
        }
      };

      const isNativeRgbx = (pf) => (
        pf
        && pf.trueColor
        && pf.bitsPerPixel === 32
        && !pf.bigEndian
        && pf.redShift === 0
        && pf.greenShift === 8
        && pf.blueShift === 16
      );

      const sendRect = (rect) => {
        if (closed || ws.readyState !== 1) return;
        switch (rect.type) {
          case "pixels": {
            const raw = rect.data;
            if (isNativeRgbx(client.pixelFormat) && raw && raw.length === rect.width * rect.height * 4) {
              // Single-allocation fast path: copy directly into wire frame and stamp opaque alpha.
              const frame = Buffer.allocUnsafe(9 + raw.length);
              frame[0] = VNC_S2C.RAW_RGBA;
              frame.writeUInt16BE(rect.x & 0xffff, 1);
              frame.writeUInt16BE(rect.y & 0xffff, 3);
              frame.writeUInt16BE(rect.width & 0xffff, 5);
              frame.writeUInt16BE(rect.height & 0xffff, 7);
              raw.copy(frame, 9);
              for (let i = 12; i < frame.length; i += 4) {
                frame[i] = 255;
              }
              sendBinary(frame);
            } else {
              const rgba = rfb2.toRgba(client.pixelFormat, raw, client.colorMap);
              sendBinary(encodeVncRawRgbaFrame(rect.x, rect.y, rect.width, rect.height, rgba));
            }
            checkBackpressure();
            break;
          }
          case "copy":
            sendBinary(
              encodeVncCopyRectFrame(rect.x, rect.y, rect.width, rect.height, rect.src.x, rect.src.y),
            );
            break;
          case "jpeg":
            sendBinary(encodeVncJpegFrame(rect.x, rect.y, rect.width, rect.height, rect.jpeg));
            checkBackpressure();
            break;
          default:
            break;
        }
      };

      client.on("rect", sendRect);
      client.on("update", () => {
        syncCapabilitiesIfChanged();
        sendBinary(Buffer.from([VNC_S2C.FRAME_SYNC]));
      });
      client.on("resize", ({ width, height }) => {
        syncCapabilitiesIfChanged();
        if (continuousUpdatesEnabled && typeof client.enableContinuousUpdates === "function") {
          try {
            client.enableContinuousUpdates(true, 0, 0, width, height);
          } catch { /* ignore */ }
        }
        sendBinary(encodeVncDesktopSizeFrame(width, height));
      });
      client.on("cursor", (cursor) => {
        sendBinary(encodeVncCursorFrame(cursor.x, cursor.y, cursor.width, cursor.height, cursor.rgba));
      });
      client.on("clipboard", (text) => {
        syncCapabilitiesIfChanged();
        sendBinary(encodeVncTextFrame(VNC_S2C.CLIPBOARD, text));
      });
      client.on("bell", () => {
        sendBinary(Buffer.from([VNC_S2C.BELL]));
      });
      client.on("desktopName", (name) => {
        sendBinary(encodeVncTextFrame(VNC_S2C.DESKTOP_NAME, name));
      });
      client.on("endOfContinuousUpdates", () => {
        continuousUpdatesEnabled = false;
        syncCapabilitiesIfChanged();
      });

      const onWsMessage = (data, isBinary) => {
        const len = Buffer.isBuffer(data)
          ? data.length
          : data instanceof Uint8Array
            ? data.byteLength
            : Buffer.byteLength(String(data || ""), "utf8");
        totalTxBytes += len;
        intervalTxBytes += len;
        if (isBinary) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (buf.length >= 2 && buf[0] === VNC_C2S.PAUSE) {
            userPaused = buf[1] !== 0;
          }
        }
        dispatchVncClientMessage(client, data, isBinary, {
          readOnly,
          setReadOnly: (next) => {
            readOnly = Boolean(next);
          },
          rfb2Module: rfb2,
          onSetEncodings: (preset) => {
            if (typeof client.setEncodings !== "function") return;
            try {
              client.setEncodings(buildVncEncodings(rfb2, preset, {
                jpegQuality: config.vncQuality,
                compressionLevel: config.vncCompressionLevel,
              }));
              client.requestUpdate(false);
            } catch { /* ignore */ }
          },
        });
      };
      ws.on("message", onWsMessage);

      // Telemetry: RFB Fence RTT (when supported) + RX/TX bandwidth stats
      let smoothedRttMs = Number.isFinite(initialDialRttMs) ? initialDialRttMs : null;
      let smoothedRxBps = 0;
      let smoothedTxBps = 0;
      let lastStatsAt = performance.now();
      let hasEmittedInterval = false;
      let fenceSeq = 0;

      const onFenceReply = (ev) => {
        const payload = ev?.payload;
        if (!payload || payload.length < 8) return;
        const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        if (
          buf[0] !== VNC_FENCE_MAGIC[0]
          || buf[1] !== VNC_FENCE_MAGIC[1]
          || buf[2] !== VNC_FENCE_MAGIC[2]
          || buf[3] !== VNC_FENCE_MAGIC[3]
        ) {
          return;
        }
        const seq = buf.readUInt32BE(4);
        const sentAt = pendingFences.get(seq);
        if (sentAt === undefined) return;
        pendingFences.delete(seq);
        const sample = performance.now() - sentAt;
        if (Number.isFinite(sample) && sample >= 0) {
          smoothedRttMs = smoothedRttMs === null ? sample : (smoothedRttMs * 0.6 + sample * 0.4);
        }
      };
      client.on("fence", onFenceReply);

      const emitStats = (isInitial = false) => {
        if (typeof onStats !== "function" || closed) return;
        if (!isInitial) {
          const now = performance.now();
          const dtSec = Math.max(0.05, (now - lastStatsAt) / 1000);
          const instRxBps = intervalRxBytes / dtSec;
          const instTxBps = intervalTxBytes / dtSec;
          smoothedRxBps = hasEmittedInterval ? (smoothedRxBps * 0.4 + instRxBps * 0.6) : instRxBps;
          smoothedTxBps = hasEmittedInterval ? (smoothedTxBps * 0.4 + instTxBps * 0.6) : instTxBps;
          if (smoothedRxBps < 1) smoothedRxBps = 0;
          if (smoothedTxBps < 1) smoothedTxBps = 0;
          intervalRxBytes = 0;
          intervalTxBytes = 0;
          lastStatsAt = now;
          hasEmittedInterval = true;
        }
        try {
          onStats({
            protocol: "vnc",
            rttMs: smoothedRttMs !== null && Number.isFinite(smoothedRttMs)
              ? Math.max(0, Math.round(smoothedRttMs))
              : null,
            rxBps: Math.max(0, Math.round(smoothedRxBps)),
            txBps: Math.max(0, Math.round(smoothedTxBps)),
            totalRxBytes,
            totalTxBytes,
            ts: Date.now(),
          });
        } catch {
          // telemetry callback errors must never disrupt the VNC session
        }
      };

      let lastTcpFallbackProbeAt = 0;
      const effectiveFallbackInterval = Math.max(10_000, Number(rttProbeIntervalMs) || 15_000);
      const sendFenceOrFallbackProbe = () => {
        if (closed || !client || client.closed) return;
        syncCapabilitiesIfChanged();
        if (client.supports?.fence && typeof client.fence === "function") {
          fenceSeq = (fenceSeq + 1) >>> 0;
          if (pendingFences.size >= 16) {
            const oldestKey = pendingFences.keys().next().value;
            if (oldestKey !== undefined) pendingFences.delete(oldestKey);
          }
          const payload = Buffer.allocUnsafe(8);
          VNC_FENCE_MAGIC.copy(payload, 0);
          payload.writeUInt32BE(fenceSeq, 4);
          pendingFences.set(fenceSeq, performance.now());
          try {
            client.fence(0, payload);
          } catch {
            pendingFences.delete(fenceSeq);
          }
          return;
        }
        // Throttle fallback TCP RTT probes on non-Fence servers so we never spam failed handshakes.
        const now = performance.now();
        if (
          isDirectConnection
          && host
          && port
          && !activeRttProbe
          && (now - lastTcpFallbackProbeAt >= effectiveFallbackInterval)
        ) {
          lastTcpFallbackProbeAt = now;
          const effectiveTimeout = Math.max(100, Number(rttProbeTimeoutMs) || 3000);
          const probe = probeTcpConnectRtt(host, port, effectiveTimeout);
          activeRttProbe = probe;
          void probe.promise.then((sample) => {
            if (activeRttProbe === probe) activeRttProbe = null;
            if (!closed && typeof sample === "number" && Number.isFinite(sample)) {
              smoothedRttMs = smoothedRttMs === null ? sample : (smoothedRttMs * 0.6 + sample * 0.4);
            }
          });
        }
      };

      // Send READY metadata frame, then request initial full framebuffer update + enable autoUpdate.
      const initialSupports = snapshotSupports();
      lastSupportsJson = JSON.stringify(initialSupports);
      sendBinary(encodeVncJsonFrame(VNC_S2C.READY, {
        width: client.width,
        height: client.height,
        name: client.name || "",
        securityType: client.securityType,
        securityName: typeof rfb2.securityName === "function" ? rfb2.securityName(client.securityType) : String(client.securityType),
        supports: initialSupports,
      }));

      client.autoUpdate = true;
      client.requestUpdate(false);

      if (typeof onStats === "function") {
        emitStats(true);
        const effectiveStatsInterval = Math.max(50, Number(statsIntervalMs) || 1500);
        statsTimer = setInterval(() => emitStats(false), effectiveStatsInterval);
        statsTimer.unref?.();

        const effectiveFenceInterval = Math.max(
          50,
          Number(fenceIntervalMs) || 3000,
        );
        fenceTimer = setInterval(sendFenceOrFallbackProbe, effectiveFenceInterval);
        fenceTimer.unref?.();
        if (client.supports?.fence) {
          sendFenceOrFallbackProbe();
        }
      }

      // Wait until RFB client or WebSocket closes.
      await new Promise((resolve) => {
        let done = false;
        const onClientError = (err) => {
          sendBinary(encodeVncJsonFrame(VNC_S2C.ERROR, {
            code: err?.code || "RFB_ERROR",
            message: err?.message || String(err),
          }));
          finish();
        };
        const finish = () => {
          if (done) return;
          done = true;
          stopTelemetry();
          client.removeAllListeners?.();
          ws.removeListener("message", onWsMessage);
          ws.removeListener("close", finish);
          resolve();
        };
        client.once("error", onClientError);
        client.once("close", finish);
        ws.once("close", finish);
      });
      return;
    }

    throw new Error("Exceeded maximum VNC TLS certificate verification attempts");
  } catch (err) {
    if (!closed) {
      sendBinary(encodeVncJsonFrame(VNC_S2C.ERROR, {
        code: err?.code || "VNC_CONNECT_FAILED",
        message: err?.message || String(err),
      }));
    }
    throw err;
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
    ws.removeListener?.("close", cleanupAll);
    ws.removeListener?.("error", cleanupAll);
    cleanupAll();
  }
}

// ── Remote Desktop Service (runs inside terminalWorker or main fallback) ──

function createRemoteDesktopService(options = {}) {
  const dialFn = options.dial || defaultDialRemoteDesktop;
  const allowDevOrigins = options.allowDevOrigins !== false;
  const extraAllowedOrigins = options.extraAllowedOrigins || [];
  const rfb2Module = options.rfb2Module || null;

  /** @type {http.Server | null} */
  let httpServer = null;
  /** @type {WebSocketServer | null} */
  let wss = null;
  let listenPort = null;
  let serverStartPromise = null;

  /** @type {Map<string, object>} sessionId -> session record */
  const sessions = new Map();
  /** @type {Map<string, { sessionId: string, token: string, expiresAt: number, timer: NodeJS.Timeout }>} */
  const pendingTokens = new Map();
  /** @type {Map<string, { sessionId: string, resolve: Function, timer: NodeJS.Timeout }>} */
  const pendingCertDecisions = new Map();
  /** @type {Map<string, { abortController: AbortController, webContentsId: number | null }>} */
  const activeProbes = new Map();

  function clearPendingToken(sessionId) {
    const entry = pendingTokens.get(sessionId);
    if (!entry) return;
    pendingTokens.delete(sessionId);
    if (entry.timer) clearTimeout(entry.timer);
  }

  function mintOneTimeToken(sessionId) {
    clearPendingToken(sessionId);
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const timer = setTimeout(() => {
      const current = pendingTokens.get(sessionId);
      if (current && current.token === token) {
        pendingTokens.delete(sessionId);
      }
    }, TOKEN_TTL_MS);
    timer.unref?.();
    pendingTokens.set(sessionId, { sessionId, token, expiresAt, timer });
    return token;
  }

  function consumeOneTimeToken(sessionId, providedToken) {
    if (!sessionId || typeof providedToken !== "string" || providedToken.length === 0) {
      return false;
    }
    const entry = pendingTokens.get(sessionId);
    if (!entry) return false;
    // Consume immediately (one-time use) before returning, even if expired or invalid
    // to prevent brute-force probing against a live session token.
    clearPendingToken(sessionId);
    if (Date.now() > entry.expiresAt) return false;
    return timingSafeTokenEquals(entry.token, providedToken);
  }

  async function ensureWsServer() {
    if (httpServer && wss && listenPort) {
      return listenPort;
    }
    if (serverStartPromise) {
      return serverStartPromise;
    }
    serverStartPromise = new Promise((resolve, reject) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(426, { "Content-Type": "text/plain" });
        res.end("Upgrade Required");
      });
      const { WebSocketServer } = require("ws");
      const wsServer = new WebSocketServer({
        noServer: true,
        perMessageDeflate: false,
      });

      server.on("upgrade", (req, socket, head) => {
        const origin = req.headers?.origin;
        if (!isAllowedLoopbackOrigin(origin, { allowDevOrigins, extraAllowedOrigins })) {
          console.warn(`[RemoteDesktop] WS upgrade rejected (403 origin): ${origin || "(empty)"}`);
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }

        let parsedUrl;
        try {
          parsedUrl = new URL(req.url || "/", "http://127.0.0.1");
        } catch {
          socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }

        if (parsedUrl.pathname !== "/rd") {
          socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }

        const sessionId = parsedUrl.searchParams.get("sessionId") || "";
        const token = parsedUrl.searchParams.get("token") || "";
        const session = sessions.get(sessionId);
        if (!session || !consumeOneTimeToken(sessionId, token)) {
          console.warn(
            `[RemoteDesktop] WS upgrade rejected (401 auth): sessionId=${sessionId} hasSession=${Boolean(session)}`,
          );
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }

        wsServer.handleUpgrade(req, socket, head, (ws) => {
          handleAuthenticatedWs(session, ws);
        });
      });

      server.once("error", (err) => {
        serverStartPromise = null;
        reject(err);
      });

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        httpServer = server;
        wss = wsServer;
        listenPort = addr.port;
        serverStartPromise = null;
        resolve(listenPort);
      });
    });
    return serverStartPromise;
  }

  function requestCertVerification(session, certInfo) {
    const fpUpper = String(certInfo.fingerprintSha256 || "").toUpperCase();
    if (session.config.ignoreCertErrors === true) {
      return Promise.resolve({ accepted: true, trustAlways: false });
    }
    if (fpUpper && session.trustedFingerprints.has(fpUpper)) {
      return Promise.resolve({ accepted: true, trustAlways: false });
    }

    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingCertDecisions.delete(requestId);
        resolve({ accepted: false, reason: "Certificate verification timed out" });
      }, CERT_DECISION_TIMEOUT_MS);
      timer.unref?.();

      pendingCertDecisions.set(requestId, {
        sessionId: session.sessionId,
        resolve: (decision) => {
          clearTimeout(timer);
          pendingCertDecisions.delete(requestId);
          resolve(decision);
        },
        timer,
      });

      safeSend(session.sender, "netcatty:remote-desktop:cert-verify", {
        requestId,
        sessionId: session.sessionId,
        protocol: session.protocol,
        host: certInfo.host || session.config.hostname,
        port: certInfo.port || session.config.port,
        fingerprintSha256: certInfo.fingerprintSha256,
        subject: certInfo.subject,
        issuer: certInfo.issuer,
        validFrom: certInfo.validFrom,
        validTo: certInfo.validTo,
        serialNumber: certInfo.serialNumber,
        subjectAltName: certInfo.subjectAltName,
        previousFingerprint: session.config.expectedCertFingerprint || null,
      });
    });
  }

  function handleAuthenticatedWs(session, ws) {
    if (session.closed) {
      try { ws.close(); } catch { /* ignore */ }
      return;
    }
    session.ws = ws;

    const dial = () => dialFn(session.event, session.config, session.sessionId);
    const verifyCertificate = (certInfo) => requestCertVerification(session, certInfo);

    const onDone = (err) => {
      if (err && !session.closed) {
        safeSend(session.sender, "netcatty:remote-desktop:status", {
          sessionId: session.sessionId,
          status: "error",
          error: err?.message || String(err),
        });
      }
      if (!session.closed) {
        safeSend(session.sender, "netcatty:remote-desktop:status", {
          sessionId: session.sessionId,
          status: "closed",
        });
      }
      stopSessionInternal(session.sessionId);
    };

    const emitSessionStats = (stats) => {
      if (session.closed) return;
      safeSend(session.sender, "netcatty:remote-desktop:stats", {
        sessionId: session.sessionId,
        ...stats,
      });
    };

    if (session.protocol === "rdp") {
      void handleRdpCleanPathConnection({
        ws,
        host: session.config.hostname || session.config.host,
        port: Number(session.config.port) || 3389,
        dial,
        verifyCertificate,
        allowLegacyTls: session.config.allowLegacyTls === true || session.config.securityMode === "tls-legacy",
        handshakeTimeoutMs: Number(session.config.connectTimeoutMs) || 20_000,
        signal: session.abortController.signal,
        isDirectConnection: isDirectRemoteDesktopConfig(session.config),
        statsIntervalMs: options.statsIntervalMs,
        rttProbeIntervalMs: options.rttProbeIntervalMs,
        onStatus: (stage, detail) => {
          safeSend(session.sender, "netcatty:remote-desktop:status", {
            sessionId: session.sessionId,
            status: stage,
            ...(detail || {}),
          });
        },
        onStats: emitSessionStats,
      }).then(() => onDone(null), onDone);
      return;
    }

    if (session.protocol === "vnc") {
      void attachVncSessionToWebSocket({
        ws,
        config: session.config,
        dial,
        verifyCertificate,
        trustedFingerprints: session.trustedFingerprints,
        signal: session.abortController.signal,
        rfb2Module,
        onStats: emitSessionStats,
        statsIntervalMs: options.statsIntervalMs,
        fenceIntervalMs: options.fenceIntervalMs,
        rttProbeIntervalMs: options.rttProbeIntervalMs,
      }).then(() => onDone(null), onDone);
      return;
    }

    try { ws.close(1008, "Unsupported protocol"); } catch { /* ignore */ }
    stopSessionInternal(session.sessionId);
  }

  function stopSessionInternal(sessionId) {
    if (!sessionId) return { success: false };
    clearPendingToken(sessionId);
    for (const [reqId, pending] of pendingCertDecisions) {
      if (pending.sessionId === sessionId) {
        pending.resolve({ accepted: false, reason: "Session closed" });
        pendingCertDecisions.delete(reqId);
      }
    }
    const session = sessions.get(sessionId);
    if (!session) return { success: false };
    sessions.delete(sessionId);
    session.closed = true;
    try { session.abortController.abort(); } catch { /* ignore */ }
    try {
      if (session.ws && (session.ws.readyState === 0 || session.ws.readyState === 1)) {
        session.ws.close();
      }
    } catch {
      // ignore
    }
    return { success: true };
  }

  async function startSession(event, payload = {}) {
    const protocol = String(payload.protocol || "").toLowerCase();
    if (protocol !== "vnc" && protocol !== "rdp") {
      throw new Error(`Unsupported remote desktop protocol: ${payload.protocol}`);
    }
    const hostname = typeof payload.hostname === "string"
      ? payload.hostname.trim()
      : typeof payload.host === "string"
        ? payload.host.trim()
        : "";
    if (!hostname) {
      throw new Error("Remote desktop hostname is required");
    }

    const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim()
      ? payload.sessionId.trim()
      : crypto.randomUUID();

    if (sessions.has(sessionId)) {
      stopSessionInternal(sessionId);
    }

    const port = Number(payload.port) || (protocol === "rdp" ? 3389 : 5900);
    const trustedFingerprints = new Set();
    if (Array.isArray(payload.knownCertFingerprints)) {
      for (const fp of payload.knownCertFingerprints) {
        if (typeof fp === "string" && fp.trim()) {
          trustedFingerprints.add(fp.trim().toUpperCase());
        }
      }
    }

    const wsPort = await ensureWsServer();
    const token = mintOneTimeToken(sessionId);

    const session = {
      sessionId,
      protocol,
      webContentsId: event?.sender?.id ?? null,
      sender: event?.sender || null,
      event,
      config: { ...payload, protocol, hostname, port },
      trustedFingerprints,
      abortController: new AbortController(),
      ws: null,
      closed: false,
    };
    sessions.set(sessionId, session);

    const wsUrl = `ws://127.0.0.1:${wsPort}/rd?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;
    return {
      sessionId,
      protocol,
      wsUrl,
      port: wsPort,
    };
  }

  function stopSession(_event, payload = {}) {
    const sessionId = typeof payload === "string" ? payload : payload?.sessionId;
    return stopSessionInternal(sessionId);
  }

  function respondCertDecision(_event, payload = {}) {
    const requestId = payload?.requestId;
    const pending = pendingCertDecisions.get(requestId);
    if (!pending) {
      return { success: false, error: "Certificate verification request not found or expired" };
    }
    const decisionStr = typeof payload?.decision === "string" ? payload.decision : null;
    const accepted = decisionStr
      ? decisionStr === "accept-once" || decisionStr === "accept-always" || decisionStr === "trust-once" || decisionStr === "trust-always"
      : payload?.accepted === true;
    const trustAlways = decisionStr === "accept-always" || decisionStr === "trust-always" || payload?.trustAlways === true;
    pending.resolve({ accepted, trustAlways, reason: accepted ? undefined : "Rejected by user" });
    return { success: true };
  }

  function cancelProbeInternal(sessionId) {
    if (!sessionId) return { ok: false };
    const entry = activeProbes.get(sessionId);
    if (!entry) return { ok: false };
    activeProbes.delete(sessionId);
    try { entry.abortController.abort(); } catch { /* ignore */ }
    return { ok: true };
  }

  async function testConnection(event, payload = {}) {
    const protocol = String(payload?.protocol || "").toLowerCase();
    const sessionId = typeof payload?.sessionId === "string" && payload.sessionId.trim()
      ? payload.sessionId.trim()
      : crypto.randomUUID();
    const sender = event?.sender || null;
    const hostname = typeof payload?.hostname === "string"
      ? payload.hostname.trim()
      : typeof payload?.host === "string"
        ? payload.host.trim()
        : "";
    const port = Number(payload?.port) || (protocol === "rdp" ? 3389 : 5900);
    const displayLabel = payload?.label || `${hostname}:${port}`;

    if (activeProbes.has(sessionId)) {
      cancelProbeInternal(sessionId);
    }
    const abortController = new AbortController();
    activeProbes.set(sessionId, {
      abortController,
      webContentsId: sender?.id ?? null,
    });

    const totalHops =
      (Array.isArray(payload?.jumpHosts) ? payload.jumpHosts.length : 0)
      + (payload?.tunnelViaHostSsh === true && payload?.sshTunnelConfig ? 1 : 0)
      + 1;
    const targetHop = totalHops;

    const emitPhase = (phase, detail) => {
      if (!sender) return;
      let errorDetail;
      if (phase === "tcp-connected" && typeof detail?.rttMs === "number") {
        errorDetail = `${detail.rttMs} ms`;
      } else if (phase === "x224-negotiated" && detail?.bannerDetail) {
        errorDetail = detail.bannerDetail;
      } else if (phase === "rfb-banner" && detail?.rfbVersion) {
        errorDetail = detail.rfbVersion;
      } else if (phase === "rfb-security" && Array.isArray(detail?.vncSecurityTypes)) {
        errorDetail = detail.vncSecurityTypes.map((s) => s.name).join(", ");
      }
      safeSend(sender, "netcatty:chain:progress", {
        sessionId,
        hop: targetHop,
        total: totalHops,
        label: displayLabel,
        status: phase,
        ...(errorDetail ? { error: errorDetail } : {}),
      });
    };

    try {
      const result = await probeRemoteDesktop(
        { ...payload, protocol, hostname, port, sessionId, mode: "full" },
        {
          event,
          signal: abortController.signal,
          dial: options.dial
            ? () => dialFn(event, {
                ...payload,
                protocol,
                hostname,
                port,
                username: undefined,
                password: undefined,
                domain: undefined,
              }, sessionId)
            : undefined,
          onPhase: emitPhase,
        },
      );
      if (!result.ok && result.error) {
        const { annotateMacLocalNetworkError } = require("./macLocalNetworkAccess.cjs");
        const macTarget = payload?.tunnelViaHostSsh === true && payload?.sshTunnelConfig
          ? payload.sshTunnelConfig
          : payload;
        result.error = annotateMacLocalNetworkError(result.error, macTarget);
      }
      return result;
    } finally {
      const current = activeProbes.get(sessionId);
      if (current && current.abortController === abortController) {
        activeProbes.delete(sessionId);
      }
    }
  }

  function cancelTestConnection(_event, payload = {}) {
    const sessionId = typeof payload === "string" ? payload : payload?.sessionId;
    return cancelProbeInternal(sessionId);
  }

  function stopOwnerSessions(_event, payload = {}) {
    const webContentsId = Number(payload?.webContentsId);
    if (!Number.isSafeInteger(webContentsId)) return { stopped: 0 };
    let stopped = 0;
    for (const [sessionId, session] of [...sessions]) {
      if (session.webContentsId === webContentsId) {
        stopSessionInternal(sessionId);
        stopped += 1;
      }
    }
    for (const [probeSessionId, probe] of [...activeProbes]) {
      if (probe.webContentsId === webContentsId) {
        cancelProbeInternal(probeSessionId);
      }
    }
    return { stopped };
  }

  async function stopAll() {
    for (const probeSessionId of [...activeProbes.keys()]) {
      cancelProbeInternal(probeSessionId);
    }
    for (const sessionId of [...sessions.keys()]) {
      stopSessionInternal(sessionId);
    }
    for (const sessionId of [...pendingTokens.keys()]) {
      clearPendingToken(sessionId);
    }
    if (wss) {
      try {
        for (const client of wss.clients) {
          try { client.terminate(); } catch { /* ignore */ }
        }
        wss.close();
      } catch {
        // ignore
      }
      wss = null;
    }
    if (httpServer) {
      const serverToClose = httpServer;
      httpServer = null;
      listenPort = null;
      await new Promise((resolve) => {
        try {
          serverToClose.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
    return { success: true };
  }

  function getServerPort() {
    return listenPort;
  }

  function getActiveSessionCount() {
    return sessions.size;
  }

  return {
    startSession,
    stopSession,
    respondCertDecision,
    testConnection,
    cancelTestConnection,
    stopOwnerSessions,
    stopAll,
    getServerPort,
    getActiveSessionCount,
  };
}

// ── Main Process Helpers: Save Clipboard File & Open System Client ──

function buildDefaultRdpFileContent({
  host,
  port = 3389,
  username,
  domain,
  loadBalanceInfo,
  alternateShell,
  shellWorkingDir,
  audioEnabled = true,
  clipboardSync = true,
}) {
  const hostPort = host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;
  const lines = [
    `full address:s:${hostPort}`,
    "prompt for credentials:i:1",
    "use redirection server name:i:1",
    `audiomode:i:${audioEnabled === false ? 2 : 0}`,
    `redirectclipboard:i:${clipboardSync === false ? 0 : 1}`,
    "screen mode id:i:2",
    "smart sizing:i:1",
    "dynamic resolution:i:1",
  ];
  if (typeof username === "string" && username.trim()) {
    lines.push(`username:s:${username.trim()}`);
  }
  if (typeof domain === "string" && domain.trim()) {
    lines.push(`domain:s:${domain.trim()}`);
  }
  if (typeof loadBalanceInfo === "string" && loadBalanceInfo.trim()) {
    lines.push(`loadbalanceinfo:s:${loadBalanceInfo.trim()}`);
  }
  if (typeof alternateShell === "string" && alternateShell.trim()) {
    lines.push(`alternate shell:s:${alternateShell.trim()}`);
  }
  if (typeof shellWorkingDir === "string" && shellWorkingDir.trim()) {
    lines.push(`shell working directory:s:${shellWorkingDir.trim()}`);
  }
  return `${lines.join("\r\n")}\r\n`;
}

function rewriteRdpFullAddress(rdpContent, host, port) {
  const hostPort = host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;
  const line = `full address:s:${hostPort}`;
  if (/^full address:s:.*$/im.test(rdpContent)) {
    return rdpContent.replace(/^full address:s:.*$/im, line);
  }
  return `${line}\r\n${rdpContent}`;
}

function buildSystemVncUrl(host, port, username) {
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const userPart = typeof username === "string" && username.trim()
    ? `${encodeURIComponent(username.trim())}@`
    : "";
  // Never embed passwords in vnc:// URLs!
  return `vnc://${userPart}${hostPart}:${port}`;
}

function registerMainOsHandlers(ipcMain, options = {}) {
  const {
    electronModule,
    tempDirBridge,
    portForwardingBridge,
    terminalWorkerManager,
    fsImpl = fs,
    pathImpl = path,
  } = options;

  const activeClipboardWriteStreams = new Map();
  const trackedClipboardSenders = new WeakSet();
  const ephemeralSystemTunnels = new Set();

  const abortClipboardStreamEntry = async (streamId, entry) => {
    activeClipboardWriteStreams.delete(streamId);
    try { await entry.handle.close(); } catch { /* ignore */ }
    try { await fsImpl.promises.unlink(entry.filePath); } catch { /* ignore */ }
  };

  const trackClipboardSender = (sender) => {
    if (!sender || typeof sender.once !== "function" || trackedClipboardSenders.has(sender)) return;
    trackedClipboardSenders.add(sender);
    const webContentsId = sender.id;
    sender.once("destroyed", () => {
      for (const [streamId, entry] of [...activeClipboardWriteStreams]) {
        if (entry.webContentsId === webContentsId) {
          void abortClipboardStreamEntry(streamId, entry);
        }
      }
    });
  };

  ipcMain.handle("netcatty:remote-desktop:save-clipboard-file", async (event, payload = {}) => {
    const dialog = electronModule?.dialog;
    const BrowserWindow = electronModule?.BrowserWindow;
    const ownerWin = BrowserWindow?.fromWebContents?.(event?.sender) || undefined;
    const action = payload?.action || "oneshot";

    if (action === "chunk") {
      const entry = activeClipboardWriteStreams.get(payload.streamId);
      if (!entry) return { ok: false, error: "Clipboard save stream not found" };
      const buf = Buffer.isBuffer(payload.data)
        ? payload.data
        : payload.data instanceof Uint8Array
          ? Buffer.from(payload.data.buffer, payload.data.byteOffset, payload.data.byteLength)
          : Buffer.from(String(payload.data || ""), "base64");
      try {
        await entry.handle.write(buf);
        entry.bytesWritten += buf.length;
        return { ok: true, bytesWritten: entry.bytesWritten };
      } catch (err) {
        await abortClipboardStreamEntry(payload.streamId, entry);
        return { ok: false, error: err?.message || "Failed to write clipboard file chunk" };
      }
    }

    if (action === "finish") {
      const entry = activeClipboardWriteStreams.get(payload.streamId);
      if (!entry) return { ok: false, error: "Clipboard save stream not found" };
      activeClipboardWriteStreams.delete(payload.streamId);
      await entry.handle.close();
      return { ok: true, filePath: entry.filePath, bytesWritten: entry.bytesWritten };
    }

    if (action === "abort") {
      const entry = activeClipboardWriteStreams.get(payload.streamId);
      if (!entry) return { ok: true };
      await abortClipboardStreamEntry(payload.streamId, entry);
      return { ok: true };
    }

    if (!dialog?.showSaveDialog) {
      return { ok: false, error: "Save dialog is unavailable" };
    }

    const safeFileName = pathImpl.basename(String(payload?.fileName || "clipboard-file"));
    const defaultPath = payload?.defaultDir
      ? pathImpl.join(String(payload.defaultDir), safeFileName)
      : safeFileName;

    const result = await dialog.showSaveDialog(ownerWin, {
      title: "Save Remote Clipboard File",
      defaultPath,
    });
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true };
    }

    if (action === "begin") {
      trackClipboardSender(event?.sender);
      const handle = await fsImpl.promises.open(result.filePath, "w");
      const streamId = crypto.randomUUID();
      activeClipboardWriteStreams.set(streamId, {
        handle,
        filePath: result.filePath,
        bytesWritten: 0,
        webContentsId: event?.sender?.id ?? null,
      });
      return { ok: true, streamId, filePath: result.filePath };
    }

    // One-shot write
    const data = payload?.data;
    const buf = Buffer.isBuffer(data)
      ? data
      : data instanceof Uint8Array
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : typeof data === "string"
          ? Buffer.from(data, payload.encoding === "utf8" ? "utf8" : "base64")
          : Buffer.alloc(0);
    await fsImpl.promises.writeFile(result.filePath, buf);
    return { ok: true, filePath: result.filePath, bytesWritten: buf.length };
  });

  ipcMain.handle("netcatty:remote-desktop:open-system-client", async (event, payload = {}) => {
    const shell = electronModule?.shell;
    if (!shell) return { ok: false, error: "Electron shell is unavailable" };
    const protocol = String(payload?.protocol || "").toLowerCase();
    if (protocol !== "rdp" && protocol !== "vnc") {
      return { ok: false, error: `Unsupported protocol for system client: ${payload?.protocol}` };
    }

    let targetHost = String(payload.hostname || payload.host || "").trim();
    let targetPort = Number(payload.port) || (protocol === "rdp" ? 3389 : 5900);
    let ephemeralTunnelId = null;

    // Spin up ephemeral local port forward on 127.0.0.1:0 when SSH jump chain or companion SSH tunnel is present.
    const needsTunnel = (Array.isArray(payload.jumpHosts) && payload.jumpHosts.length > 0)
      || (payload.tunnelViaHostSsh === true && payload.sshTunnelConfig);

    if (needsTunnel) {
      const tunnelId = `rd-sys-${crypto.randomUUID()}`;
      const sshCfg = payload.sshTunnelConfig || {};
      const jumpHosts = Array.isArray(payload.jumpHosts) ? payload.jumpHosts : [];
      let pfPayload;
      if (payload.tunnelViaHostSsh === true && payload.sshTunnelConfig) {
        pfPayload = {
          tunnelId,
          type: "local",
          bindAddress: "127.0.0.1",
          localPort: 0,
          remoteHost: payload.tunnelTargetHost || "127.0.0.1",
          remotePort: targetPort,
          hostname: sshCfg.hostname || targetHost,
          port: sshCfg.port || 22,
          username: sshCfg.username || "root",
          authMethod: sshCfg.authMethod,
          password: sshCfg.password,
          privateKey: sshCfg.privateKey,
          passphrase: sshCfg.passphrase,
          certificate: sshCfg.certificate,
          keyId: sshCfg.keyId,
          useSshAgent: sshCfg.useSshAgent,
          identityAgent: sshCfg.identityAgent,
          identityFilePaths: sshCfg.identityFilePaths,
          identitiesOnly: sshCfg.identitiesOnly,
          addKeysToAgent: sshCfg.addKeysToAgent,
          useKeychain: sshCfg.useKeychain,
          proxy: sshCfg.proxy || payload.proxy,
          jumpHosts: sshCfg.jumpHosts || jumpHosts,
          knownHosts: payload.knownHosts || sshCfg.knownHosts,
          verifyHostKeys: payload.verifyHostKeys ?? sshCfg.verifyHostKeys,
        };
      } else {
        // Use the last jump host as the SSH forwarder to the final VNC/RDP target.
        const lastJump = jumpHosts[jumpHosts.length - 1];
        const priorJumps = jumpHosts.slice(0, -1);
        pfPayload = {
          tunnelId,
          type: "local",
          bindAddress: "127.0.0.1",
          localPort: 0,
          remoteHost: targetHost,
          remotePort: targetPort,
          hostname: lastJump.hostname,
          port: lastJump.port || 22,
          username: lastJump.username || "root",
          authMethod: lastJump.authMethod,
          password: lastJump.password,
          privateKey: lastJump.privateKey,
          passphrase: lastJump.passphrase,
          certificate: lastJump.certificate,
          keyId: lastJump.keyId,
          useSshAgent: lastJump.useSshAgent,
          identityAgent: lastJump.identityAgent,
          identityFilePaths: lastJump.identityFilePaths,
          identitiesOnly: lastJump.identitiesOnly,
          addKeysToAgent: lastJump.addKeysToAgent,
          useKeychain: lastJump.useKeychain,
          proxy: lastJump.proxy || payload.proxy,
          jumpHosts: priorJumps,
          knownHosts: payload.knownHosts,
          verifyHostKeys: payload.verifyHostKeys,
        };
      }

      const pfResult = terminalWorkerManager
        ? await terminalWorkerManager.request("netcatty:portforward:start", pfPayload, {
            webContentsId: event?.sender?.id,
          })
        : await portForwardingBridge?.startPortForward?.(event, pfPayload);

      if (!pfResult?.success || !Number.isFinite(pfResult.localPort)) {
        return {
          ok: false,
          error: pfResult?.error || "Failed to start ephemeral SSH tunnel for system client",
        };
      }
      ephemeralTunnelId = tunnelId;
      ephemeralSystemTunnels.add(tunnelId);
      targetHost = "127.0.0.1";
      targetPort = pfResult.localPort;
    }

    if (protocol === "rdp") {
      if (!tempDirBridge?.getTempFilePath) {
        return { ok: false, error: "Temporary directory bridge is unavailable" };
      }
      const rawContent = typeof payload.rdpContent === "string" && payload.rdpContent.trim()
        ? (ephemeralTunnelId ? rewriteRdpFullAddress(payload.rdpContent, targetHost, targetPort) : payload.rdpContent)
        : buildDefaultRdpFileContent({
            host: targetHost,
            port: targetPort,
            username: payload.username,
            domain: payload.domain,
            loadBalanceInfo: payload.loadBalanceInfo,
            alternateShell: payload.alternateShell,
            shellWorkingDir: payload.shellWorkingDir,
            audioEnabled: payload.audioEnabled,
            clipboardSync: payload.clipboardSync,
          });
      const labelSlug = String(payload.label || targetHost || "remote")
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .slice(0, 64);
      const rdpPath = tempDirBridge.getTempFilePath(`${labelSlug}.rdp`);
      await fsImpl.promises.writeFile(rdpPath, rawContent, { encoding: "utf8", mode: 0o600 });
      const openErr = await shell.openPath(rdpPath);
      if (openErr) {
        return { ok: false, error: openErr, filePath: rdpPath, tunnelId: ephemeralTunnelId };
      }
      return { ok: true, filePath: rdpPath, tunnelId: ephemeralTunnelId };
    }

    // VNC system client (macOS Screen Sharing / OS vnc:// handler)
    const vncUrl = buildSystemVncUrl(targetHost, targetPort, payload.username);
    await shell.openExternal(vncUrl);
    return { ok: true, url: vncUrl, tunnelId: ephemeralTunnelId };
  });

  ipcMain.handle("netcatty:remote-desktop:stop-system-tunnel", async (event, payload = {}) => {
    const tunnelId = typeof payload === "string" ? payload : payload?.tunnelId;
    if (!tunnelId || !ephemeralSystemTunnels.has(tunnelId)) {
      return { ok: false };
    }
    ephemeralSystemTunnels.delete(tunnelId);
    if (terminalWorkerManager) {
      return terminalWorkerManager.request("netcatty:portforward:stop", { tunnelId }, {
        webContentsId: event?.sender?.id,
      });
    }
    return portForwardingBridge?.stopPortForward?.(event, { tunnelId }) || { ok: true };
  });

  const rdpdrHandlers = registerRdpdrHandlers(ipcMain, {
    electronModule,
    fsImpl,
    pathImpl,
  });

  const cleanupMainOsResources = async () => {
    for (const [, entry] of [...activeClipboardWriteStreams]) {
      try { await entry.handle.close(); } catch { /* ignore */ }
    }
    activeClipboardWriteStreams.clear();
    ephemeralSystemTunnels.clear();
    try { await rdpdrHandlers.cleanupAll(); } catch { /* ignore */ }
  };

  return { cleanupMainOsResources, rdpdrBridge: rdpdrHandlers.bridge };
}

// ── Default Singleton Service + IPC Registration ──

const defaultService = createRemoteDesktopService();

function registerHandlers(ipcMain, options = {}) {
  const terminalWorkerManager = options.terminalWorkerManager || null;

  if (terminalWorkerManager) {
    const {
      ensureMacLocalNetworkAccess,
      attachMacLocalNetworkProbeResult,
    } = require("./macLocalNetworkAccess.cjs");

    const trackedOwners = new WeakSet();
    const trackOwnerLifecycle = (sender) => {
      if (!sender || !Number.isSafeInteger(sender.id) || trackedOwners.has(sender)) return;
      trackedOwners.add(sender);
      const webContentsId = sender.id;
      sender.once?.("destroyed", () => {
        void terminalWorkerManager.request(
          "netcatty:remote-desktop:stop-owner",
          { webContentsId },
          { webContentsId },
        ).catch(() => {});
      });
    };

    const prepareMacProbedPayload = async (payload) => {
      const basePayload = payload && typeof payload === "object" ? payload : {};
      const hasCompanionSsh =
        basePayload.tunnelViaHostSsh === true
        && basePayload.sshTunnelConfig
        && typeof basePayload.sshTunnelConfig === "object";
      const probeTarget = hasCompanionSsh ? basePayload.sshTunnelConfig : basePayload;
      const probeResult = await ensureMacLocalNetworkAccess(probeTarget);
      if (hasCompanionSsh) {
        return {
          ...basePayload,
          sshTunnelConfig: {
            ...attachMacLocalNetworkProbeResult(basePayload.sshTunnelConfig, probeResult),
            _macLocalNetworkMainProbed: true,
          },
          _macLocalNetworkMainProbed: true,
        };
      }
      return {
        ...attachMacLocalNetworkProbeResult(basePayload, probeResult),
        _macLocalNetworkMainProbed: true,
      };
    };

    ipcMain.handle("netcatty:remote-desktop:start", async (event, payload) => {
      trackOwnerLifecycle(event?.sender);
      // macOS TN3179: probe LAN access from the main process before forwarding to utilityProcess.
      const workerPayload = await prepareMacProbedPayload(payload);
      return terminalWorkerManager.request("netcatty:remote-desktop:start", workerPayload, {
        webContentsId: event?.sender?.id,
      });
    });

    ipcMain.handle("netcatty:remote-desktop:test", async (event, payload) => {
      trackOwnerLifecycle(event?.sender);
      // macOS TN3179: probe LAN access (using sshTunnelConfig for companion tunnels) before worker dispatch.
      const workerPayload = await prepareMacProbedPayload(payload);
      return terminalWorkerManager.request("netcatty:remote-desktop:test", workerPayload, {
        webContentsId: event?.sender?.id,
      });
    });

    ipcMain.handle("netcatty:remote-desktop:test:cancel", (event, payload) => (
      terminalWorkerManager.request("netcatty:remote-desktop:test:cancel", payload, {
        webContentsId: event?.sender?.id,
      })
    ));

    ipcMain.handle("netcatty:remote-desktop:stop", (event, payload) => (
      terminalWorkerManager.request("netcatty:remote-desktop:stop", payload, {
        webContentsId: event?.sender?.id,
      })
    ));

    ipcMain.handle("netcatty:remote-desktop:cert-decision", (event, payload) => (
      terminalWorkerManager.request("netcatty:remote-desktop:cert-decision", payload, {
        webContentsId: event?.sender?.id,
      })
    ));

    ipcMain.handle("netcatty:remote-desktop:stop-owner", (event, payload) => (
      terminalWorkerManager.request("netcatty:remote-desktop:stop-owner", payload, {
        webContentsId: event?.sender?.id,
      })
    ));

    ipcMain.handle("netcatty:remote-desktop:stopAll", () => (
      terminalWorkerManager.request("netcatty:remote-desktop:stopAll", {}, {})
    ));

    if (options.registerOsHandlers !== false) {
      return registerMainOsHandlers(ipcMain, options);
    }
    return null;
  }

  // Worker process or main-process fallback (when NETCATTY_TERMINAL_WORKER=0)
  const trackedOwners = new WeakSet();
  ipcMain.handle("netcatty:remote-desktop:start", async (event, payload) => {
    const sender = event?.sender;
    if (sender && typeof sender.once === "function" && !trackedOwners.has(sender)) {
      trackedOwners.add(sender);
      const webContentsId = sender.id;
      sender.once("destroyed", () => {
        defaultService.stopOwnerSessions(null, { webContentsId });
      });
    }
    return defaultService.startSession(event, payload);
  });
  ipcMain.handle("netcatty:remote-desktop:stop", (event, payload) => defaultService.stopSession(event, payload));
  ipcMain.handle("netcatty:remote-desktop:cert-decision", (event, payload) => defaultService.respondCertDecision(event, payload));
  ipcMain.handle("netcatty:remote-desktop:test", (event, payload) => defaultService.testConnection(event, payload));
  ipcMain.handle("netcatty:remote-desktop:test:cancel", (event, payload) => defaultService.cancelTestConnection(event, payload));
  ipcMain.handle("netcatty:remote-desktop:stop-owner", (event, payload) => defaultService.stopOwnerSessions(event, payload));
  ipcMain.handle("netcatty:remote-desktop:stopAll", () => defaultService.stopAll());

  if (options.registerOsHandlers === true) {
    return registerMainOsHandlers(ipcMain, options);
  }
  return null;
}

module.exports = {
  VNC_S2C,
  VNC_C2S,
  buildPreferredVncSecurity,
  isAllowedLoopbackOrigin,
  timingSafeTokenEquals,
  encodeVncJsonFrame,
  encodeVncRawRgbaFrame,
  encodeVncCopyRectFrame,
  encodeVncJpegFrame,
  encodeVncCursorFrame,
  encodeVncDesktopSizeFrame,
  encodeVncTextFrame,
  dispatchVncClientMessage,
  defaultDialRemoteDesktop,
  attachVncSessionToWebSocket,
  createRemoteDesktopService,
  buildDefaultRdpFileContent,
  rewriteRdpFullAddress,
  buildSystemVncUrl,
  registerHandlers,
  registerMainOsHandlers,
  startSession: (...args) => defaultService.startSession(...args),
  stopSession: (...args) => defaultService.stopSession(...args),
  respondCertDecision: (...args) => defaultService.respondCertDecision(...args),
  testConnection: (...args) => defaultService.testConnection(...args),
  cancelTestConnection: (...args) => defaultService.cancelTestConnection(...args),
  stopOwnerSessions: (...args) => defaultService.stopOwnerSessions(...args),
  stopAll: (...args) => defaultService.stopAll(...args),
  computeCertSha256Fingerprint,
};
