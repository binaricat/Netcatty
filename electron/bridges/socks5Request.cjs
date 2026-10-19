"use strict";

const MAX_HANDSHAKE_BYTES = 1024;

function parseIpv6(bytes) {
  const groups = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(bytes.readUInt16BE(index).toString(16));
  }
  return groups.join(":");
}

/** Incremental SOCKS5 CONNECT handshake; leaves post-handshake bytes untouched. */
function createSocks5RequestParser({ onConnect, onFailure }) {
  let state = "greeting";
  let buffer = Buffer.alloc(0);
  const fail = (code = 0x01) => {
    if (state === "failed" || state === "connected") return;
    state = "failed";
    onFailure(code);
  };
  return {
    push(chunk) {
      if (state === "failed" || state === "connected") return;
      if (!Buffer.isBuffer(chunk)) { fail(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_HANDSHAKE_BYTES) { fail(); return; }
      while (true) {
        if (state === "greeting") {
          if (buffer.length < 2) return;
          const count = buffer[1];
          if (buffer[0] !== 5 || count < 1) { fail(); return; }
          if (buffer.length < 2 + count) return;
          const acceptsNoAuth = buffer.subarray(2, 2 + count).includes(0);
          buffer = buffer.subarray(2 + count);
          if (!acceptsNoAuth) { fail(0xff); return; }
          state = "request";
          this.onGreeting?.();
        }
        if (state !== "request") return;
        if (buffer.length < 4) return;
        if (buffer[0] !== 5 || buffer[2] !== 0) { fail(); return; }
        if (buffer[1] !== 1) { fail(0x07); return; }
        const addressType = buffer[3];
        const addressBytes = addressType === 1 ? 4 : addressType === 4 ? 16 : addressType === 3 ? (buffer.length < 5 ? -1 : buffer[4] + 1) : 0;
        if (addressBytes === -1) return;
        if (!addressBytes || (addressType === 3 && addressBytes === 1)) { fail(0x08); return; }
        const addressStart = 4 + (addressType === 3 ? 1 : 0);
        const addressEnd = addressStart + addressBytes - (addressType === 3 ? 1 : 0);
        if (buffer.length < addressEnd + 2) return;
        const address = buffer.subarray(addressStart, addressEnd);
        const host = addressType === 1 ? Array.from(address).join(".")
          : addressType === 4 ? parseIpv6(address)
          : address.toString("utf8");
        const port = buffer.readUInt16BE(addressEnd);
        if (!host || !port) { fail(0x08); return; }
        const remaining = buffer.subarray(addressEnd + 2);
        buffer = Buffer.alloc(0);
        state = "connected";
        onConnect(host, port, remaining);
        return;
      }
    },
    fail,
    onGreeting: null,
  };
}

module.exports = { createSocks5RequestParser };
