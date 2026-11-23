import assert from "node:assert/strict";
import test from "node:test";

import {
  anthropicBaseIncludesV1,
  isBareOriginBaseURL,
  normalizeAnthropicSdkBaseURL,
  stripTrailingSlashes,
} from "./anthropicCompatBaseUrl";

test("stripTrailingSlashes trims and drops trailing slashes", () => {
  assert.equal(stripTrailingSlashes("  https://host/v1/  "), "https://host/v1");
  assert.equal(stripTrailingSlashes(""), "");
});

test("anthropicBaseIncludesV1 detects AI SDK style bases", () => {
  assert.equal(anthropicBaseIncludesV1("https://api.anthropic.com/v1"), true);
  assert.equal(anthropicBaseIncludesV1("https://api.anthropic.com/v1/"), true);
  assert.equal(anthropicBaseIncludesV1("https://gateway.example/api/v1"), true);
  assert.equal(anthropicBaseIncludesV1("https://api.anthropic.com"), false);
  assert.equal(anthropicBaseIncludesV1("https://gateway.example/"), false);
});

test("isBareOriginBaseURL only matches scheme+host with no path", () => {
  assert.equal(isBareOriginBaseURL("https://api.anthropic.com"), true);
  assert.equal(isBareOriginBaseURL("https://gateway.example/"), true);
  assert.equal(isBareOriginBaseURL("http://localhost:8080"), true);
  assert.equal(isBareOriginBaseURL("https://gateway.example/v1"), false);
  assert.equal(isBareOriginBaseURL("https://proxy.example/anthropic"), false);
  assert.equal(isBareOriginBaseURL("https://gateway.example/api"), false);
  assert.equal(isBareOriginBaseURL(""), false);
});

test("normalizeAnthropicSdkBaseURL accepts Claude Code and AI SDK conventions", () => {
  assert.equal(
    normalizeAnthropicSdkBaseURL("https://api.anthropic.com"),
    "https://api.anthropic.com/v1",
  );
  assert.equal(
    normalizeAnthropicSdkBaseURL("https://gateway.example/"),
    "https://gateway.example/v1",
  );
  assert.equal(
    normalizeAnthropicSdkBaseURL("https://gateway.example/v1"),
    "https://gateway.example/v1",
  );
  assert.equal(
    normalizeAnthropicSdkBaseURL("https://gateway.example/v1/"),
    "https://gateway.example/v1",
  );
  assert.equal(normalizeAnthropicSdkBaseURL("   "), "");
});

test("normalizeAnthropicSdkBaseURL preserves custom non-/v1 path prefixes", () => {
  // Proxy that already completes the SDK base: …/anthropic/messages, not …/anthropic/v1/messages.
  assert.equal(
    normalizeAnthropicSdkBaseURL("https://proxy.example/anthropic"),
    "https://proxy.example/anthropic",
  );
  assert.equal(
    normalizeAnthropicSdkBaseURL("https://proxy.example/anthropic/"),
    "https://proxy.example/anthropic",
  );
  assert.equal(
    normalizeAnthropicSdkBaseURL("https://gateway.example/api"),
    "https://gateway.example/api",
  );
  // Nested AI SDK style still ends in /v1 and stays as-is.
  assert.equal(
    normalizeAnthropicSdkBaseURL("https://gateway.example/api/v1"),
    "https://gateway.example/api/v1",
  );
});

test("normalizes the official Ark Agent Plan Anthropic prefix only", () => {
  const base = "https://ark.cn-beijing.volces.com/api/plan";
  for (const input of [base, base + "/", " " + base + " ", base + "/v1", base + "/v1/"]) {
    assert.equal(normalizeAnthropicSdkBaseURL(input), base + "/v1");
  }
  for (const input of [
    base.replace("https:", "http:"),
    base.replace(".com", ".com.example"),
    base.replace(".com", ".com:8443"),
    base + "/custom",
    "https://gateway.example/api/plan",
  ]) {
    assert.equal(normalizeAnthropicSdkBaseURL(input), input);
  }
});
