"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PluginNetworkBroker,
  MAX_NETWORK_BODY_BYTES,
  MAX_NETWORK_HEADER_BYTES,
} = require("./networkBroker.cjs");
const { RPC_ERRORS } = require("./rpcRouter.cjs");

function runtimeContext() {
  return {
    pluginId: "com.example.network",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "browser",
    manifest: { permissions: { optional: ["network"] } },
    signal: new AbortController().signal,
    assertActive: async () => {},
  };
}

test("network broker strips cookies, bounds responses, and charges decoded bytes", async () => {
  const calls = [];
  const charged = [];
  const broker = new PluginNetworkBroker({
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response("hello", {
        status: 200,
        headers: { "content-type": "text/plain", "set-cookie": "secret=1" },
      });
    },
    permissionEngine: { authorize: async () => {} },
    quotaManager: { chargeBytes: (...args) => charged.push(args) },
  });
  const response = await broker.request({
    url: "https://example.com/data",
    headers: { accept: "text/plain" },
  }, runtimeContext());
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(Buffer.from(response.body.data, "base64").toString(), "hello");
  assert.deepEqual(charged, [["runtime-1", "network", 5]]);
});

test("every redirect origin is authorized and cross-origin credentials are stripped", async () => {
  const calls = [];
  const authorized = [];
  const broker = new PluginNetworkBroker({
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) {
        return new Response(null, { status: 302, headers: { location: "https://other.example/final" } });
      }
      return new Response("ok", { status: 200 });
    },
    permissionEngine: { authorize: async (_context, descriptor) => authorized.push(descriptor) },
  });
  await broker.request({
    url: "https://first.example/start",
    headers: { authorization: "Bearer host-secret", "x-request-id": "one" },
  }, runtimeContext());
  assert.equal(authorized[0].resources[0], "https://other.example");
  assert.equal(calls[1].options.headers.authorization, undefined);
  assert.equal(calls[1].options.headers["x-request-id"], "one");
});

test("HTTP redirect method semantics do not replay POST bodies on 302", async () => {
  const calls = [];
  const charges = [];
  const broker = new PluginNetworkBroker({
    fetch: async (_url, options) => {
      calls.push(options);
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "/done" } });
      return new Response("ok");
    },
    permissionEngine: { authorize: async () => {} },
    quotaManager: { chargeBytes: (...args) => charges.push(args) },
  });
  await broker.request({
    url: "https://example.com/start",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { encoding: "utf8", data: "{}" },
  }, runtimeContext());
  assert.equal(calls[1].method, "GET");
  assert.equal(calls[1].body, undefined);
  assert.equal(calls[1].headers["content-type"], undefined);
  assert.deepEqual(charges, [
    ["runtime-1", "network", 2],
    ["runtime-1", "network", 2],
  ], "the request body and final response are both charged");
});

test("network redirects reject embedded credentials before authorization or fetch", async () => {
  let calls = 0;
  let authorizations = 0;
  const broker = new PluginNetworkBroker({
    fetch: async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://user:password@other.example/private" },
      });
    },
    permissionEngine: { authorize: async () => { authorizations += 1; } },
  });
  await assert.rejects(
    broker.request({ url: "https://first.example/start" }, runtimeContext()),
    /cannot contain credentials/,
  );
  assert.equal(calls, 1);
  assert.equal(authorizations, 0);
});

test("network request validation rejects transport headers, credentials, and non-canonical bodies", () => {
  const broker = new PluginNetworkBroker({
    fetch: async () => new Response(),
    permissionEngine: { authorize: async () => {} },
  });
  assert.throws(() => broker.validate({
    url: "https://example.com",
    headers: { cookie: "secret=1" },
  }), /forbidden/);
  assert.throws(() => broker.validate({ url: "https://user:pass@example.com" }), /credentials/);
  assert.throws(() => broker.validate({
    url: "https://example.com",
    method: "POST",
    body: { encoding: "base64", data: "YQ" },
  }), /not canonical/);
  assert.throws(() => broker.validate({
    url: "https://example.com",
    headers: Object.fromEntries(Array.from({ length: 9 }, (_, index) => (
      [`x-budget-${index}`, "x".repeat(MAX_NETWORK_HEADER_BYTES / 8)]
    ))),
  }), /headers are too large/);
  assert.throws(() => broker.validate({
    url: "https://example.com",
    headers: { "x-control": "before\0after" },
  }), /header value is invalid/);
});

test("network response streaming stops above the byte cap", async () => {
  const broker = new PluginNetworkBroker({
    fetch: async () => new Response("small", {
      headers: { "content-length": String(MAX_NETWORK_BODY_BYTES + 1) },
    }),
    permissionEngine: { authorize: async () => {} },
  });
  await assert.rejects(
    broker.request({ url: "https://example.com" }, runtimeContext()),
    (error) => error.code === RPC_ERRORS.resourceExhausted,
  );
});

test("network broker reports its own timeout as a stable deadline error", async (context) => {
  // A real request owns a socket; this pending fake must also keep the loop alive.
  const keepAlive = setInterval(() => {}, 1_000);
  context.after(() => clearInterval(keepAlive));
  const broker = new PluginNetworkBroker({
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }),
    permissionEngine: { authorize: async () => {} },
  });
  await assert.rejects(
    broker.request({ url: "https://example.com", timeoutMs: 5 }, runtimeContext()),
    (error) => error.code === RPC_ERRORS.deadlineExceeded,
  );
});

test("credential field validation follows the canonical contract and keeps Bearer default", () => {
  const broker = new PluginNetworkBroker({ permissionEngine: {} });
  const lease = { kind: "secret-lease", id: "l".repeat(32), operationId: "network:https://example.invalid", expiresAt: 1000 };
  const request = { url: "https://example.invalid", credentialLease: lease, authorization: {} };
  assert.deepEqual(broker.validate(request).authorization, { scheme: "Bearer" });
  for (const authorization of [{ scheme: "Digest" }, { scheme: "Basic", username: "name\n" }, { password: "synthetic" }]) {
    assert.throws(() => broker.validate({ ...request, authorization }), /authorization is invalid/);
  }
  assert.throws(() => broker.validate({ ...request, credentialLease: { ...lease, id: "short" } }), /lease is invalid/);
});
