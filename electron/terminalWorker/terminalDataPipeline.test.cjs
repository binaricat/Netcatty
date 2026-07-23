"use strict";

const assert = require("node:assert/strict");
const { MessageChannel } = require("node:worker_threads");
const test = require("node:test");

const {
  createTerminalDataPipeline,
} = require("./terminalDataPipeline.cjs");
const {
  createTerminalInterceptorEnvelope,
} = require("../plugins/terminalInterceptorTransport.cjs");

function listen(port, listener) {
  port.on("message", listener);
  port.start?.();
}

function readFrame(message) {
  return createTerminalInterceptorEnvelope(message?.frame, message?.transfer);
}

function postResult(port, sequence, creditBytes, data) {
  const envelope = createTerminalInterceptorEnvelope({
    type: "netcatty:terminal-interceptor:result",
    sequence,
    status: "ok",
    creditBytes,
    byteLength: data.byteLength,
  }, data);
  port.postMessage(envelope, [data]);
}

function attachTransform(pipeline, options = {}) {
  const channel = new MessageChannel();
  channel.port1.unref?.();
  channel.port2.unref?.();
  const seen = [];
  listen(channel.port2, (message) => {
    const envelope = readFrame(message);
    const frame = envelope.frame;
    if (frame.type !== "netcatty:terminal-interceptor:chunk") return;
    seen.push({ sequence: frame.sequence, data: Buffer.from(envelope.transfer).toString("utf8") });
    if (options.hold) return;
    const transformed = Buffer.from(options.transform?.(Buffer.from(envelope.transfer).toString("utf8"))
      ?? Buffer.from(envelope.transfer).toString("utf8").toUpperCase());
    const data = Uint8Array.from(transformed).buffer;
    postResult(channel.port2, frame.sequence, frame.byteLength, data);
  });
  pipeline.attach({
    sessionId: options.sessionId ?? "session-1",
    direction: options.direction ?? "input",
    providerId: "com.example.interceptor",
    pluginId: "com.example",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "utility",
    securityPrincipal: "principal-1",
  }, channel.port1);
  return { channel, seen };
}

test("terminal input interception transfers bounded UTF-8 chunks and preserves ordering", async () => {
  const pipeline = createTerminalDataPipeline({ inputDeadlineMs: 100 });
  const { seen } = attachTransform(pipeline);
  assert.equal(await pipeline.interceptInput("session-1", "hello"), "HELLO");
  assert.equal(await pipeline.interceptInput("session-1", "world"), "WORLD");
  assert.deepEqual(seen, [
    { sequence: 1, data: "hello" },
    { sequence: 2, data: "world" },
  ]);
  pipeline.shutdown();
});

test("terminal interception keeps multi-byte UTF-8 characters whole at the chunk boundary", async () => {
  for (const direction of ["input", "output"]) {
    const pipeline = createTerminalDataPipeline({ inputDeadlineMs: 100, outputDeadlineMs: 100 });
    const { seen } = attachTransform(pipeline, { direction, transform: (value) => value });
    const value = `${"a".repeat(65535)}你b`;
    const result = direction === "input"
      ? await pipeline.interceptInput("session-1", value)
      : await pipeline.interceptOutput("session-1", value);
    assert.equal(result, value);
    assert.deepEqual(seen.map((entry) => Buffer.byteLength(entry.data)), [65535, 4]);
    assert.equal(seen.map((entry) => entry.data).join(""), value);
    pipeline.shutdown();
  }
});

test("sensitive input bypasses the third-party port unconditionally", async () => {
  const pipeline = createTerminalDataPipeline({ inputDeadlineMs: 100 });
  const { seen } = attachTransform(pipeline);
  assert.equal(await pipeline.interceptInput("session-1", "password\r", { sensitive: true }), "password\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, []);
  assert.equal(pipeline.has("session-1", "input"), true);
  pipeline.shutdown();
});

test("sensitive passthrough stays ordered behind earlier intercepted input", async () => {
  const pipeline = createTerminalDataPipeline({ inputDeadlineMs: 100 });
  const channel = new MessageChannel();
  channel.port1.unref?.();
  channel.port2.unref?.();
  let firstChunk;
  listen(channel.port2, (message) => {
    const envelope = readFrame(message);
    if (envelope.frame.type === "netcatty:terminal-interceptor:chunk") firstChunk = envelope.frame;
  });
  pipeline.attach({
    sessionId: "session-1",
    direction: "input",
    providerId: "com.example.interceptor",
    pluginId: "com.example",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "utility",
    securityPrincipal: "principal-1",
  }, channel.port1);
  const order = [];
  const ordinary = pipeline.interceptInput("session-1", "a").then((value) => order.push(value));
  const sensitive = pipeline.interceptInput("session-1", "secret", { sensitive: true })
    .then((value) => order.push(value));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(firstChunk);
  assert.deepEqual(order, []);
  const result = Uint8Array.from(Buffer.from("A")).buffer;
  postResult(channel.port2, firstChunk.sequence, 1, result);
  await Promise.all([ordinary, sensitive]);
  assert.deepEqual(order, ["A", "secret"]);
  pipeline.shutdown();
});

test("replacing an input interceptor preserves host-detected sensitive state", async () => {
  const pipeline = createTerminalDataPipeline({ inputDeadlineMs: 100 });
  const first = attachTransform(pipeline, { transform: (data) => data });
  pipeline.observeOutput("session-1", "Password:");
  assert.equal(await pipeline.interceptInput("session-1", "first-secret"), "first-secret");

  const second = attachTransform(pipeline, { transform: (data) => data });
  assert.equal(await pipeline.interceptInput("session-1", "second-secret"), "second-secret");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.seen.length, 0);

  pipeline.shutdown();
  first.channel.port2.close();
  second.channel.port2.close();
});

test("original output protects password input even when a plugin could hide the prompt", async () => {
  const pipeline = createTerminalDataPipeline({ inputDeadlineMs: 100 });
  const { seen } = attachTransform(pipeline);
  assert.equal(pipeline.getOutputMode("session-1"), 1);
  pipeline.observeOutput("session-1", "\u001b[31mPass");
  pipeline.observeOutput("session-1", "word:\u001b[0m ");
  assert.equal(await pipeline.interceptInput("session-1", "hunter2"), "hunter2");
  assert.equal(await pipeline.interceptInput("session-1", "\r"), "\r");
  assert.deepEqual(seen, []);
  assert.equal(await pipeline.interceptInput("session-1", "next"), "NEXT");
  assert.deepEqual(seen, [{ sequence: 1, data: "next" }]);
  pipeline.observeOutput("session-1", "Pass\u001b[0");
  assert.equal(pipeline.observeOutput("session-1", "mword: "), true);
  assert.equal(await pipeline.interceptInput("session-1", "split-secret\r"), "split-secret\r");
  pipeline.observeOutput("session-1", "Custom authentication> ");
  assert.equal(await pipeline.interceptInput("session-1", "opaque\r"), "opaque\r");
  pipeline.observeOutput("session-1", "请输入验证码：");
  assert.equal(await pipeline.interceptInput("session-1", "123456\r"), "123456\r");
  assert.deepEqual(seen, [{ sequence: 1, data: "next" }]);
  pipeline.shutdown();
});

test("a confirmed shell prompt clears sensitive mode when authentication is abandoned", async () => {
  const pipeline = createTerminalDataPipeline({ inputDeadlineMs: 100 });
  const { seen } = attachTransform(pipeline);

  assert.equal(pipeline.observeOutput("session-1", "Password: "), true);
  assert.equal(await pipeline.interceptInput("session-1", "secret"), "secret");
  assert.deepEqual(seen, []);

  assert.equal(pipeline.observeOutput("session-1", "\r\nAccess denied\r\n$ "), false);
  assert.equal(await pipeline.interceptInput("session-1", "next"), "NEXT");
  assert.deepEqual(seen, [{ sequence: 1, data: "next" }]);
  pipeline.shutdown();
});

test("output-only interception classifies sensitive prompts without retaining stale input state", () => {
  const pipeline = createTerminalDataPipeline();
  attachTransform(pipeline, { direction: "output" });

  assert.equal(pipeline.observeOutput("session-1", "Pass"), false);
  assert.equal(pipeline.observeOutput("session-1", "word: "), true);
  assert.equal(pipeline.observeOutput("session-1", "\r\nordinary output"), false);
  pipeline.shutdown();
});

test("an input interceptor attached after a visible password prompt starts in sensitive mode", async () => {
  const pipeline = createTerminalDataPipeline({ inputDeadlineMs: 100 });
  attachTransform(pipeline, { direction: "output", transform: (data) => data });
  assert.equal(pipeline.observeOutput("session-1", "Password: "), true);

  const { seen } = attachTransform(pipeline, { direction: "input" });
  assert.equal(await pipeline.interceptInput("session-1", "secret\r"), "secret\r");
  assert.deepEqual(seen, []);
  pipeline.shutdown();
});

test("clearing sensitive input on interrupt restores ordinary interception", async () => {
  const pipeline = createTerminalDataPipeline({ inputDeadlineMs: 100 });
  const { seen } = attachTransform(pipeline);
  attachTransform(pipeline, { direction: "output" });

  assert.equal(pipeline.observeOutput("session-1", "Password: "), true);
  assert.equal(await pipeline.interceptInput("session-1", "secret"), "secret");
  assert.deepEqual(seen, []);

  pipeline.clearSensitiveInput("session-1");
  assert.equal(await pipeline.interceptInput("session-1", "next"), "NEXT");
  assert.deepEqual(seen, [{ sequence: 1, data: "next" }]);
  pipeline.shutdown();
});

test("an input deadline failure fails open, disables the session binding, and warns once", async () => {
  const warnings = [];
  const pipeline = createTerminalDataPipeline({ inputDeadlineMs: 5, onWarning: (value) => warnings.push(value) });
  attachTransform(pipeline, { hold: true });
  assert.equal(await pipeline.interceptInput("session-1", "slow"), "slow");
  assert.equal(pipeline.has("session-1", "input"), false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "timeout");
  assert.equal(await pipeline.interceptInput("session-1", "later"), "later");
  assert.equal(warnings.length, 1);
});

test("an elapsed deadline rejects a late response before its delayed timer callback runs", async () => {
  const warnings = [];
  let now = 1_000;
  const pipeline = createTerminalDataPipeline({
    inputDeadlineMs: 100,
    now: () => now,
    onWarning: (value) => warnings.push(value),
  });
  const channel = new MessageChannel();
  channel.port1.unref?.();
  channel.port2.unref?.();
  listen(channel.port2, (message) => {
    const envelope = readFrame(message);
    if (envelope.frame.type !== "netcatty:terminal-interceptor:chunk") return;
    now += 100;
    const data = Uint8Array.from(Buffer.from("LATE")).buffer;
    postResult(channel.port2, envelope.frame.sequence, envelope.frame.byteLength, data);
  });
  pipeline.attach({
    sessionId: "session-1",
    direction: "input",
    providerId: "com.example.interceptor",
    pluginId: "com.example",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "utility",
    securityPrincipal: "principal-1",
  }, channel.port1);

  assert.equal(await pipeline.interceptInput("session-1", "original"), "original");
  assert.equal(pipeline.has("session-1", "input"), false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "timeout");
});

test("an unsolicited interceptor result trips the protocol circuit breaker", async () => {
  const warnings = [];
  const pipeline = createTerminalDataPipeline({
    inputDeadlineMs: 100,
    onWarning: (value) => warnings.push(value),
  });
  const { channel } = attachTransform(pipeline, { hold: true });
  const data = Uint8Array.from(Buffer.from("UNSOLICITED")).buffer;
  postResult(channel.port2, 999, data.byteLength, data);
  for (let attempt = 0; attempt < 10 && pipeline.has("session-1", "input"); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pipeline.has("session-1", "input"), false);
  assert.deepEqual(warnings.map((warning) => warning.code), ["protocol"]);
});

test("a duplicate interceptor result trips the protocol circuit breaker", async () => {
  const warnings = [];
  const pipeline = createTerminalDataPipeline({
    inputDeadlineMs: 100,
    onWarning: (value) => warnings.push(value),
  });
  const { channel, seen } = attachTransform(pipeline, { hold: true });
  const transformed = pipeline.interceptInput("session-1", "a");
  for (let attempt = 0; attempt < 10 && seen.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(seen.length, 1);
  const first = Uint8Array.from(Buffer.from("A")).buffer;
  const duplicate = Uint8Array.from(Buffer.from("A")).buffer;
  postResult(channel.port2, seen[0].sequence, 1, first);
  postResult(channel.port2, seen[0].sequence, 1, duplicate);
  assert.equal(await transformed, "A");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pipeline.has("session-1", "input"), false);
  assert.deepEqual(warnings.map((warning) => warning.code), ["protocol"]);
});

test("output interception is credit bounded and fails open under backpressure", async () => {
  const warnings = [];
  const pipeline = createTerminalDataPipeline({
    outputDeadlineMs: 100,
    outputWindowBytes: 5,
    onWarning: (value) => warnings.push(value),
  });
  attachTransform(pipeline, { direction: "output", hold: true });
  const order = [];
  const first = pipeline.interceptOutput("session-1", "1234")
    .then((value) => { order.push(value); return value; });
  const second = pipeline.interceptOutput("session-1", "5678")
    .then((value) => { order.push(value); return value; });
  assert.deepEqual(await Promise.all([first, second]), ["1234", "5678"]);
  assert.deepEqual(order, ["1234", "5678"]);
  assert.equal(warnings[0].code, "backpressure");
  assert.equal(pipeline.has("session-1", "output"), false);
});

test("output expansion consumes bounded credit before transformed data is delivered", async () => {
  const warnings = [];
  const pipeline = createTerminalDataPipeline({
    outputDeadlineMs: 100,
    outputWindowBytes: 5,
    onWarning: (value) => warnings.push(value),
  });
  attachTransform(pipeline, {
    direction: "output",
    transform: () => "12345",
  });

  assert.equal(await pipeline.interceptOutput("session-1", "a"), "12345");
  assert.equal(await pipeline.interceptOutput("session-1", "b"), "b");
  assert.equal(pipeline.has("session-1", "output"), false);
  assert.equal(warnings.at(-1).code, "backpressure");
});

test("queued output keeps the deadline from its arrival time", async () => {
  let now = 0;
  const warnings = [];
  const pipeline = createTerminalDataPipeline({
    now: () => now,
    outputDeadlineMs: 100,
    onWarning: (value) => warnings.push(value),
  });
  const channel = new MessageChannel();
  channel.port1.unref?.();
  channel.port2.unref?.();
  const chunks = [];
  listen(channel.port2, (message) => {
    const envelope = readFrame(message);
    if (envelope.frame.type === "netcatty:terminal-interceptor:chunk") chunks.push(envelope.frame);
  });
  pipeline.attach({
    sessionId: "session-1",
    direction: "output",
    providerId: "com.example.interceptor",
    pluginId: "com.example",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "utility",
    securityPrincipal: "principal-1",
  }, channel.port1);

  const first = pipeline.interceptOutput("session-1", "first");
  const second = pipeline.interceptOutput("session-1", "second");
  for (let attempt = 0; attempt < 10 && chunks.length < 1; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(chunks.length, 1);
  now = 90;
  const firstData = Uint8Array.from(Buffer.from("FIRST")).buffer;
  postResult(channel.port2, chunks[0].sequence, 5, firstData);
  for (let attempt = 0; attempt < 10 && chunks.length < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(chunks.length, 2);
  now = 101;
  const secondData = Uint8Array.from(Buffer.from("SECOND")).buffer;
  postResult(channel.port2, chunks[1].sequence, 6, secondData);

  assert.deepEqual(await Promise.all([first, second]), ["FIRST", "second"]);
  assert.equal(warnings.at(-1).code, "timeout");
  assert.equal(pipeline.has("session-1", "output"), false);
});

test("invalid interceptor UTF-8 fails open and permanently trips the circuit breaker", async () => {
  const warnings = [];
  const pipeline = createTerminalDataPipeline({ inputDeadlineMs: 100, onWarning: (value) => warnings.push(value) });
  const channel = new MessageChannel();
  channel.port1.unref?.();
  channel.port2.unref?.();
  listen(channel.port2, (message) => {
    const envelope = readFrame(message);
    if (envelope.frame.type !== "netcatty:terminal-interceptor:chunk") return;
    const data = Uint8Array.from([0xff]).buffer;
    postResult(channel.port2, envelope.frame.sequence, 4, data);
  });
  pipeline.attach({
    sessionId: "session-1",
    direction: "input",
    providerId: "com.example.interceptor",
    pluginId: "com.example",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "utility",
    securityPrincipal: "principal-1",
  }, channel.port1);
  assert.equal(await pipeline.interceptInput("session-1", "safe"), "safe");
  assert.equal(warnings[0].code, "encoding");
  assert.equal(pipeline.has("session-1", "input"), false);
});

test("the worker rejects a result that bypasses the canonical terminal frame schema", async () => {
  const warnings = [];
  const pipeline = createTerminalDataPipeline({
    inputDeadlineMs: 100,
    onWarning: (value) => warnings.push(value),
  });
  const channel = new MessageChannel();
  channel.port1.unref?.();
  channel.port2.unref?.();
  listen(channel.port2, (message) => {
    const envelope = readFrame(message);
    if (envelope.frame.type !== "netcatty:terminal-interceptor:chunk") return;
    const data = Uint8Array.from(Buffer.from("UNSAFE")).buffer;
    channel.port2.postMessage({
      frame: {
        type: "netcatty:terminal-interceptor:result",
        sequence: envelope.frame.sequence,
        status: "ok",
        creditBytes: envelope.frame.byteLength,
        byteLength: data.byteLength,
        extra: true,
      },
      transfer: data,
    }, [data]);
  });
  pipeline.attach({
    sessionId: "session-1",
    direction: "input",
    providerId: "com.example.interceptor",
    pluginId: "com.example",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "utility",
    securityPrincipal: "principal-1",
  }, channel.port1);

  assert.equal(await pipeline.interceptInput("session-1", "safe"), "safe");
  assert.equal(pipeline.has("session-1", "input"), false);
  assert.equal(warnings.at(-1).code, "protocol");
});
