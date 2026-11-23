"use strict";

/**
 * eNSP Pro platform REST client (login / list sandboxes and devices / power).
 *
 * The platform auto-creates a session for any visitor: GET /api/login?service=
 * answers 302 and sets csrfToken + JSESSIONID, so the client has to follow the
 * redirect and keep the cookies. Devices themselves expose no TCP endpoint;
 * their consoles run over the SockJS/STOMP channel in console.cjs.
 */

const https = require("node:https");
const { URL } = require("node:url");

const DEFAULT_PORT = 8443;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 5;

function createCookieJar() {
  const cookies = new Map();
  return {
    absorb(headers) {
      const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
      for (const raw of list) {
        const pair = String(raw).split(";")[0] || "";
        const index = pair.indexOf("=");
        if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    },
    header() {
      return [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    },
    get size() {
      return cookies.size;
    },
  };
}

function requestOnce(target, options) {
  const {
    method = "GET",
    headers = {},
    body = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    rejectUnauthorized = false,
  } = options || {};
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const payload = body == null ? null : Buffer.from(body, "utf8");
    const req = https.request(
      {
        host: url.hostname,
        port: Number(url.port || 443),
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          ...headers,
          ...(payload ? { "content-length": String(payload.length) } : {}),
        },
        rejectUnauthorized,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: {
              get: (name) => res.headers[String(name).toLowerCase()],
              getSetCookie: () => {
                const raw = res.headers["set-cookie"];
                if (!raw) return [];
                return Array.isArray(raw) ? raw : [raw];
              },
            },
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

class EnspPlatformError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "EnspPlatformError";
    this.details = details || null;
  }
}

function normalizeHost(host) {
  const trimmed = String(host || "").trim();
  if (!trimmed) throw new EnspPlatformError("eNSP Pro platform address is required");
  return trimmed.replace(/^https?:\/\//iu, "").replace(/\/+$/u, "");
}

function parseJsonOrThrow(text, path) {
  try {
    return JSON.parse(text);
  } catch {
    throw new EnspPlatformError(`eNSP Pro API ${path} did not return JSON`);
  }
}

class EnspPlatformClient {
  constructor({ host, port = DEFAULT_PORT, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.host = normalizeHost(host);
    this.port = Number(port) || DEFAULT_PORT;
    this.timeoutMs = Number(timeoutMs) || DEFAULT_TIMEOUT_MS;
    this.jar = createCookieJar();
    this.baseUrl = `https://${this.host}:${this.port}`;
  }

  get cookieHeader() {
    return this.jar.header();
  }

  async request(pathOrUrl, options = {}) {
    let target = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    let method = options.method || "GET";
    let body = options.body == null ? null : options.body;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const cookie = this.jar.header();
      const res = await requestOnce(target, {
        method,
        body,
        timeoutMs: this.timeoutMs,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(options.headers || {}),
        },
      });
      this.jar.absorb(res.headers);
      const location = res.headers.get("location");
      if (res.statusCode >= 300 && res.statusCode < 400 && location) {
        target = new URL(location, target).toString();
        // Redirects are followed as plain GETs, matching a browser hop.
        method = "GET";
        body = null;
        continue;
      }
      return res;
    }
    throw new EnspPlatformError("eNSP Pro login exceeded the redirect limit");
  }

  async login() {
    await this.request(`/api/login?service=${encodeURIComponent(this.baseUrl)}`);
    const info = await this.request("/api/getUserInfo");
    const payload = parseJsonOrThrow(info.text, "/api/getUserInfo");
    if (payload.code !== 0 || !payload.data) {
      throw new EnspPlatformError(
        `eNSP Pro login failed: ${payload.message || "no user info"}`,
        { statusCode: info.statusCode },
      );
    }
    return payload.data;
  }

  async listSandboxes({ projectId = 1, pageSize = 50 } = {}) {
    const res = await this.request("/service/ensp/sandbox/getByPage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, currentPage: 1, pageSize }),
    });
    const payload = parseJsonOrThrow(res.text, "/service/ensp/sandbox/getByPage");
    if (payload.code !== 0) {
      throw new EnspPlatformError(`eNSP Pro sandbox list failed: ${payload.message || payload.code}`);
    }
    return Array.isArray(payload.data) ? payload.data : [];
  }

  async listDevices() {
    const sandboxes = await this.listSandboxes();
    const devices = [];
    for (const sandbox of sandboxes) {
      for (const device of sandbox.devices || []) {
        devices.push({
          sandboxId: sandbox.id,
          sandboxName: sandbox.name,
          nodeId: device.id,
          name: device.name,
          deviceType: device.deviceType?.name || device.deviceType?.type || "",
          status: device.status ?? device.sandboxStatus ?? null,
          hostIp: device.hostIp || "",
          manageIp: device.manageIp || "",
        });
      }
    }
    return { sandboxes, devices };
  }

  async deviceAction(action, { sandboxId, deviceIds }) {
    const res = await this.request(`/service/ensp/device/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sandboxId: Number(sandboxId), deviceIds: (deviceIds || []).map(Number) }),
    });
    const payload = parseJsonOrThrow(res.text, `/service/ensp/device/${action}`);
    if (payload.code !== 0) {
      throw new EnspPlatformError(`eNSP Pro ${action} failed: ${payload.message || payload.code}`);
    }
    return true;
  }

  startDevice(sandboxId, nodeId) {
    return this.deviceAction("batchStart", { sandboxId, deviceIds: [nodeId] });
  }

  stopDevice(sandboxId, nodeId) {
    return this.deviceAction("batchStop", { sandboxId, deviceIds: [nodeId] });
  }
}

module.exports = {
  DEFAULT_PORT,
  EnspPlatformClient,
  EnspPlatformError,
  createCookieJar,
  normalizeHost,
};
