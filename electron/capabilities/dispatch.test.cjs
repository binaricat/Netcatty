"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRegistryDispatcher } = require("./dispatch.cjs");
const { CAPABILITY_SURFACES } = require("./constants.cjs");

test("createRegistryDispatcher routes implemented capabilities to handlers", async () => {
  const calls = [];
  const dispatch = createRegistryDispatcher({
    surface: CAPABILITY_SURFACES.BUILTIN,
    handlers: {
      "meta.status": async (params) => ({ ok: true, params }),
    },
    fallback: async (method) => ({ ok: false, error: `unknown:${method}` }),
  });

  const result = await dispatch("netcatty/getStatus", { chatSessionId: "chat-1" });
  assert.equal(result.ok, true);
  assert.equal(result.params.chatSessionId, "chat-1");
  assert.equal(calls.length, 0);
});

test("createRegistryDispatcher falls back for implemented capabilities without handlers", async () => {
  const dispatch = createRegistryDispatcher({
    surface: CAPABILITY_SURFACES.GLOBAL,
    handlers: {},
    fallback: async (method) => ({ ok: false, error: `unknown:${method}` }),
  });

  const result = await dispatch("vault/host/notes/get", { hostId: "host-1" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "unknown:vault/host/notes/get");
});

test("createRegistryDispatcher falls back for unknown rpc methods", async () => {
  const dispatch = createRegistryDispatcher({
    surface: CAPABILITY_SURFACES.BUILTIN,
    handlers: {},
    fallback: async (method) => ({ ok: false, error: `unknown:${method}` }),
  });

  const result = await dispatch("auth/verify", { token: "abc" });
  assert.equal(result.error, "unknown:auth/verify");
});
