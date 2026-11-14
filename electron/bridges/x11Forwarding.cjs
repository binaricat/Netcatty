const net = require("node:net");
const fs = require("node:fs");
const { Transform } = require("node:stream");
const { execFileSync } = require("node:child_process");
const { createX11FdGuard } = require("./x11FdGuard.cjs");

const X11_PORT_BASE = 6000;
const MIT_MAGIC_COOKIE_PROTOCOL = "MIT-MAGIC-COOKIE-1";

function resolveX11DisplaySpec(spec, options = {}) {
  const platform = options.platform || process.platform;
  let raw = String(spec || options.envDisplay || process.env.DISPLAY || (platform === "win32" ? "localhost:0" : ":0")).trim();

  if (!raw) {
    return resolveX11DisplaySpec(undefined, { ...options, envDisplay: platform === "win32" ? "localhost:0" : ":0" });
  }
  if (raw === ":") {
    raw = ":0";
  }

  if (raw.startsWith("/")) {
    return { path: raw };
  }

  const match = raw.match(/^(.*):(\d+)(?:\.(\d+))?$/);
  if (!match) {
    return platform === "win32"
      ? { host: raw, port: X11_PORT_BASE }
      : { path: raw };
  }

  const host = match[1] || "";
  const display = Number.parseInt(match[2], 10);
  const port = display >= 100 ? display : X11_PORT_BASE + display;

  if (host.toLowerCase() === "unix" && platform !== "win32") {
    return { path: `/tmp/.X11-unix/X${display}` };
  }

  if (!host) {
    if (platform === "win32") {
      return { host: "localhost", port };
    }
    return { path: `/tmp/.X11-unix/X${display}` };
  }

  if (host.startsWith("/")) {
    return { path: host };
  }

  return { host, port };
}

function formatDisplayTarget(target) {
  if (target.path) return target.path;
  return `${target.host}:${target.port}`;
}

function platformHint(platform) {
  if (platform === "win32") {
    return "Install and start VcXsrv or Xming, then try again.";
  }
  if (platform === "darwin") {
    return "Install and start XQuartz, then try again.";
  }
  return "Check DISPLAY and make sure Xorg, Xwayland, or your X server is running.";
}

function connectSocket(socket, target) {
  if (target.path) {
    return socket.connect(target.path);
  }
  return socket.connect(target.port, target.host);
}

function destroyStream(stream) {
  try {
    stream.destroy();
  } catch {
    // best effort cleanup
  }
}

function pad4(n) {
  return (n + 3) & ~3;
}

function readUInt16(buf, offset, littleEndian) {
  return littleEndian ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
}

function normalizeCookieBuffer(cookie) {
  if (!cookie) return null;
  if (Buffer.isBuffer(cookie)) return cookie;
  const value = String(cookie).trim();
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    return Buffer.from(value, "hex");
  }
  return Buffer.from(value, "binary");
}

function rewriteX11AuthSetupPacket(buffer, options = {}) {
  const fakeCookie = normalizeCookieBuffer(options.fakeCookie);
  const realCookie = normalizeCookieBuffer(options.realCookie);
  if (!realCookie || buffer.length < 12) {
    return { buffer, complete: buffer.length >= 12, rewritten: false };
  }

  const byteOrder = buffer[0];
  const littleEndian = byteOrder === 0x6c; // 'l'
  if (!littleEndian && byteOrder !== 0x42) { // 'B'
    return { buffer, complete: true, rewritten: false };
  }

  const protocolLength = readUInt16(buffer, 6, littleEndian);
  const dataLength = readUInt16(buffer, 8, littleEndian);
  const protocolStart = 12;
  const dataStart = protocolStart + pad4(protocolLength);
  const totalLength = dataStart + pad4(dataLength);

  if (buffer.length < totalLength) {
    return { buffer, complete: false, rewritten: false };
  }

  const protocol = buffer.subarray(protocolStart, protocolStart + protocolLength).toString("ascii");
  if (protocol !== MIT_MAGIC_COOKIE_PROTOCOL || dataLength !== realCookie.length) {
    return { buffer, complete: true, rewritten: false };
  }

  const dataEnd = dataStart + dataLength;
  const currentCookie = buffer.subarray(dataStart, dataEnd);
  if (fakeCookie && currentCookie.length === fakeCookie.length && !currentCookie.equals(fakeCookie)) {
    return { buffer, complete: true, rewritten: false };
  }

  const next = Buffer.from(buffer);
  realCookie.copy(next, dataStart);
  return { buffer: next, complete: true, rewritten: true };
}

function createX11AuthTransform(options = {}) {
  let pending = Buffer.alloc(0);
  let done = false;

  return new Transform({
    transform(chunk, _encoding, callback) {
      if (done) {
        callback(null, chunk);
        return;
      }

      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      const result = rewriteX11AuthSetupPacket(pending, options);
      if (!result.complete) {
        callback();
        return;
      }

      done = true;
      callback(null, result.buffer);
    },
    flush(callback) {
      if (!done && pending.length > 0) {
        callback(null, pending);
        return;
      }
      callback();
    },
  });
}

function resolveXauthCommand(platform) {
  if (platform === "darwin" && fs.existsSync("/opt/X11/bin/xauth")) {
    return "/opt/X11/bin/xauth";
  }
  return "xauth";
}

function getDisplayNumber(display) {
  const value = String(display || process.env.DISPLAY || ":0").trim() || ":0";
  const normalized = value === ":" ? ":0" : value;
  const match = normalized.match(/:(\d+)(?:\.\d+)?$/) || normalized.match(/\/X(\d+)$/);
  if (!match) return null;

  const displayNumber = Number.parseInt(match[1], 10);
  if (!Number.isFinite(displayNumber)) return null;
  return displayNumber >= X11_PORT_BASE ? displayNumber - X11_PORT_BASE : displayNumber;
}

function parseXauthCookie(output, display) {
  const requestedDisplay = getDisplayNumber(display);
  const cookiePattern = new RegExp(`\\b${MIT_MAGIC_COOKIE_PROTOCOL}\\b\\s+([0-9a-fA-F]+)`);

  for (const entry of String(output || "").split(/\r?\n/)) {
    const match = entry.match(cookiePattern);
    if (!match) continue;

    const target = entry.trim().split(/\s+/, 1)[0];
    if (requestedDisplay !== null && getDisplayNumber(target) !== requestedDisplay) {
      continue;
    }

    return Buffer.from(match[1], "hex");
  }

  return null;
}

function readLocalX11AuthCookie(options = {}) {
  const platform = options.platform || process.platform;
  const command = options.xauthCommand || resolveXauthCommand(platform);
  const display = String(options.display || process.env.DISPLAY || ":0").trim() || ":0";
  try {
    const normalizedDisplay = display === ":" ? ":0" : display;
    const output = typeof options.readXauthOutput === "function"
      ? options.readXauthOutput({ command, display: normalizedDisplay })
      : execFileSync(command, ["list"], {
        encoding: "utf8",
        env: {
          ...process.env,
          DISPLAY: normalizedDisplay,
        },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      });
    return parseXauthCookie(output, normalizedDisplay);
  } catch {
    return null;
  }
}

function attachX11Forwarding(conn, options = {}) {
  const createSocket = options.createSocket || (() => new net.Socket());
  const sendMessage = typeof options.sendMessage === "function" ? options.sendMessage : () => {};
  const logger = options.logger || console;
  const platform = options.platform || process.platform;
  const display = options.display;
  const fakeCookie = options.fakeCookie;
  const fixedLocalAuthCookie = normalizeCookieBuffer(options.localAuthCookie);
  let localAuthCookie = fixedLocalAuthCookie;
  let localAuthCookieResolved = Boolean(fixedLocalAuthCookie);

  const resolveLocalAuthCookie = () => {
    if (localAuthCookieResolved) return localAuthCookie;
    localAuthCookieResolved = true;
    const cookie = typeof options.readLocalAuthCookie === "function"
      ? options.readLocalAuthCookie({ display, platform })
      : readLocalX11AuthCookie({ display, platform });
    localAuthCookie = normalizeCookieBuffer(cookie);
    return localAuthCookie;
  };

  const onX11 = (info, accept, reject) => {
    const target = resolveX11DisplaySpec(display, { platform });
    const localSocket = createSocket();
    let acceptedChannel = null;
    let guard = null;
    let settled = false;

    const cleanup = () => {
      if (acceptedChannel) destroyStream(acceptedChannel);
      destroyStream(localSocket);
      if (guard) {
        destroyStream(guard.toServer);
        destroyStream(guard.toClient);
      }
    };

    localSocket.once("connect", () => {
      if (settled) return;
      try {
        acceptedChannel = accept();
        settled = true;
      } catch (err) {
        logger.warn?.("[X11] Failed to accept forwarded channel", err);
        cleanup();
        return;
      }

      acceptedChannel.on("error", () => cleanup());
      localSocket.on("error", () => cleanup());
      acceptedChannel.on("close", () => destroyStream(localSocket));
      localSocket.on("close", () => destroyStream(acceptedChannel));
      guard = createX11FdGuard({ hiddenExtensions: options.hiddenExtensions, logger });
      guard.toServer.on("error", cleanup);
      guard.toClient.on("error", cleanup);
      const realCookie = resolveLocalAuthCookie();
      if (realCookie && fakeCookie) {
        acceptedChannel
          .pipe(createX11AuthTransform({ fakeCookie, realCookie }))
          .pipe(guard.toServer)
          .pipe(localSocket);
      } else {
        acceptedChannel.pipe(guard.toServer).pipe(localSocket);
      }
      localSocket.pipe(guard.toClient).pipe(acceptedChannel);
    });

    localSocket.once("error", (err) => {
      if (!settled) {
        settled = true;
        try { reject(); } catch { /* ignore reject errors */ }
        sendMessage(`\r\n[X11] Could not connect to the local X11 server: ${err?.message || err}\r\n`);
        sendMessage(`[X11] Display target: ${formatDisplayTarget(target)}\r\n`);
        sendMessage(`[X11] ${platformHint(platform)}\r\n`);
      }
      destroyStream(localSocket);
    });

    try {
      connectSocket(localSocket, target);
    } catch (err) {
      localSocket.emit("error", err);
    }
  };

  conn.on("x11", onX11);
  return () => {
    if (typeof conn.off === "function") conn.off("x11", onX11);
    else conn.removeListener("x11", onX11);
  };
}

module.exports = {
  attachX11Forwarding,
  readLocalX11AuthCookie,
  rewriteX11AuthSetupPacket,
  resolveX11DisplaySpec,
};
