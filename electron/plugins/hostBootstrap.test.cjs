"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { startPluginHost } = require("./hostBootstrap.cjs");

test("normal release constructs the browser plugin host without a developer flag", async () => {
  let created = 0;
  const service = { manager: { async initialize() {}, async shutdown() {} } };
  assert.equal(startPluginHost({
    env: {},
    createService() { created += 1; return service; },
    registerShutdown() {},
    logger: { error() {} },
  }), service);
  assert.equal(created, 1);
});

test("synchronous plugin host construction failure leaves Netcatty available", () => {
  const errors = [];
  let registered = 0;
  const service = startPluginHost({
    env: { NETCATTY_PLUGIN_DEV: "1" },
    createService() { throw new Error("corrupt plugin database"); },
    registerShutdown() { registered += 1; },
    logger: { error(...args) { errors.push(args); } },
  });
  assert.equal(service, null);
  assert.equal(registered, 0);
  assert.match(errors[0][1].message, /corrupt plugin database/);
});

test("created plugin host initializes and registers one shutdown owner", async () => {
  let initialized = 0;
  let shutdown = 0;
  let shutdownHandler;
  const service = {
    manager: {
      async initialize() { initialized += 1; },
      async shutdown() { shutdown += 1; },
    },
  };
  assert.equal(startPluginHost({
    env: { NETCATTY_PLUGIN_DEV: "1" },
    createService: () => service,
    registerShutdown(handler) { shutdownHandler = handler; },
    logger: { error() {} },
  }), service);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(initialized, 1);
  await shutdownHandler();
  assert.equal(shutdown, 1);
});

test("asynchronous initialization failure closes and leaves the host unavailable", async () => {
  let shutdown = 0;
  let shutdownHandler;
  const errors = [];
  const service = {
    manager: {
      initialize: async () => { throw new Error("recovery failed"); },
      shutdown: async () => { shutdown += 1; },
    },
  };
  assert.equal(startPluginHost({
    env: { NETCATTY_PLUGIN_DEV: "1" },
    createService: () => service,
    registerShutdown(handler) { shutdownHandler = handler; },
    logger: { error(...args) { errors.push(args); } },
  }), service);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdown, 1);
  assert.match(errors[0][1].message, /recovery failed/);
  await shutdownHandler();
  assert.equal(shutdown, 2);
});

test("failure while registering shutdown closes the constructed host", async () => {
  let shutdown = 0;
  const errors = [];
  const service = startPluginHost({
    env: { NETCATTY_PLUGIN_DEV: "1" },
    createService: () => ({
      manager: {
        async initialize() {},
        async shutdown() { shutdown += 1; },
      },
    }),
    registerShutdown() { throw new Error("shutdown registry unavailable"); },
    logger: { error(...args) { errors.push(args); } },
  });
  assert.equal(service, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdown, 1);
  assert.match(errors[0][1].message, /shutdown registry unavailable/);
});
