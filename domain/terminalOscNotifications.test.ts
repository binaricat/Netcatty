import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OSC_NOTIFICATION_TITLE,
  Osc99Assembler,
  OscNotificationLimiter,
  OscNotificationStreamScanner,
  parseOsc777Payload,
  parseOsc9Payload,
  resolveOscNotificationPresentation,
  sanitizeOscNotificationText,
  shouldShowOscDesktopNotification,
} from "./terminalOscNotifications.ts";

test("parseOsc9Payload treats iTerm-style bodies as notifications", () => {
  assert.deepEqual(parseOsc9Payload("Codex turn complete"), {
    title: "",
    body: "Codex turn complete",
    protocol: "osc9",
  });
  assert.deepEqual(parseOsc9Payload(" approval requested "), {
    title: "",
    body: "approval requested",
    protocol: "osc9",
  });
});

test("parseOsc9Payload ignores ConEmu OSC 9;n sequences", () => {
  assert.equal(parseOsc9Payload("4"), null);
  assert.equal(parseOsc9Payload("4;1;50"), null);
  assert.equal(parseOsc9Payload("3;/tmp"), null);
  assert.equal(parseOsc9Payload(""), null);
  assert.equal(parseOsc9Payload("   "), null);
});

test("parseOsc9Payload keeps bodies that merely start with digits", () => {
  assert.deepEqual(parseOsc9Payload("4 tests failed"), {
    title: "",
    body: "4 tests failed",
    protocol: "osc9",
  });
});

test("parseOsc777Payload handles notify title and body", () => {
  assert.deepEqual(parseOsc777Payload("notify;Nightly Tests;All suites passed"), {
    title: "Nightly Tests",
    body: "All suites passed",
    protocol: "osc777",
  });
  assert.deepEqual(parseOsc777Payload("notify;Deploy;Production;complete"), {
    title: "Deploy",
    body: "Production;complete",
    protocol: "osc777",
  });
  assert.deepEqual(parseOsc777Payload("notify;Only body"), {
    title: "",
    body: "Only body",
    protocol: "osc777",
  });
  assert.equal(parseOsc777Payload("sleep;1"), null);
  assert.equal(parseOsc777Payload("notify;"), null);
});

test("Osc99Assembler emits simple kitty notifications", () => {
  const assembler = new Osc99Assembler();
  assert.deepEqual(assembler.consume(";Hello world"), {
    title: "Hello world",
    body: "",
    protocol: "osc99",
  });
});

test("Osc99Assembler assembles chunked title and body", () => {
  const assembler = new Osc99Assembler();
  assert.equal(assembler.consume("i=1:d=0;Hello world"), null);
  assert.deepEqual(assembler.consume("i=1:p=body;This is cool"), {
    title: "Hello world",
    body: "This is cool",
    protocol: "osc99",
  });
});

test("Osc99Assembler preserves whitespace across chunk boundaries", () => {
  const assembler = new Osc99Assembler();
  assert.equal(assembler.consume("i=1:d=0;Hello "), null);
  assert.deepEqual(assembler.consume("i=1;world"), {
    title: "Hello world",
    body: "",
    protocol: "osc99",
  });
});

test("Osc99Assembler decodes base64 payloads", () => {
  const assembler = new Osc99Assembler();
  assert.deepEqual(assembler.consume("p=body:e=1;SGVsbG8="), {
    title: "",
    body: "Hello",
    protocol: "osc99",
  });
});

test("Osc99Assembler ignores close metadata", () => {
  const assembler = new Osc99Assembler();
  assert.equal(assembler.consume("i=1:d=0;pending"), null);
  assert.equal(assembler.consume("i=1:p=close;"), null);
  assert.deepEqual(assembler.consume("i=1:p=body;too late"), {
    title: "",
    body: "too late",
    protocol: "osc99",
  });
});

test("resolveOscNotificationPresentation prefers explicit title and body", () => {
  assert.deepEqual(
    resolveOscNotificationPresentation({
      title: "Codex",
      body: "Turn complete",
      protocol: "osc9",
    }, "prod-box"),
    { title: "Codex", body: "Turn complete" },
  );
  assert.deepEqual(
    resolveOscNotificationPresentation({
      title: "",
      body: "Turn complete",
      protocol: "osc9",
    }, "prod-box"),
    { title: "prod-box", body: "Turn complete" },
  );
  assert.deepEqual(
    resolveOscNotificationPresentation({
      title: "Hello world",
      body: "",
      protocol: "osc99",
    }, "prod-box"),
    { title: "prod-box", body: "Hello world" },
  );
  assert.equal(
    resolveOscNotificationPresentation({
      title: "",
      body: "",
      protocol: "osc9",
    }).title,
    DEFAULT_OSC_NOTIFICATION_TITLE,
  );
});

test("sanitizeOscNotificationText strips controls and truncates", () => {
  assert.equal(sanitizeOscNotificationText("hello\u0007world", 20), "helloworld");
  assert.equal(sanitizeOscNotificationText("  a   b  ", 20), "a b");
  assert.equal(sanitizeOscNotificationText("abcdefghij", 6), "abcde…");
});

test("shouldShowOscDesktopNotification honors mode and focus", () => {
  assert.equal(shouldShowOscDesktopNotification("off", { windowFocused: false, sessionFocused: false }), false);
  assert.equal(shouldShowOscDesktopNotification("always", { windowFocused: true, sessionFocused: true }), true);
  assert.equal(shouldShowOscDesktopNotification("unfocused", { windowFocused: true, sessionFocused: true }), false);
  assert.equal(shouldShowOscDesktopNotification("unfocused", { windowFocused: true, sessionFocused: false }), true);
  assert.equal(shouldShowOscDesktopNotification("unfocused", { windowFocused: false, sessionFocused: true }), true);
  assert.equal(shouldShowOscDesktopNotification(undefined, { windowFocused: true, sessionFocused: true }), true);
});

test("OscNotificationStreamScanner extracts split OSC 9 sequences and leaves other text", () => {
  const scanner = new OscNotificationStreamScanner();
  const first = scanner.consume("hello\x1b]9;Codex turn");
  assert.deepEqual(first.notifications, []);
  assert.equal(first.remainder, "hello");
  const second = scanner.consume(" complete\x07world");
  assert.deepEqual(second.notifications, [{
    title: "",
    body: "Codex turn complete",
    protocol: "osc9",
  }]);
  assert.equal(second.remainder, "world");
});

test("OscNotificationStreamScanner keeps non-notification OSC in the remainder", () => {
  const scanner = new OscNotificationStreamScanner();
  const result = scanner.consume("pre\x1b]7;file://host/tmp\x07post");
  assert.deepEqual(result.notifications, []);
  assert.equal(result.remainder, "pre\x1b]7;file://host/tmp\x07post");
});

test("OscNotificationStreamScanner flushes an unfinished prefix", () => {
  const scanner = new OscNotificationStreamScanner();
  scanner.consume("\x1b]9;pending");
  assert.equal(scanner.flush(), "\x1b]9;pending");
  assert.equal(scanner.flush(), "");
});

test("OscNotificationStreamScanner aborts a notification OSC at a non-ST escape", () => {
  const scanner = new OscNotificationStreamScanner();
  const result = scanner.consume("hello\x1b]9;bad\x1b[31mRED\x07world");
  assert.deepEqual(result.notifications, []);
  assert.equal(result.remainder, "hello\x1b[31mRED\x07world");
});

test("OscNotificationStreamScanner aborts a notification OSC on CAN or SUB", () => {
  const scanner = new OscNotificationStreamScanner();
  const can = scanner.consume("pre\x1b]9;bad\x18visible\x07");
  assert.deepEqual(can.notifications, []);
  assert.equal(can.remainder, "previsible\x07");
  const sub = scanner.consume("\x1b]777;notify;x;y\x1aafter");
  assert.deepEqual(sub.notifications, []);
  assert.equal(sub.remainder, "after");
});

test("OscNotificationLimiter rate-limits a noisy session", () => {
  const limiter = new OscNotificationLimiter(1_000, 2, 100);
  assert.equal(limiter.allow("s1", 1_000), true);
  assert.equal(limiter.allow("s1", 1_050), false);
  assert.equal(limiter.allow("s1", 1_200), true);
  assert.equal(limiter.allow("s1", 1_400), false);
  assert.equal(limiter.allow("s2", 1_400), true);
});
