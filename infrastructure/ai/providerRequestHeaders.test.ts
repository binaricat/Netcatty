import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENCODE_CLIENT_USER_AGENT,
  OPENCODE_SESSION_HEADER,
  buildSdkRequestHeaders,
  isOpencodeEndpoint,
} from "./providerRequestHeaders";

test("isOpencodeEndpoint matches opencode.ai hosts", () => {
  assert.equal(isOpencodeEndpoint("https://opencode.ai/zen/go/v1"), true);
  assert.equal(isOpencodeEndpoint("https://opencode.ai/inference/go/openai/v1"), true);
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

test("buildSdkRequestHeaders adds OpenCode routing headers for opencode endpoints", () => {
  const headers = buildSdkRequestHeaders(
    { baseURL: "https://opencode.ai/zen/go/v1" },
    "chat-session-1",
  );
  assert.deepEqual(headers, {
    [OPENCODE_SESSION_HEADER]: "chat-session-1",
    "User-Agent": OPENCODE_CLIENT_USER_AGENT,
  });
});

test("buildSdkRequestHeaders only adds OpenCode headers on opencode hosts", () => {
  assert.deepEqual(
    buildSdkRequestHeaders({ baseURL: "https://api.deepseek.com/v1" }, "chat-session-1"),
    {},
  );
  assert.deepEqual(
    buildSdkRequestHeaders({ baseURL: "https://opencode.ai/zen/go/v1" }),
    { "User-Agent": OPENCODE_CLIENT_USER_AGENT },
  );
  assert.deepEqual(buildSdkRequestHeaders({ baseURL: undefined }, "chat-session-1"), {});
});

test("buildSdkRequestHeaders lets a user-supplied session and user agent win", () => {
  const headers = buildSdkRequestHeaders(
    {
      baseURL: "https://opencode.ai/zen/go/v1",
      customHeaders: {
        "X-OpenCode-Session": "my-own-session",
        "User-Agent": "my-agent/2.0",
      },
    },
    "chat-session-1",
  );
  assert.deepEqual(headers, {
    "X-OpenCode-Session": "my-own-session",
    "User-Agent": "my-agent/2.0",
  });
});
