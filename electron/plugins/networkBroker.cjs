"use strict";

const { createDefinitionValidator } = require("./contractValidator.cjs");
const validateLease = createDefinitionValidator("SecretLeaseRef");
const validateAuthorization = createDefinitionValidator("PluginNetworkAuthorization");

const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");
const { PLUGIN_RPC_MAX_RAW_BYTES } = require("./constants.cjs");
const { canonicalizeNetworkOrigin } = require("./permissionResources.cjs");

const MAX_NETWORK_BODY_BYTES = PLUGIN_RPC_MAX_RAW_BYTES;
const MAX_NETWORK_HEADERS = 64;
const MAX_NETWORK_HEADER_BYTES = 64 * 1024;
const MAX_NETWORK_REDIRECTS = 5;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "transfer-encoding",
]);
const SENSITIVE_REDIRECT_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
const ENTITY_REDIRECT_HEADERS = new Set(["content-encoding", "content-language", "content-type"]);

function invalidArgument(message) {
  return new PluginRpcError(RPC_ERRORS.invalidArgument, message);
}

async function cancelResponseBody(response, reason) {
  try { await response.body?.cancel?.(reason); }
  catch {}
}

function decodeBody(body) {
  if (body === undefined) return undefined;
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.data !== "string") {
    throw invalidArgument("Plugin network request body is invalid");
  }
  let bytes;
  if (body.encoding === "utf8") bytes = Buffer.from(body.data, "utf8");
  else if (body.encoding === "base64") {
    bytes = Buffer.from(body.data, "base64");
    if (bytes.toString("base64") !== body.data) throw invalidArgument("Plugin network base64 body is not canonical");
  } else throw invalidArgument("Plugin network request body encoding is unsupported");
  if (bytes.byteLength > MAX_NETWORK_BODY_BYTES) {
    throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Plugin network request body is too large");
  }
  return bytes;
}

function normalizeHeaders(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArgument("Plugin network headers are invalid");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_NETWORK_HEADERS) throw invalidArgument("Plugin network request has too many headers");
  const headers = {};
  let headerBytes = 0;
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name) || FORBIDDEN_REQUEST_HEADERS.has(name)) {
      throw invalidArgument(`Plugin network request header is forbidden: ${rawName}`);
    }
    if (
      typeof rawValue !== "string"
      || rawValue.length > 8_192
      || /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(rawValue)
    ) {
      throw invalidArgument(`Plugin network request header value is invalid: ${rawName}`);
    }
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(rawValue);
    if (headerBytes > MAX_NETWORK_HEADER_BYTES) {
      throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Plugin network request headers are too large");
    }
    headers[name] = rawValue;
  }
  return headers;
}

function assertNetworkRequest(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw invalidArgument("Plugin network request is invalid");
  }
  if (typeof params.url !== "string" || params.url.length > 8_192) {
    throw invalidArgument("Plugin network URL is invalid");
  }
  let url;
  try { url = new URL(params.url); }
  catch { throw invalidArgument("Plugin network URL is invalid"); }
  const origin = canonicalizeNetworkOrigin(url.origin);
  if (url.username || url.password) throw invalidArgument("Plugin network URL cannot contain credentials");
  const method = params.method ?? "GET";
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) {
    throw invalidArgument("Plugin network method is unsupported");
  }
  const timeoutMs = params.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw invalidArgument("Plugin network timeout is invalid");
  }
  const body = decodeBody(params.body);
  if (body && (method === "GET" || method === "HEAD")) {
    throw invalidArgument(`Plugin network ${method} requests cannot contain a body`);
  }
  return {
    url,
    origin,
    method,
    headers: normalizeHeaders(params.headers),
    body,
    timeoutMs,
  };
}

async function readBoundedResponse(response, maxBytes, signal) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelResponseBody(response);
    throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Plugin network response is too large");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Plugin network response is too large");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    try { await reader.cancel(error); } catch {}
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function normalizeResponseHeaders(headers) {
  const responseHeaders = {};
  let responseHeaderBytes = 0;
  let responseHeaderCount = 0;
  for (const [name, value] of headers) {
    if (name.toLowerCase() === "set-cookie") continue;
    responseHeaderCount += 1;
    responseHeaderBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (responseHeaderCount > MAX_NETWORK_HEADERS || responseHeaderBytes > MAX_NETWORK_HEADER_BYTES) {
      throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Plugin network response headers are too large");
    }
    responseHeaders[name.toLowerCase()] = value;
  }
  return responseHeaders;
}

class PluginNetworkBroker {
  constructor(options) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.permissionEngine = options.permissionEngine;
    this.quotaManager = options.quotaManager ?? null;
    if (typeof this.fetch !== "function") throw new TypeError("Plugin network fetch implementation is required");
  }

  validate(params) {
    const request = assertNetworkRequest(params);
    const validated = {
      url: request.url.href,
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : {
        body: { encoding: "base64", data: request.body.toString("base64") },
      }),
      timeoutMs: request.timeoutMs,
    };
    // Preserve host-consumed credential fields. assertNetworkRequest ignores
    // unknown keys; without this, registry validateParams would strip them and
    // network.request lease injection would become dead code.
    if (params?.credentialLease !== undefined) {
      const lease = params.credentialLease;
      if (!validateLease(lease)) {
        throw invalidArgument("Plugin network credential lease is invalid");
      }
      validated.credentialLease = Object.freeze({
        kind: "secret-lease",
        id: lease.id,
        operationId: lease.operationId,
        expiresAt: lease.expiresAt,
      });
    }
    if (params?.authorization !== undefined) {
      const authorization = params.authorization;
      if (!validateAuthorization(authorization)) {
        throw invalidArgument("Plugin network authorization is invalid");
      }
      const scheme = authorization.scheme === "Basic" ? "Basic" : "Bearer";
      validated.authorization = Object.freeze({
        scheme,
        ...(typeof authorization.username === "string"
          ? { username: authorization.username }
          : {}),
      });
    }
    return validated;
  }

  describeAuthorization(params) {
    const request = assertNetworkRequest(params);
    return {
      permission: "network",
      resources: [request.origin],
      reason: `Connect to ${request.origin}`,
      operationId: `network:${request.origin}`,
    };
  }

  async request(params, context) {
    const request = assertNetworkRequest(params);
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    let currentUrl = request.url;
    let currentOrigin = request.origin;
    let currentMethod = request.method;
    let currentBody = request.body;
    let headers = { ...request.headers };
    try {
      for (let redirects = 0; redirects <= MAX_NETWORK_REDIRECTS; redirects += 1) {
        await context.assertActive();
        if (currentBody) {
          this.quotaManager?.chargeBytes(context.runtimeId, "network", currentBody.byteLength);
        }
        const response = await this.fetch(currentUrl, {
          method: currentMethod,
          headers,
          ...(currentBody === undefined ? {} : { body: currentBody }),
          credentials: "omit",
          redirect: "manual",
          signal,
        });
        const effectiveUrl = response.url ? new URL(response.url) : currentUrl;
        if (
          effectiveUrl.username
          || effectiveUrl.password
          || canonicalizeNetworkOrigin(effectiveUrl.origin) !== currentOrigin
        ) {
          await cancelResponseBody(response);
          throw new PluginRpcError(
            RPC_ERRORS.permissionDenied,
            "Plugin network transport followed an unauthorized redirect",
          );
        }
        let responseHeaders;
        try {
          responseHeaders = normalizeResponseHeaders(response.headers);
        } catch (error) {
          await cancelResponseBody(response, error);
          throw error;
        }
        if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
          await cancelResponseBody(response);
          if (redirects === MAX_NETWORK_REDIRECTS) {
            throw new PluginRpcError(RPC_ERRORS.outOfRange, "Plugin network redirect limit exceeded");
          }
          const nextUrl = new URL(response.headers.get("location"), currentUrl);
          if (nextUrl.username || nextUrl.password) {
            throw invalidArgument("Plugin network redirect URL cannot contain credentials");
          }
          const nextOrigin = canonicalizeNetworkOrigin(nextUrl.origin);
          await this.permissionEngine.authorize(context, {
            permission: "network",
            resources: [nextOrigin],
            reason: `Follow network redirect to ${nextOrigin}`,
            operationId: `network:${nextOrigin}`,
          });
          if (nextOrigin !== currentOrigin) {
            headers = Object.fromEntries(Object.entries(headers).filter(([name]) => (
              !SENSITIVE_REDIRECT_HEADERS.has(name)
            )));
          }
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === "POST")) {
            currentMethod = currentMethod === "HEAD" ? "HEAD" : "GET";
            currentBody = undefined;
            headers = Object.fromEntries(Object.entries(headers).filter(([name]) => (
              !ENTITY_REDIRECT_HEADERS.has(name)
            )));
          }
          currentUrl = nextUrl;
          currentOrigin = nextOrigin;
          continue;
        }
        const bytes = await readBoundedResponse(response, MAX_NETWORK_BODY_BYTES, signal);
        this.quotaManager?.chargeBytes(context.runtimeId, "network", bytes.byteLength);
        await context.assertActive();
        return {
          url: effectiveUrl.href,
          status: response.status,
          headers: responseHeaders,
          body: { encoding: "base64", data: bytes.toString("base64") },
        };
      }
    } catch (error) {
      context.signal?.throwIfAborted();
      if (timeout.aborted) {
        throw new PluginRpcError(RPC_ERRORS.deadlineExceeded, "Plugin network request timed out");
      }
      throw error;
    }
    throw new PluginRpcError(RPC_ERRORS.internal, "Plugin network redirect handling failed");
  }
}

module.exports = {
  FORBIDDEN_REQUEST_HEADERS,
  ENTITY_REDIRECT_HEADERS,
  MAX_NETWORK_BODY_BYTES,
  MAX_NETWORK_HEADER_BYTES,
  MAX_NETWORK_HEADERS,
  MAX_NETWORK_REDIRECTS,
  PluginNetworkBroker,
  assertNetworkRequest,
  cancelResponseBody,
  normalizeResponseHeaders,
  readBoundedResponse,
};
