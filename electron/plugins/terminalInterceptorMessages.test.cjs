"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  terminalInterceptorChoiceLabel,
  terminalInterceptorIdentifier,
  terminalInterceptorMessages,
} = require("./terminalInterceptorMessages.cjs");

test("terminal interceptor native prompts cover every application locale and fall back to English", () => {
  for (const locale of ["en", "zh-CN", "zh-TW", "ru"]) {
    const messages = terminalInterceptorMessages(locale);
    assert.ok(messages.noInterceptor);
    assert.ok(messages.selectTitle("input"));
    assert.ok(messages.selectMessage("output"));
    assert.ok(messages.warningTitle);
  }
  assert.equal(terminalInterceptorMessages("fr").noInterceptor, "No interceptor");
});

test("plugin-controlled native selection labels visibly escape control and bidi text", () => {
  assert.equal(terminalInterceptorChoiceLabel({
    pluginId: "com.example.safe",
    pluginDisplayName: "safe\nname\u202e",
    provider: { id: "com.example.input", label: "input\tfilter" },
  }), "safe\\nname\\u202e (com.example.safe): input\\tfilter (com.example.input)");
  assert.equal(terminalInterceptorIdentifier("provider\r\u2066"), "provider\\r\\u2066");
});

test("selection labels keep distinct valid provider identifiers visible in full", () => {
  const shared = `com.example.${"a".repeat(170)}`;
  const first = terminalInterceptorChoiceLabel({
    pluginId: "com.example",
    pluginDisplayName: "Plugin",
    provider: { id: `${shared}.first`, label: "Filter" },
  });
  const second = terminalInterceptorChoiceLabel({
    pluginId: "com.example",
    pluginDisplayName: "Plugin",
    provider: { id: `${shared}.other`, label: "Filter" },
  });
  assert.notEqual(first, second);
  assert.match(first, /\.first\)$/u);
  assert.match(second, /\.other\)$/u);
});
