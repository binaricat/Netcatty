import assert from "node:assert/strict";
import test from "node:test";

import { classifyError, isRequestTooLargeError, sanitizeErrorMessage } from "./errorClassifier.ts";

// -------------------------------------------------------------------
// sanitizeErrorMessage — regression guard for pre-existing behavior
// -------------------------------------------------------------------

test("sanitizeErrorMessage strips absolute user paths", () => {
  const result = sanitizeErrorMessage("ENOENT at /Users/alice/project/file.ts");
  assert.match(result, /<path>/);
  assert.doesNotMatch(result, /alice/);
});

test("sanitizeErrorMessage redacts URL credentials", () => {
  const result = sanitizeErrorMessage("Failed https://api.example.com/v1?api_key=SECRET123");
  assert.match(result, /<url-redacted>/);
  assert.doesNotMatch(result, /SECRET123/);
});

test("sanitizeErrorMessage truncates very long messages", () => {
  const long = "a".repeat(1000);
  const result = sanitizeErrorMessage(long);
  assert.ok(result.length < 600, `expected truncation, got ${result.length} chars`);
  assert.match(result, /\.\.\.$/);
});

// -------------------------------------------------------------------
// classifyError — 413 detection
// -------------------------------------------------------------------

test("classifyError surfaces a friendly 413 message when statusCode is 413", () => {
  const err = Object.assign(new Error("Request failed with status 413"), {
    statusCode: 413,
    responseBody: "<html>nginx 413</html>",
  });
  const info = classifyError(err);
  assert.equal(info.type, "network");
  assert.match(info.message, /Request too large/i);
  assert.match(info.message, /client_max_body_size/i);
  assert.match(info.message, /Raw:/);
});

test("classifyError detects 'Request Entity Too Large' in a string error", () => {
  const info = classifyError("413 Request Entity Too Large");
  assert.equal(info.type, "network");
  assert.match(info.message, /Request too large/i);
});

test("classifyError handles 413 via the message when no statusCode field is set", () => {
  const info = classifyError(new Error("AI_APICallError: 413 payload rejected"));
  assert.equal(info.type, "network");
  assert.match(info.message, /Request too large/i);
});

test("isRequestTooLargeError detects structured and textual 413 errors", () => {
  assert.equal(isRequestTooLargeError(Object.assign(new Error("blocked"), { statusCode: 413 })), true);
  assert.equal(isRequestTooLargeError("413 Request Entity Too Large"), true);
  assert.equal(isRequestTooLargeError(new Error("AI_APICallError: 413 payload rejected")), true);
  assert.equal(isRequestTooLargeError(Object.assign(new Error("bad gateway"), { statusCode: 502 })), false);
});

test("isRequestTooLargeError detects 413 hidden in an HTML response body", () => {
  const err = Object.assign(new Error("Failed to parse provider response"), {
    responseBody: "<html><body><center><h1>413 Request Entity Too Large</h1></center></body></html>",
  });

  assert.equal(isRequestTooLargeError(err), true);
});

test("isRequestTooLargeError does not treat timing text as HTTP 413", () => {
  assert.equal(isRequestTooLargeError("upstream timed out in 413 ms"), false);
  assert.equal(isRequestTooLargeError("413 ms"), false);
});

// -------------------------------------------------------------------
// classifyError — 502 / 503 / 504 upstream gateway
// -------------------------------------------------------------------

test("classifyError marks 502/503/504 as network+retryable", () => {
  for (const code of [502, 503, 504]) {
    const info = classifyError(Object.assign(new Error(`status ${code}`), { statusCode: code }));
    assert.equal(info.type, "network");
    assert.equal(info.retryable, true, `code ${code} should be retryable`);
    assert.match(info.message, new RegExp(String(code)));
  }
});

test("classifyError does not treat timing text as a gateway status", () => {
  const info = classifyError("retry after 502 ms");
  const leadingInfo = classifyError("502 ms");

  assert.equal(info.type, "unknown");
  assert.equal(leadingInfo.type, "unknown");
});

// -------------------------------------------------------------------
// classifyError — HTML response body
// -------------------------------------------------------------------

test("classifyError detects HTML in responseBody even when status is unknown", () => {
  const err = Object.assign(new Error("Invalid JSON"), {
    responseBody: "<!DOCTYPE html>\n<html><body>nginx error</body></html>",
  });
  const info = classifyError(err);
  assert.equal(info.type, "provider");
  assert.match(info.message, /HTML error page/i);
  assert.match(info.message, /proxy/i);
});

test("classifyError detects HTML directly embedded in the error message", () => {
  const info = classifyError("Parse failed: <html><body>...</body></html>");
  assert.equal(info.type, "provider");
  assert.match(info.message, /HTML error page/i);
});

// -------------------------------------------------------------------
// classifyError — Zod / schema parse failures
// -------------------------------------------------------------------

test("classifyError surfaces a friendlier message for 'Expected \\'id\\' to be a string.'", () => {
  // This is the exact error pattern reported in #765.
  const info = classifyError("Expected 'id' to be a string.");
  assert.equal(info.type, "provider");
  assert.match(info.message, /could not be parsed/i);
  assert.match(info.message, /request-size limit/i);
  // Raw error must still be visible for debugging / user reports.
  assert.match(info.message, /Expected 'id' to be a string/);
});

test("classifyError handles a variety of schema validation wordings", () => {
  for (const raw of [
    "Invalid JSON response: missing field",
    "Type validation failed: expected number",
    "Expected 'choices' to be an array.",
  ]) {
    const info = classifyError(raw);
    assert.equal(info.type, "provider", `wording: ${raw}`);
    assert.match(info.message, /could not be parsed|HTML error page/i);
  }
});

// -------------------------------------------------------------------
// classifyError — fallthrough
// -------------------------------------------------------------------

test("classifyError falls through to 'unknown' for unclassified errors", () => {
  const info = classifyError(new Error("Some other provider failure"));
  assert.equal(info.type, "unknown");
  assert.match(info.message, /Some other provider failure/);
});

test("classifyError handles null, undefined, and non-Error shapes without throwing", () => {
  assert.doesNotThrow(() => classifyError(null));
  assert.doesNotThrow(() => classifyError(undefined));
  assert.doesNotThrow(() => classifyError({ foo: "bar" }));
  assert.doesNotThrow(() => classifyError(42));
});
