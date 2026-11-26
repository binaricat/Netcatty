"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const { performance } = require("node:perf_hooks");
const tls = require("node:tls");

// Matches Devolutions/IronRDP crates/ironrdp-rdcleanpath/src/lib.rs
const RDCLEANPATH_BASE_VERSION = 3389;
const RDCLEANPATH_VERSION_1 = RDCLEANPATH_BASE_VERSION + 1; // 3390

const GENERAL_ERROR_CODE = 1;
const NEGOTIATION_ERROR_CODE = 2;
const EXPIRED_ERROR_CODE = 100;
const NOT_YET_VALID_ERROR_CODE = 101;
const REVOKED_ERROR_CODE = 102;
const TARGET_UNREACHABLE_ERROR_CODE = 103;
const DNS_RESOLUTION_FAILED_ERROR_CODE = 104;
const TLS_HANDSHAKE_FAILED_ERROR_CODE = 105;

const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_UTF8_STRING = 0x0c;
const TAG_SEQUENCE = 0x30;

// ── ASN.1 DER Primitives ──

function encodeDerLength(length) {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(`Invalid DER length: ${length}`);
  }
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function encodeDerTlv(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), encodeDerLength(body.length), body]);
}

function encodeDerInteger(value) {
  const big = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  if (big < 0n) {
    throw new RangeError("RDCleanPath DER integers must be non-negative");
  }
  if (big === 0n) {
    return encodeDerTlv(TAG_INTEGER, Buffer.from([0x00]));
  }
  const bytes = [];
  let remaining = big;
  while (remaining > 0n) {
    bytes.unshift(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
  if ((bytes[0] & 0x80) !== 0) {
    bytes.unshift(0x00);
  }
  return encodeDerTlv(TAG_INTEGER, Buffer.from(bytes));
}

function encodeDerOctetString(buf) {
  return encodeDerTlv(TAG_OCTET_STRING, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
}

function encodeDerUtf8String(str) {
  return encodeDerTlv(TAG_UTF8_STRING, Buffer.from(String(str), "utf8"));
}

function encodeDerSequence(items) {
  return encodeDerTlv(TAG_SEQUENCE, Buffer.concat(items));
}

function encodeDerExplicit(contextTag, innerDer) {
  if (!Number.isInteger(contextTag) || contextTag < 0 || contextTag > 30) {
    throw new RangeError(`Invalid ASN.1 context tag: ${contextTag}`);
  }
  return encodeDerTlv(0xa0 | contextTag, innerDer);
}

function readDerTlv(buf, offset = 0) {
  if (!Buffer.isBuffer(buf)) {
    buf = Buffer.from(buf);
  }
  if (offset >= buf.length) {
    throw new Error("Unexpected end of DER input");
  }
  const tag = buf[offset];
  let pos = offset + 1;
  if (pos >= buf.length) {
    throw new Error("Truncated DER length");
  }
  const firstLen = buf[pos++];
  if (firstLen === 0x80) {
    throw new Error("Indefinite DER length is not supported");
  }
  let length = 0;
  if ((firstLen & 0x80) === 0) {
    length = firstLen;
  } else {
    const numOctets = firstLen & 0x7f;
    if (numOctets === 0 || numOctets > 4) {
      throw new Error(`Unsupported DER length octet count: ${numOctets}`);
    }
    if (pos + numOctets > buf.length) {
      throw new Error("Truncated DER long-form length");
    }
    for (let i = 0; i < numOctets; i += 1) {
      length = length * 256 + buf[pos++];
    }
  }
  if (pos + length > buf.length) {
    throw new Error(`DER value length ${length} exceeds remaining bytes ${buf.length - pos}`);
  }
  return {
    tag,
    content: buf.subarray(pos, pos + length),
    nextOffset: pos + length,
  };
}

function decodeDerInteger(buf) {
  const tlv = readDerTlv(buf, 0);
  if (tlv.tag !== TAG_INTEGER || tlv.content.length === 0) {
    throw new Error(`Expected DER INTEGER (0x02), got 0x${tlv.tag.toString(16)}`);
  }
  if ((tlv.content[0] & 0x80) !== 0) {
    throw new Error("Unexpected negative DER INTEGER in RDCleanPathPdu");
  }
  let value = 0;
  for (let i = 0; i < tlv.content.length; i += 1) {
    value = value * 256 + tlv.content[i];
  }
  return value;
}

function decodeDerUtf8String(buf) {
  const tlv = readDerTlv(buf, 0);
  if (tlv.tag !== TAG_UTF8_STRING) {
    throw new Error(`Expected DER UTF8String (0x0c), got 0x${tlv.tag.toString(16)}`);
  }
  return tlv.content.toString("utf8");
}

function decodeDerOctetString(buf) {
  const tlv = readDerTlv(buf, 0);
  if (tlv.tag !== TAG_OCTET_STRING) {
    throw new Error(`Expected DER OCTET STRING (0x04), got 0x${tlv.tag.toString(16)}`);
  }
  return Buffer.from(tlv.content);
}

function decodeDerSequenceOfOctetStrings(buf) {
  const seq = readDerTlv(buf, 0);
  if (seq.tag !== TAG_SEQUENCE) {
    throw new Error(`Expected DER SEQUENCE (0x30), got 0x${seq.tag.toString(16)}`);
  }
  const result = [];
  let offset = 0;
  while (offset < seq.content.length) {
    const item = readDerTlv(seq.content, offset);
    if (item.tag !== TAG_OCTET_STRING) {
      throw new Error(`Expected OCTET STRING inside cert chain, got 0x${item.tag.toString(16)}`);
    }
    result.push(Buffer.from(item.content));
    offset = item.nextOffset;
  }
  return result;
}

function decodeRDCleanPathErr(buf) {
  const seq = readDerTlv(buf, 0);
  if (seq.tag !== TAG_SEQUENCE) {
    throw new Error(`Expected RDCleanPathErr SEQUENCE, got 0x${seq.tag.toString(16)}`);
  }
  const err = {};
  let offset = 0;
  while (offset < seq.content.length) {
    const field = readDerTlv(seq.content, offset);
    offset = field.nextOffset;
    if (field.tag === 0xa0) {
      err.errorCode = decodeDerInteger(field.content);
    } else if (field.tag === 0xa1) {
      err.httpStatusCode = decodeDerInteger(field.content);
    } else if (field.tag === 0xa2) {
      err.wsaLastError = decodeDerInteger(field.content);
    } else if (field.tag === 0xa3) {
      err.tlsAlertCode = decodeDerInteger(field.content);
    }
  }
  return err;
}

/**
 * Decode an ASN.1 DER encoded `RDCleanPathPdu`.
 */
function decodeRDCleanPathPdu(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const outer = readDerTlv(buf, 0);
  if (outer.tag !== TAG_SEQUENCE) {
    throw new Error(`Expected RDCleanPathPdu SEQUENCE (0x30), got 0x${outer.tag.toString(16)}`);
  }

  const pdu = {
    version: null,
    error: undefined,
    destination: undefined,
    proxyAuth: undefined,
    serverAuth: undefined,
    preconnectionBlob: undefined,
    x224ConnectionPdu: undefined,
    serverCertChain: undefined,
    serverAddr: undefined,
  };

  let offset = 0;
  while (offset < outer.content.length) {
    const field = readDerTlv(outer.content, offset);
    offset = field.nextOffset;
    switch (field.tag) {
      case 0xa0:
        pdu.version = decodeDerInteger(field.content);
        break;
      case 0xa1:
        pdu.error = decodeRDCleanPathErr(field.content);
        break;
      case 0xa2:
        pdu.destination = decodeDerUtf8String(field.content);
        break;
      case 0xa3:
        pdu.proxyAuth = decodeDerUtf8String(field.content);
        break;
      case 0xa4:
        pdu.serverAuth = decodeDerUtf8String(field.content);
        break;
      case 0xa5:
        pdu.preconnectionBlob = decodeDerUtf8String(field.content);
        break;
      case 0xa6:
        pdu.x224ConnectionPdu = decodeDerOctetString(field.content);
        break;
      case 0xa7:
        pdu.serverCertChain = decodeDerSequenceOfOctetStrings(field.content);
        break;
      case 0xa9:
        pdu.serverAddr = decodeDerUtf8String(field.content);
        break;
      default:
        // Ignore reserved / unknown optional tags if encountered.
        break;
    }
  }

  if (pdu.version !== RDCLEANPATH_VERSION_1) {
    throw new Error(`Unsupported RDCleanPathPdu version: ${pdu.version} (expected ${RDCLEANPATH_VERSION_1})`);
  }
  return pdu;
}

/**
 * Encode an `RDCleanPathPdu` request (useful for tests & diagnostics).
 */
function encodeRDCleanPathRequest({
  version = RDCLEANPATH_VERSION_1,
  destination,
  proxyAuth,
  serverAuth,
  preconnectionBlob,
  x224ConnectionPdu,
} = {}) {
  const fields = [encodeDerExplicit(0, encodeDerInteger(version))];
  if (destination !== undefined && destination !== null) {
    fields.push(encodeDerExplicit(2, encodeDerUtf8String(destination)));
  }
  if (proxyAuth !== undefined && proxyAuth !== null) {
    fields.push(encodeDerExplicit(3, encodeDerUtf8String(proxyAuth)));
  }
  if (serverAuth !== undefined && serverAuth !== null) {
    fields.push(encodeDerExplicit(4, encodeDerUtf8String(serverAuth)));
  }
  if (preconnectionBlob !== undefined && preconnectionBlob !== null) {
    fields.push(encodeDerExplicit(5, encodeDerUtf8String(preconnectionBlob)));
  }
  if (x224ConnectionPdu !== undefined && x224ConnectionPdu !== null) {
    fields.push(encodeDerExplicit(6, encodeDerOctetString(x224ConnectionPdu)));
  }
  return encodeDerSequence(fields);
}

/**
 * Encode an `RDCleanPathPdu` response sent from proxy -> IronRDP WASM client.
 */
function encodeRDCleanPathResponse({
  version = RDCLEANPATH_VERSION_1,
  x224ConnectionPdu,
  serverCertChain,
  serverAddr,
} = {}) {
  const fields = [encodeDerExplicit(0, encodeDerInteger(version))];
  if (x224ConnectionPdu !== undefined && x224ConnectionPdu !== null) {
    fields.push(encodeDerExplicit(6, encodeDerOctetString(x224ConnectionPdu)));
  }
  if (Array.isArray(serverCertChain)) {
    const certItems = serverCertChain.map((der) => encodeDerOctetString(der));
    fields.push(encodeDerExplicit(7, encodeDerSequence(certItems)));
  }
  if (serverAddr !== undefined && serverAddr !== null) {
    fields.push(encodeDerExplicit(9, encodeDerUtf8String(serverAddr)));
  }
  return encodeDerSequence(fields);
}

/**
 * Encode an `RDCleanPathPdu` error response sent from proxy -> IronRDP WASM client.
 */
function encodeRDCleanPathError({
  version = RDCLEANPATH_VERSION_1,
  errorCode = GENERAL_ERROR_CODE,
  httpStatusCode,
  wsaLastError,
  tlsAlertCode,
} = {}) {
  const errFields = [encodeDerExplicit(0, encodeDerInteger(errorCode))];
  if (Number.isInteger(httpStatusCode)) {
    errFields.push(encodeDerExplicit(1, encodeDerInteger(httpStatusCode)));
  }
  if (Number.isInteger(wsaLastError)) {
    errFields.push(encodeDerExplicit(2, encodeDerInteger(wsaLastError)));
  }
  if (Number.isInteger(tlsAlertCode)) {
    errFields.push(encodeDerExplicit(3, encodeDerInteger(tlsAlertCode)));
  }
  return encodeDerSequence([
    encodeDerExplicit(0, encodeDerInteger(version)),
    encodeDerExplicit(1, encodeDerSequence(errFields)),
  ]);
}

// ── Certificate Extraction & SHA-256 Fingerprinting ──

function computeCertSha256Fingerprint(derBuffer) {
  if (!derBuffer || derBuffer.length === 0) return "";
  const hex = crypto.createHash("sha256").update(derBuffer).digest("hex").toUpperCase();
  const pairs = [];
  for (let i = 0; i < hex.length; i += 2) {
    pairs.push(hex.slice(i, i + 2));
  }
  return pairs.join(":");
}

function formatDistinguishedName(dn) {
  if (!dn || typeof dn !== "object") return "";
  const order = ["CN", "OU", "O", "L", "ST", "C"];
  const parts = [];
  const seen = new Set();
  for (const key of order) {
    if (dn[key] !== undefined) {
      const val = Array.isArray(dn[key]) ? dn[key].join(", ") : String(dn[key]);
      parts.push(`${key}=${val}`);
      seen.add(key);
    }
  }
  for (const [key, rawVal] of Object.entries(dn)) {
    if (seen.has(key) || rawVal === undefined) continue;
    const val = Array.isArray(rawVal) ? rawVal.join(", ") : String(rawVal);
    parts.push(`${key}=${val}`);
  }
  return parts.join(", ");
}

function extractPeerCertInfo(tlsSocket) {
  if (!tlsSocket || typeof tlsSocket.getPeerCertificate !== "function") {
    return null;
  }
  const leaf = tlsSocket.getPeerCertificate(true);
  if (!leaf || !leaf.raw || leaf.raw.length === 0) {
    return null;
  }

  const certChainDer = [];
  const seenFingerprints = new Set();
  let current = leaf;
  // Walk issuer chain up to a safe depth, stopping on self-signed cycle.
  for (let depth = 0; depth < 16 && current && current.raw && current.raw.length > 0; depth += 1) {
    const raw = Buffer.from(current.raw);
    const fp = computeCertSha256Fingerprint(raw);
    if (seenFingerprints.has(fp)) break;
    seenFingerprints.add(fp);
    certChainDer.push(raw);
    if (!current.issuerCertificate || current.issuerCertificate === current) break;
    current = current.issuerCertificate;
  }

  const fingerprintSha256 = computeCertSha256Fingerprint(certChainDer[0]);
  return {
    certChainDer,
    fingerprintSha256,
    subject: formatDistinguishedName(leaf.subject),
    issuer: formatDistinguishedName(leaf.issuer),
    validFrom: typeof leaf.valid_from === "string" ? leaf.valid_from : "",
    validTo: typeof leaf.valid_to === "string" ? leaf.valid_to : "",
    serialNumber: typeof leaf.serialNumber === "string" ? leaf.serialNumber : "",
    subjectAltName: typeof leaf.subjectaltname === "string" ? leaf.subjectaltname : "",
  };
}

// ── X.224 TPKT Framing Helpers ──

function readTpktPacket(socket, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buf = Buffer.alloc(0);
    let timer = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      socket.removeListener("end", onEnd);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const succeed = (packet) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(packet);
    };

    const onError = (err) => fail(err);
    const onClose = () => fail(new Error("Upstream RDP socket closed during X.224 handshake"));
    const onEnd = () => fail(new Error("Upstream RDP socket ended during X.224 handshake"));

    const onData = (chunk) => {
      buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      if (buf[0] !== 0x03) {
        fail(new Error(`Invalid TPKT version byte: 0x${buf[0].toString(16)}`));
        return;
      }
      const totalLen = buf.readUInt16BE(2);
      if (totalLen < 4 || totalLen > 65535) {
        fail(new Error(`Invalid TPKT packet length: ${totalLen}`));
        return;
      }
      if (buf.length < totalLen) return;
      const packet = Buffer.from(buf.subarray(0, totalLen));
      const trailing = buf.subarray(totalLen);
      if (trailing.length > 0 && typeof socket.unshift === "function") {
        socket.pause?.();
        socket.unshift(Buffer.from(trailing));
      }
      succeed(packet);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        fail(new Error(`Timed out waiting for X.224 Connection Confirm (${timeoutMs}ms)`));
      }, timeoutMs);
      timer.unref?.();
    }

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.on("end", onEnd);
    socket.resume?.();
  });
}

/**
 * Inspect X.224 Connection Confirm TPKT to determine whether TLS was negotiated.
 * TPKT (4 bytes) + X.224 CC fixed header (7 bytes) = 11 bytes, followed by
 * optional 8-byte RDP_NEG_RSP (type 0x02) or RDP_NEG_FAILURE (type 0x03).
 */
function parseX224ConfirmNegotiation(tpktBuf) {
  if (!Buffer.isBuffer(tpktBuf) || tpktBuf.length < 11) {
    return { isConfirm: false, requiresTls: true, selectedProtocol: null, failureCode: null };
  }
  const tpduCode = tpktBuf[5] & 0xf0;
  if (tpduCode !== 0xd0) {
    return { isConfirm: false, requiresTls: true, selectedProtocol: null, failureCode: null };
  }
  if (tpktBuf.length >= 19) {
    const negType = tpktBuf[11];
    if (negType === 0x02) {
      // TYPE_RDP_NEG_RSP
      const selectedProtocol = tpktBuf.readUInt32LE(15);
      // 0x00 = PROTOCOL_RDP (Standard RDP Security, no TLS)
      // 0x01 = PROTOCOL_SSL (TLS)
      // 0x02 = PROTOCOL_HYBRID (CredSSP / NLA over TLS)
      // 0x04 = PROTOCOL_RDSTLS
      // 0x08 = PROTOCOL_HYBRID_EX (CredSSP + Early User Auth Result over TLS)
      return {
        isConfirm: true,
        requiresTls: selectedProtocol !== 0,
        selectedProtocol,
        failureCode: null,
      };
    }
    if (negType === 0x03) {
      // TYPE_RDP_NEG_FAILURE
      const failureCode = tpktBuf.readUInt32LE(15);
      return {
        isConfirm: true,
        requiresTls: false,
        selectedProtocol: null,
        failureCode,
      };
    }
  }
  // No RDP_NEG_RSP present -> legacy Standard RDP security (no TLS)
  return { isConfirm: true, requiresTls: false, selectedProtocol: 0, failureCode: null };
}

function encodePreconnectionPduV2(pcbString) {
  const utf16 = Buffer.from(`${pcbString}\0`, "utf16le");
  const headerLen = 16;
  const totalLen = headerLen + utf16.length;
  const header = Buffer.alloc(headerLen);
  header.writeUInt32LE(totalLen, 0); // cbSize
  header.writeUInt32LE(0, 4); // Flags
  header.writeUInt32LE(2, 8); // Version = 2
  header.writeUInt32LE(0, 12); // Id
  // Spec: cchPCB (uint16 LE) follows Version/Id in V2 at offset 12..14?
  // Per [MS-RDPBCGR] 2.2.1.1.1:
  // V1: cbSize(4), Flags(4), Version(4), Id(4) = 16 bytes
  // V2: V1(16) + cchPCB(2) + wszPCB(cchPCB * 2)
  const v2 = Buffer.alloc(18 + utf16.length);
  v2.writeUInt32LE(v2.length, 0);
  v2.writeUInt32LE(0, 4);
  v2.writeUInt32LE(2, 8);
  v2.writeUInt32LE(0, 12);
  v2.writeUInt16LE(utf16.length / 2, 16);
  utf16.copy(v2, 18);
  return v2;
}

function waitForFirstWsMessage(ws, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      ws.removeListener("message", onMessage);
      ws.removeListener("close", onClose);
      ws.removeListener("error", onError);
    };
    const onMessage = (data) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.isBuffer(data) ? data : Buffer.from(data));
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("WebSocket closed before RDCleanPath request arrived"));
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Timed out waiting for RDCleanPath request"));
      }, timeoutMs);
      timer.unref?.();
    }
    ws.once("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

// Windows 10/11/Server default self-signed RDP certificates set Key Usage to
// `keyEncipherment` only (no `digitalSignature`). Electron's BoringSSL rejects
// TLS 1.3 and TLS 1.2 ECDHE handshakes against such certs with
// `KEY_USAGE_BIT_INCORRECT`, whereas TLS 1.2 RSA key exchange (`kRSA`) matches
// the `keyEncipherment` bit cleanly.
const WINDOWS_RDP_KRSA_CIPHERS =
  "AES256-GCM-SHA384:AES128-GCM-SHA256:AES256-SHA256:AES128-SHA256:AES256-SHA:AES128-SHA";

function isBoringSslKeyUsageError(err) {
  if (!err) return false;
  if (typeof err.reason === "string" && /KEY_USAGE_BIT_INCORRECT/i.test(err.reason)) {
    return true;
  }
  const msg = typeof err.message === "string" ? err.message : String(err);
  return /KEY_USAGE_BIT_INCORRECT/i.test(msg);
}

function connectTlsWithCipherFallback(baseOpts, allowLegacyTls, preferRsaKeyExchange) {
  if (preferRsaKeyExchange) {
    return tls.connect({
      ...baseOpts,
      minVersion: allowLegacyTls ? "TLSv1" : "TLSv1.2",
      maxVersion: "TLSv1.2",
      ciphers: WINDOWS_RDP_KRSA_CIPHERS,
    });
  }
  if (!allowLegacyTls) {
    return tls.connect({
      ...baseOpts,
      minVersion: "TLSv1.2",
    });
  }
  try {
    return tls.connect({
      ...baseOpts,
      minVersion: "TLSv1",
      ciphers: "DEFAULT:@SECLEVEL=0",
    });
  } catch (err) {
    // BoringSSL does not support OpenSSL's `@SECLEVEL=0` cipher directive.
    if (err?.code === "ERR_SSL_INVALID_COMMAND" || /INVALID_COMMAND/i.test(err?.message || "")) {
      return tls.connect({
        ...baseOpts,
        minVersion: "TLSv1",
        ciphers: "ALL:!aNULL:!eNULL",
      });
    }
    throw err;
  }
}

function upgradeToTls(
  socket,
  { host, allowLegacyTls = false, preferRsaKeyExchange = false, timeoutMs = 15_000 },
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const baseOpts = {
      socket,
      rejectUnauthorized: false,
      ...(host && net.isIP(host) === 0 ? { servername: host } : {}),
    };

    let tlsSocket;
    try {
      tlsSocket = connectTlsWithCipherFallback(baseOpts, allowLegacyTls, preferRsaKeyExchange);
    } catch (err) {
      reject(err);
      return;
    }

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      tlsSocket.removeListener("secureConnect", onSecureConnect);
      tlsSocket.removeListener("error", onError);
      tlsSocket.removeListener("close", onClose);
    };

    const onSecureConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(tlsSocket);
    };

    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { tlsSocket.destroy(); } catch { /* ignore */ }
      reject(err);
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("TLS socket closed during handshake"));
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        try { tlsSocket.destroy(); } catch { /* ignore */ }
        reject(new Error(`RDP TLS handshake timed out (${timeoutMs}ms)`));
      }, timeoutMs);
      timer.unref?.();
    }

    tlsSocket.once("secureConnect", onSecureConnect);
    tlsSocket.once("error", onError);
    tlsSocket.once("close", onClose);
  });
}

/**
 * Lightweight, non-intrusive TCP connect-and-immediately-destroy RTT probe.
 * Never rejects; returns RTT in ms or null on failure/timeout/cancel.
 */
function probeTcpConnectRtt(host, port, timeoutMs = 3000) {
  let settled = false;
  let timer = null;
  let sock = null;
  let resolvePromise;

  const finish = (value) => {
    if (settled) return;
    settled = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try { sock?.destroy?.(); } catch { /* ignore */ }
    sock = null;
    resolvePromise(value);
  };

  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
    if (!host || !port) {
      settled = true;
      resolve(null);
      return;
    }
    const start = performance.now();
    try {
      sock = net.connect({ host, port });
    } catch {
      finish(null);
      return;
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref?.();
    }
    sock.once("connect", () => {
      const elapsed = performance.now() - start;
      finish(Number.isFinite(elapsed) ? Math.max(0, elapsed) : null);
    });
    sock.once("error", () => finish(null));
    sock.once("close", () => finish(null));
  });

  return {
    promise,
    cancel: () => finish(null),
  };
}

/**
 * Run an RDCleanPath proxy session over an authenticated WebSocket.
 *
 * @param {object} options
 * @param {import('ws').WebSocket} options.ws
 * @param {string} options.host Target RDP hostname/IP
 * @param {number} options.port Target RDP port
 * @param {() => Promise<{ stream: import('node:stream').Duplex, serverAddr?: string, cleanup?: () => void }>} options.dial
 * @param {(certInfo: object) => Promise<{ accepted: boolean, reason?: string }>} [options.verifyCertificate]
 * @param {boolean} [options.allowLegacyTls]
 * @param {number} [options.handshakeTimeoutMs]
 * @param {AbortSignal} [options.signal]
 * @param {(stage: string, detail?: object) => void} [options.onStatus]
 * @param {(stats: { protocol: string, rttMs: number | null, rxBps: number, txBps: number, totalRxBytes: number, totalTxBytes: number, ts: number }) => void} [options.onStats]
 * @param {boolean} [options.isDirectConnection]
 * @param {number} [options.statsIntervalMs]
 * @param {number} [options.rttProbeIntervalMs]
 * @param {number} [options.rttProbeTimeoutMs]
 */
async function handleRdpCleanPathConnection(options) {
  const {
    ws,
    host,
    port,
    dial,
    verifyCertificate,
    allowLegacyTls = false,
    handshakeTimeoutMs = 20_000,
    signal,
    onStatus,
    onStats,
    isDirectConnection = false,
    statsIntervalMs = 1500,
    rttProbeIntervalMs = 4000,
    rttProbeTimeoutMs = 3000,
  } = options;

  let upstream = null;
  let activeSocket = null;
  let cleanedUp = false;
  let statsTimer = null;
  let rttProbeTimer = null;
  let activeRttProbe = null;

  const stopTelemetryTimers = () => {
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
    if (rttProbeTimer) {
      clearInterval(rttProbeTimer);
      rttProbeTimer = null;
    }
    if (activeRttProbe) {
      try { activeRttProbe.cancel(); } catch { /* ignore */ }
      activeRttProbe = null;
    }
  };

  const sendErrorPdu = (errOpts) => {
    try {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(encodeRDCleanPathError(errOpts), { binary: true });
      }
    } catch {
      // ignore send errors during teardown
    }
  };

  const cleanup = () => {
    cleanedUp = true;
    stopTelemetryTimers();
    const sock = activeSocket;
    activeSocket = null;
    const up = upstream;
    upstream = null;
    try { sock?.destroy?.(); } catch { /* ignore */ }
    try { up?.stream?.destroy?.(); } catch { /* ignore */ }
    try { up?.cleanup?.(); } catch { /* ignore */ }
    try {
      if (ws.readyState === 0 || ws.readyState === 1) {
        ws.close();
      }
    } catch {
      // ignore
    }
  };

  const onAbort = () => cleanup();
  signal?.addEventListener?.("abort", onAbort, { once: true });

  try {
    // 1. Wait for initial RDCleanPathPdu request from IronRDP WASM client.
    const reqBuf = await waitForFirstWsMessage(ws, handshakeTimeoutMs);
    if (signal?.aborted) {
      cleanup();
      return;
    }

    let request;
    try {
      request = decodeRDCleanPathPdu(reqBuf);
    } catch (err) {
      sendErrorPdu({ errorCode: NEGOTIATION_ERROR_CODE });
      cleanup();
      throw err;
    }

    // 2 & 3. Dial upstream RDP target and perform X.224 Connection Request/Confirm.
    let initialRttMs = null;
    const dialAndNegotiate = async () => {
      onStatus?.("dialing");
      const dialStart = performance.now();
      let dialed;
      try {
        dialed = await dial();
      } catch (err) {
        const code = err?.code === "ENOTFOUND" || err?.code === "EAI_AGAIN"
          ? DNS_RESOLUTION_FAILED_ERROR_CODE
          : TARGET_UNREACHABLE_ERROR_CODE;
        sendErrorPdu({ errorCode: code });
        cleanup();
        throw err;
      }
      const dialElapsed = performance.now() - dialStart;

      upstream = dialed;
      if (cleanedUp || signal?.aborted || ws.readyState !== 1) {
        cleanup();
        return null;
      }

      const stream = dialed.stream;
      activeSocket = stream;
      stream.setNoDelay?.(true);

      onStatus?.("negotiating");
      if (request.preconnectionBlob) {
        if (request.x224ConnectionPdu) {
          stream.write(Buffer.from(request.preconnectionBlob, "utf8"));
        } else {
          stream.write(encodePreconnectionPduV2(request.preconnectionBlob));
        }
      }

      let confirm = null;
      let neg = { isConfirm: true, requiresTls: true, selectedProtocol: 1, failureCode: null };
      if (request.x224ConnectionPdu && request.x224ConnectionPdu.length > 0) {
        const x224Start = performance.now();
        stream.write(request.x224ConnectionPdu);
        confirm = await readTpktPacket(stream, handshakeTimeoutMs);
        const x224Elapsed = performance.now() - x224Start;
        initialRttMs = Math.max(0, x224Elapsed);
        neg = parseX224ConfirmNegotiation(confirm);
      } else if (Number.isFinite(dialElapsed)) {
        initialRttMs = Math.max(0, dialElapsed);
      }
      return { rawStream: stream, x224Confirm: confirm, negotiation: neg };
    };

    let negotiated = await dialAndNegotiate();
    if (!negotiated) return;
    let { rawStream, x224Confirm, negotiation } = negotiated;

    if (signal?.aborted || ws.readyState !== 1) {
      cleanup();
      return;
    }

    // If server returned RDP_NEG_FAILURE, forward x224Confirm with empty cert chain so
    // IronRDP WASM can interpret the exact RDP failure code (e.g. SSL_REQUIRED / HYB_REQUIRED).
    let certChainDer = [];
    if (negotiation.failureCode !== null) {
      const serverAddr = upstream.serverAddr
        || (rawStream.remoteAddress ? `${rawStream.remoteAddress}:${rawStream.remotePort || port}` : `${host}:${port}`);
      ws.send(
        encodeRDCleanPathResponse({
          x224ConnectionPdu: x224Confirm,
          serverCertChain: [],
          serverAddr,
        }),
        { binary: true },
      );
      cleanup();
      return;
    }

    // 4. Upgrade to TLS using Node built-in TLS (if negotiated).
    // On Electron (BoringSSL), Windows default self-signed RDP certs only carry
    // `keyEncipherment` (no `digitalSignature`), causing TLS 1.3 / ECDHE to fail
    // with KEY_USAGE_BIT_INCORRECT. Automatically redial once with TLS 1.2 kRSA.
    if (negotiation.requiresTls) {
      onStatus?.("tls-handshake");
      let tlsSocket;
      try {
        tlsSocket = await upgradeToTls(rawStream, {
          host,
          allowLegacyTls,
          timeoutMs: handshakeTimeoutMs,
        });
      } catch (err) {
        if (isBoringSslKeyUsageError(err) && !signal?.aborted && ws.readyState === 1) {
          try { rawStream?.destroy?.(); } catch { /* ignore */ }
          try { upstream?.cleanup?.(); } catch { /* ignore */ }
          upstream = null;
          activeSocket = null;
          negotiated = await dialAndNegotiate();
          if (!negotiated) return;
          ({ rawStream, x224Confirm, negotiation } = negotiated);
          if (negotiation.failureCode !== null) {
            const serverAddr = upstream.serverAddr
              || (rawStream.remoteAddress ? `${rawStream.remoteAddress}:${rawStream.remotePort || port}` : `${host}:${port}`);
            ws.send(
              encodeRDCleanPathResponse({
                x224ConnectionPdu: x224Confirm,
                serverCertChain: [],
                serverAddr,
              }),
              { binary: true },
            );
            cleanup();
            return;
          }
          try {
            tlsSocket = await upgradeToTls(rawStream, {
              host,
              allowLegacyTls,
              preferRsaKeyExchange: true,
              timeoutMs: handshakeTimeoutMs,
            });
          } catch (retryErr) {
            sendErrorPdu({ errorCode: TLS_HANDSHAKE_FAILED_ERROR_CODE });
            cleanup();
            throw retryErr;
          }
        } else {
          sendErrorPdu({ errorCode: TLS_HANDSHAKE_FAILED_ERROR_CODE });
          cleanup();
          throw err;
        }
      }
      activeSocket = tlsSocket;
      if (cleanedUp || signal?.aborted || ws.readyState !== 1) {
        cleanup();
        return;
      }

      // Guard tlsSocket against unhandled 'error' / premature 'close' while awaiting TOFU decision.
      let upstreamClosedDuringTofu = false;
      let upstreamErrorDuringTofu = null;
      const onTofuSocketError = (err) => {
        upstreamErrorDuringTofu = err;
        upstreamClosedDuringTofu = true;
      };
      const onTofuSocketClose = () => {
        upstreamClosedDuringTofu = true;
      };
      tlsSocket.on("error", onTofuSocketError);
      tlsSocket.once("close", onTofuSocketClose);

      try {
        const certInfo = extractPeerCertInfo(tlsSocket);
        if (!certInfo || certInfo.certChainDer.length === 0) {
          sendErrorPdu({ errorCode: TLS_HANDSHAKE_FAILED_ERROR_CODE, tlsAlertCode: 41 });
          cleanup();
          throw new Error("RDP server did not present an X.509 certificate");
        }

        // 5. TOFU Certificate Verification BEFORE sending RDCleanPathPdu response to WASM.
        // Zero NLA/CredSSP/RDP credentials can ever leave the client before trust is confirmed.
        if (typeof verifyCertificate === "function") {
          onStatus?.("cert-verify", { fingerprintSha256: certInfo.fingerprintSha256 });
          let verdict;
          try {
            verdict = await verifyCertificate({
              ...certInfo,
              host,
              port,
              protocol: "rdp",
            });
          } catch (err) {
            sendErrorPdu({ errorCode: TLS_HANDSHAKE_FAILED_ERROR_CODE, tlsAlertCode: 42 });
            cleanup();
            throw err;
          }
          if (!verdict || verdict.accepted !== true) {
            sendErrorPdu({ errorCode: TLS_HANDSHAKE_FAILED_ERROR_CODE, tlsAlertCode: 42 });
            cleanup();
            return;
          }
        }

        if (upstreamClosedDuringTofu || tlsSocket.destroyed || tlsSocket.readableEnded) {
          sendErrorPdu({ errorCode: TARGET_UNREACHABLE_ERROR_CODE });
          cleanup();
          if (upstreamErrorDuringTofu) throw upstreamErrorDuringTofu;
          return;
        }

        certChainDer = certInfo.certChainDer;
      } finally {
        tlsSocket.removeListener("error", onTofuSocketError);
        tlsSocket.removeListener("close", onTofuSocketClose);
      }
    }

    if (
      cleanedUp
      || signal?.aborted
      || ws.readyState !== 1
      || !activeSocket
      || activeSocket.destroyed
      || activeSocket.readableEnded
    ) {
      cleanup();
      return;
    }

    // 6. Send RDCleanPathPdu response with X.224 confirm, server cert chain, and resolved serverAddr.
    const serverAddr = upstream.serverAddr
      || (rawStream.remoteAddress
        ? (rawStream.remoteAddress.includes(":")
          ? `[${rawStream.remoteAddress}]:${rawStream.remotePort || port}`
          : `${rawStream.remoteAddress}:${rawStream.remotePort || port}`)
        : (host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`));

    ws.send(
      encodeRDCleanPathResponse({
        x224ConnectionPdu: x224Confirm,
        serverCertChain: certChainDer,
        serverAddr,
      }),
      { binary: true },
    );

    onStatus?.("relaying");

    // 7. Bidirectional raw binary relay between WS and TLS (or plain TCP) socket,
    //    with real-time RTT and smoothed RX/TX bandwidth telemetry.
    let totalRxBytes = 0;
    let totalTxBytes = 0;
    let intervalRxBytes = 0;
    let intervalTxBytes = 0;
    let smoothedRxBps = 0;
    let smoothedTxBps = 0;
    let smoothedRttMs = initialRttMs;
    let lastStatsAt = performance.now();
    let hasEmittedInterval = false;
    let pendingOutboundAt = null;

    const emitStats = (isInitial = false) => {
      if (typeof onStats !== "function" || cleanedUp) return;
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
          protocol: "rdp",
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
        // telemetry callback errors must never disrupt the RDP relay
      }
    };

    if (typeof onStats === "function") {
      emitStats(true);
      const effectiveStatsInterval = Math.max(50, Number(statsIntervalMs) || 1500);
      statsTimer = setInterval(() => emitStats(false), effectiveStatsInterval);
      statsTimer.unref?.();

      if (isDirectConnection && host && port) {
        const effectiveProbeInterval = Math.max(100, Number(rttProbeIntervalMs) || 4000);
        const effectiveProbeTimeout = Math.max(100, Number(rttProbeTimeoutMs) || 3000);
        rttProbeTimer = setInterval(() => {
          if (cleanedUp || activeRttProbe) return;
          const probe = probeTcpConnectRtt(host, port, effectiveProbeTimeout);
          activeRttProbe = probe;
          void probe.promise.then((sample) => {
            if (activeRttProbe === probe) {
              activeRttProbe = null;
            }
            if (!cleanedUp && typeof sample === "number" && Number.isFinite(sample)) {
              smoothedRttMs = smoothedRttMs === null ? sample : (smoothedRttMs * 0.6 + sample * 0.4);
            }
          });
        }, effectiveProbeInterval);
        rttProbeTimer.unref?.();
      }
    }

    const relaySocket = activeSocket;
    await new Promise((resolve) => {
      let finished = false;
      const onWsMessage = (data) => {
        if (cleanedUp || !relaySocket || relaySocket.destroyed || !relaySocket.writable) return;
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        totalTxBytes += buf.length;
        intervalTxBytes += buf.length;
        if (!isDirectConnection && pendingOutboundAt === null) {
          pendingOutboundAt = performance.now();
        }
        relaySocket.write(buf);
      };

      const onSocketData = (chunk) => {
        if (cleanedUp || ws.readyState !== 1) return;
        const len = chunk?.length || 0;
        totalRxBytes += len;
        intervalRxBytes += len;
        if (!isDirectConnection && pendingOutboundAt !== null) {
          const turnaround = performance.now() - pendingOutboundAt;
          pendingOutboundAt = null;
          if (turnaround >= 0 && turnaround <= 5000) {
            smoothedRttMs = smoothedRttMs === null
              ? turnaround
              : (smoothedRttMs * 0.7 + turnaround * 0.3);
          }
        }
        try {
          ws.send(chunk, { binary: true });
        } catch {
          done();
        }
      };

      const done = () => {
        if (finished) return;
        finished = true;
        ws.removeListener("message", onWsMessage);
        ws.removeListener("close", done);
        ws.removeListener("error", done);
        relaySocket?.removeListener?.("data", onSocketData);
        relaySocket?.removeListener?.("close", done);
        relaySocket?.removeListener?.("end", done);
        relaySocket?.removeListener?.("error", done);
        cleanup();
        resolve();
      };

      ws.on("message", onWsMessage);
      relaySocket.on("data", onSocketData);
      ws.once("close", done);
      ws.once("error", done);
      relaySocket.once("close", done);
      relaySocket.once("end", done);
      relaySocket.once("error", done);
    });
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
    cleanup();
  }
}

module.exports = {
  RDCLEANPATH_BASE_VERSION,
  RDCLEANPATH_VERSION_1,
  GENERAL_ERROR_CODE,
  NEGOTIATION_ERROR_CODE,
  EXPIRED_ERROR_CODE,
  NOT_YET_VALID_ERROR_CODE,
  REVOKED_ERROR_CODE,
  TARGET_UNREACHABLE_ERROR_CODE,
  DNS_RESOLUTION_FAILED_ERROR_CODE,
  TLS_HANDSHAKE_FAILED_ERROR_CODE,
  encodeDerLength,
  encodeDerInteger,
  encodeDerOctetString,
  encodeDerUtf8String,
  encodeDerSequence,
  encodeDerExplicit,
  readDerTlv,
  decodeRDCleanPathPdu,
  encodeRDCleanPathRequest,
  encodeRDCleanPathResponse,
  encodeRDCleanPathError,
  computeCertSha256Fingerprint,
  formatDistinguishedName,
  extractPeerCertInfo,
  WINDOWS_RDP_KRSA_CIPHERS,
  isBoringSslKeyUsageError,
  readTpktPacket,
  parseX224ConfirmNegotiation,
  upgradeToTls,
  probeTcpConnectRtt,
  handleRdpCleanPathConnection,
};
