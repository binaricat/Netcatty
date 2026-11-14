"use strict";

/**
 * eNSP Pro device console over SockJS + STOMP on the platform's WSS endpoint.
 *
 * eNSP Pro devices have no TCP/Telnet console; the web client opens a SockJS
 * socket, connects STOMP, subscribes to `/user/topic/console/message/...` and
 * sends keystrokes to `/app/console/message/...`. The destination prefixes are
 * asymmetric on purpose: SUBSCRIBE uses /user/topic, SEND uses /app.
 *
 * The transport mimics a serial port (write/on("data")/on("close")) so the
 * shared exec helper (execViaRawPty) can drive it unchanged.
 */

const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const https = require("node:https");

const NUL = "\u0000";
const SUB_PREFIX = "/user/topic";
const SEND_PREFIX = "/app";
const GLOBAL_PING_MS = 3000;
const CONSOLE_HEARTBEAT_MS = 30000;
const DEFAULT_CONNECT_TIMEOUT_MS = 20000;

function encodeClientFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function readFrames(buffer, onText, onClose) {
  let rest = buffer;
  for (;;) {
    if (rest.length < 2) return rest;
    const opcode = rest[0] & 0x0f;
    const masked = (rest[1] & 0x80) !== 0;
    let length = rest[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (rest.length < 4) return rest;
      length = rest.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (rest.length < 10) return rest;
      length = Number(rest.readBigUInt64BE(2));
      offset = 10;
    }
    const maskKey = masked ? rest.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (rest.length < offset + length) return rest;
    let payload = rest.subarray(offset, offset + length);
    rest = rest.subarray(offset + length);
    if (maskKey) payload = Buffer.from(payload.map((byte, index) => byte ^ maskKey[index % 4]));
    if (opcode === 0x8) {
      onClose();
      return Buffer.alloc(0);
    }
    if (opcode === 0x9) continue;
    if (opcode === 0x1) onText(payload.toString("utf8"));
  }
}

function stompFrame(command, headers, body = "") {
  const lines = [command, ...Object.entries(headers || {}).map(([key, value]) => `${key}:${value}`)];
  if (body) {
    lines.push(`content-length:${Buffer.byteLength(body, "utf8")}`);
    lines.push("content-type:text/plain;charset=UTF-8");
  }
  return `${lines.join("\n")}\n\n${body}${NUL}`;
}

function parseStompFrames(sockJsPayload) {
  const out = [];
  for (const raw of sockJsPayload) {
    const text = String(raw || "");
    const headEnd = text.indexOf("\n\n");
    const head = headEnd === -1 ? text : text.slice(0, headEnd);
    const body = headEnd === -1 ? "" : text.slice(headEnd + 2).replace(/\u0000/gu, "");
    const lines = head.split("\n");
    const command = (lines[0] || "").trim();
    const headers = {};
    for (const line of lines.slice(1)) {
      const index = line.indexOf(":");
      if (index > 0) headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    out.push({ command, headers, body });
  }
  return out;
}

class EnspConsole extends EventEmitter {
  constructor({ host, port = 8443, sandboxId, nodeId, cookie = "", connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
    super();
    this.host = String(host || "")
      .trim()
      .replace(/^https?:\/\//iu, "")
      .replace(/\/+$/u, "");
    this.port = Number(port) || 8443;
    this.sandboxId = Number(sandboxId);
    this.nodeId = Number(nodeId);
    this.cookie = cookie;
    this.connectTimeoutMs = Number(connectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.opened = false;
    this.connected = false;
    this.closed = false;
    this.pending = [];
    this.timers = [];
    this.subId = 0;
  }

  get destination() {
    return `${SEND_PREFIX}/console/message/${this.sandboxId}/${this.nodeId}`;
  }

  async openSocket() {
    const key = crypto.randomBytes(16).toString("base64");
    const path = `/web.socket/000/${crypto.randomBytes(8).toString("hex")}/websocket`;
    const baseUrl = `https://${this.host}:${this.port}`;
    return new Promise((resolve, reject) => {
      const req = https.request({
        host: this.host,
        port: this.port,
        path,
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": key,
          origin: baseUrl,
          ...(this.cookie ? { cookie: this.cookie } : {}),
        },
        rejectUnauthorized: false,
        timeout: this.connectTimeoutMs,
      });
      req.on("upgrade", (res, socket) => {
        this.socket = socket;
        socket.on("data", (chunk) => this.onSocketData(chunk));
        socket.on("close", () => this.handleClose("socket closed"));
        socket.on("error", (err) => this.emit("error", err));
        resolve(socket);
      });
      req.on("response", (res) => {
        reject(new Error(`eNSP console WebSocket rejected (HTTP ${res.statusCode})`));
      });
      req.on("timeout", () => req.destroy(new Error("eNSP console WebSocket timeout")));
      req.on("error", reject);
      req.end();
    });
  }

  onSocketData(chunk) {
    this.buffer = readFrames(
      Buffer.concat([this.buffer, chunk]),
      (text) => this.onSocketText(text),
      () => this.handleClose("socket closed"),
    );
  }

  onSocketText(text) {
    if (text.startsWith("o")) {
      this.opened = true;
      this.flushPending();
      return;
    }
    if (!text.startsWith("a")) return;
    let payload;
    try {
      payload = JSON.parse(text.slice(1));
    } catch {
      return;
    }
    for (const frame of parseStompFrames(payload)) {
      if (frame.command === "CONNECTED") {
        this.connected = true;
        continue;
      }
      if (frame.command !== "MESSAGE") continue;
      // The console heartbeat topic answers plain true/false; that is protocol noise.
      if (frame.body.trim() === "true" || frame.body.trim() === "false") continue;
      if (frame.body) this.emit("data", frame.body);
    }
  }

  sendRawSocket(text) {
    if (!this.socket || this.closed) return false;
    if (!this.opened) {
      this.pending.push(text);
      return true;
    }
    try {
      this.socket.write(encodeClientFrame(JSON.stringify([text])));
      return true;
    } catch {
      return false;
    }
  }

  flushPending() {
    const queued = this.pending;
    this.pending = [];
    for (const text of queued) this.sendRawSocket(text);
  }

  sendStomp(command, headers, body = "") {
    return this.sendRawSocket(stompFrame(command, headers, body));
  }

  subscribe(destination) {
    this.subId += 1;
    return this.sendStomp("SUBSCRIBE", { id: `sub-${this.subId}`, destination });
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === "function") timer.unref();
    });
  }

  async connect() {
    await this.openSocket();
    const deadline = Date.now() + this.connectTimeoutMs;
    while (!this.opened && Date.now() < deadline) await this.sleep(100);
    if (!this.opened) throw new Error("eNSP console SockJS socket did not open");

    this.sendStomp("CONNECT", { "accept-version": "1.2,1.1,1.0", host: this.host, "heart-beat": "0,0" });
    const stompDeadline = Date.now() + this.connectTimeoutMs;
    while (!this.connected && Date.now() < stompDeadline) await this.sleep(100);
    if (!this.connected) throw new Error("eNSP console STOMP broker did not connect");

    this.subscribe(`${SUB_PREFIX}/console/message/${this.sandboxId}/${this.nodeId}`);
    this.subscribe(`${SUB_PREFIX}/console/heartbeat/${this.sandboxId}/${this.nodeId}`);
    await this.sleep(300);
    this.sendStomp("SEND", { destination: `${SEND_PREFIX}/console/connect/${this.sandboxId}/${this.nodeId}` });
    await this.sleep(800);

    this.timers.push(setInterval(() => {
      this.sendStomp("SEND", { destination: `${SEND_PREFIX}${SUB_PREFIX}/ping` }, "ping");
    }, GLOBAL_PING_MS));
    this.timers.push(setInterval(() => {
      this.sendStomp("SEND", { destination: `${SEND_PREFIX}/console/heartbeat/${this.sandboxId}/${this.nodeId}` });
    }, CONSOLE_HEARTBEAT_MS));
    for (const timer of this.timers) {
      if (typeof timer.unref === "function") timer.unref();
    }
    // eNSP's console page only starts forwarding keystrokes after the first Enter.
    this.write("\r");
    return true;
  }

  write(data) {
    if (this.closed) return false;
    return this.sendStomp("SEND", { destination: this.destination }, String(data ?? ""));
  }

  handleClose(reason) {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.emit("close", reason || "closed");
  }

  clearTimers() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  close() {
    if (this.closed) return;
    try {
      this.sendStomp("SEND", { destination: `${SEND_PREFIX}/console/close/${this.sandboxId}/${this.nodeId}` });
    } catch {
      // The socket may already be gone; closing locally is what matters.
    }
    this.closed = true;
    this.clearTimers();
    try {
      this.socket?.destroy();
    } catch {
      // ignore
    }
    this.emit("close", "closed by client");
  }
}

module.exports = {
  EnspConsole,
  encodeClientFrame,
  parseStompFrames,
  stompFrame,
};
