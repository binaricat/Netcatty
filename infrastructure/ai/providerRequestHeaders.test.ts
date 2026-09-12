import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENCODE_SESSION_HEADER,
  buildSdkRequestHeaders,
  isOpencodeEndpoint,
} from "./providerRequestHeaders";

test("isOpencodeEndpoint matches opencode.ai hosts", () => {
  assert.equal(isOpencodeEndpoint("https://opencode.ai/zen/go/v1"), true);
  assert.equal(isOpencodeEndpoint("https://opencode.ai/zen/v1"), true);
  assert.equal(isOpencodeEndpoint("https://gateway.opencode.ai/v1"), true);
  assert.equal(isOpencodeEndpoint("https://opencode.ai"), true);
  assert.equal(isOpencodeEndpoint(undefined), false);
  assert.equal(isOpencodeEndpoint(""), false);
  assert.equal(isOpencodeEndpoint("https://api.openai.com/v1"), false);
  assert.equal(isOpencodeEndpoint("https://notopencode.ai/v1"), false);
  assert.equal(isOpencodeEndpoint("http://localhost:11434/v1"), false);
  assert.equal(isOpencodeEndpoint("not a url"), false);
});

test("buildSdkRequestHeaders passes customHeaders through verbatim", () => {
  const headers = buildSdkRequestHeaders({
    baseURL: "https://api.example.com/v1",
    customHeaders: { "X-Custom": "a", Authorization: "Bearer x" },
  });
  assert.deepEqual(headers, { "X-Custom": "a", Authorization: "Bearer x" });
});

test("buildSdkRequestHeaders adds the OpenCode session header for opencode endpoints", () => {
  const headers = buildSdkRequestHeaders(
    { baseURL: "https://opencode.ai/zen/go/v1" },
    "chat-session-1",
  );
  assert.deepEqual(headers, { [OPENCODE_SESSION_HEADER]: "chat-session-1" });
});

test("buildSdkRequestHeaders adds no session header off opencode or without a session id", () => {
  assert.deepEqual(
    buildSdkRequestHeaders({ baseURL: "https://api.deepseek.com/v1" }, "chat-session-1"),
    {},
  );
  assert.deepEqual(buildSdkRequestHeaders({ baseURL: "https://opencode.ai/zen/go/v1" }), {});
  assert.deepEqual(buildSdkRequestHeaders({ baseURL: undefined }, "chat-session-1"), {});
});

test("buildSdkRequestHeaders lets a user-supplied session header win", () => {
  const headers = buildSdkRequestHeaders(
    {
      baseURL: "https://opencode.ai/zen/go/v1",
      customHeaders: { "X-OpenCode-Session": "my-own-session" },
    },
    "chat-session-1",
  );
  assert.deepEqual(headers, { "X-OpenCode-Session": "my-own-session" });
});
