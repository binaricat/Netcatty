"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeMcpToolArguments,
  normalizeMcpJsonRpcMessage,
} = require("./normalizeMcpCallArguments.cjs");

test("normalizeMcpToolArguments treats omitted and null as empty object", () => {
  assert.deepEqual(normalizeMcpToolArguments(undefined), {});
  assert.deepEqual(normalizeMcpToolArguments(null), {});
});

test("normalizeMcpToolArguments leaves provided arguments unchanged", () => {
  const args = { sessionId: "s1" };
  assert.equal(normalizeMcpToolArguments(args), args);
  assert.deepEqual(normalizeMcpToolArguments({}), {});
});

test("tools/call with omitted arguments becomes an empty object (#3049)", () => {
  const message = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_environment" },
  };
  const out = normalizeMcpJsonRpcMessage(message);
  assert.equal(out, message);
  assert.deepEqual(out.params.arguments, {});
  assert.equal(out.params.name, "get_environment");
});

test("tools/call with null arguments becomes an empty object (#3049)", () => {
  const message = {
    method: "tools/call",
    params: { name: "list_attachments", arguments: null },
  };
  normalizeMcpJsonRpcMessage(message);
  assert.deepEqual(message.params.arguments, {});
});

test("tools/call with {} or real arguments is left alone", () => {
  const empty = {};
  const emptyMessage = {
    method: "tools/call",
    params: { name: "get_environment", arguments: empty },
  };
  assert.equal(normalizeMcpJsonRpcMessage(emptyMessage).params.arguments, empty);

  const args = { sessionId: "s1", command: "uptime" };
  const realMessage = {
    method: "tools/call",
    params: { name: "terminal_execute", arguments: args },
  };
  assert.equal(normalizeMcpJsonRpcMessage(realMessage).params.arguments, args);
});

test("non tools/call messages are unchanged", () => {
  const initialize = { method: "initialize", params: { protocolVersion: "2024-11-05" } };
  assert.equal(normalizeMcpJsonRpcMessage(initialize), initialize);
  assert.equal(initialize.params.arguments, undefined);

  const notification = { method: "notifications/initialized" };
  assert.equal(normalizeMcpJsonRpcMessage(notification), notification);
});
