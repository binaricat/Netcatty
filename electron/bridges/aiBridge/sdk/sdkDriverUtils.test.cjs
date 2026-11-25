"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  attachAbortGraceKill,
  buildMultimodalUserPrompt,
  collectBoundedStdout,
  createAbortWait,
  createBoundedTextCollector,
  createIdleAbortableInput,
  createLineBuffer,
  createStopWait,
  findFirstExistingExecutable,
  forwardAnthropicStreamEvent,
  forwardAnthropicToolResultBlocks,
  querySupportedModelsWithIdleSession,
  resultToText,
  signalProcessTree,
} = require("./sdkDriverUtils.cjs");

describe("sdkDriverUtils", () => {
  it("createLineBuffer splits UTF-8 chunks and enforces byte limit with custom label/code", () => {
    const lines = [];
    const lb = createLineBuffer((line) => lines.push(line), {
      maxBytes: 12,
      errorLabel: "Custom CLI",
      errorCode: "CUSTOM_LIMIT",
    });
    const emoji = Buffer.from("hi\u{1F600}\nnext", "utf8");
    lb.push(emoji.subarray(0, 4));
    lb.push(emoji.subarray(4));
    lb.flush();
    assert.deepEqual(lines, ["hi\u{1F600}", "next"]);

    const overflow = createLineBuffer(() => {}, {
      maxBytes: 4,
      errorLabel: "Custom CLI",
      errorCode: "CUSTOM_LIMIT",
    });
    assert.throws(
      () => overflow.push("12345"),
      (err) => err.code === "CUSTOM_LIMIT" && err.message === "Custom CLI message exceeded 4 bytes",
    );
    // Subsequent push/flush after overflow are ignored.
    assert.doesNotThrow(() => overflow.push("67890"));
    assert.doesNotThrow(() => overflow.flush());
  });

  it("createBoundedTextCollector caps UTF-8 output without trailing replacement chars on truncated multibyte", () => {
    const collector = createBoundedTextCollector(4);
    // "ab" (2 bytes) + 4-byte emoji (only first 2 bytes fit -> truncated mid-sequence)
    collector.push(Buffer.from("ab\u{1F600}", "utf8"));
    assert.equal(collector.text(), "ab");
    assert.equal(collector.end(), "ab");
    assert.equal(collector.end(), "ab");
  });

  it("signalProcessTree delegates to forceKillImpl when provided and tolerates errors", () => {
    const calls = [];
    const child = { pid: 12345, kill(sig) { calls.push(["direct", sig]); } };
    signalProcessTree(child, "SIGTERM", (c, sig) => calls.push(["custom", c.pid, sig]));
    signalProcessTree(child, "SIGKILL", () => { throw new Error("ignore"); });
    assert.deepEqual(calls, [["custom", 12345, "SIGTERM"]]);
  });

  it("attachAbortGraceKill sends SIGTERM then SIGKILL after grace period and invokes hooks", async () => {
    const signals = [];
    const hooks = [];
    const child = { pid: 42, kill(sig) { signals.push(["direct", sig]); } };
    const ac = new AbortController();
    let settled = false;

    const guard = attachAbortGraceKill(child, {
      signal: ac.signal,
      abortGraceMs: 15,
      forceKillImpl: (_c, sig) => signals.push(["kill", sig]),
      termForceKillImpl: (_c, sig) => signals.push(["term", sig]),
      isSettled: () => settled,
      onBeforeSignal: () => hooks.push("before"),
      onAfterTerm: () => hooks.push("after"),
      onGraceTimeout: () => {
        settled = true;
        hooks.push("timeout");
      },
    });

    ac.abort();
    await new Promise((resolve) => setTimeout(resolve, 40));
    guard.dispose();

    assert.deepEqual(signals, [["term", "SIGTERM"], ["kill", "SIGKILL"]]);
    assert.deepEqual(hooks, ["before", "after", "timeout"]);
  });

  it("collectBoundedStdout collects stdout on close and returns null on abort timeout or error", async () => {
    const ok = await collectBoundedStdout({
      spawnChild: () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.kill = () => {};
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from("line1\n"));
          child.stdout.emit("data", Buffer.from("line2\n"));
          child.emit("close", 0);
        });
        return child;
      },
      maxBytes: 1024,
    });
    assert.equal(ok, "line1\nline2\n");

    const ac = new AbortController();
    const kills = [];
    // Keep the event loop referenced on Node 20 while the fake EventEmitter child
    // waits for attachAbortGraceKill's unref'd grace timer to fire.
    const keepAlive = setTimeout(() => {}, 1000);
    let aborted;
    try {
      aborted = await collectBoundedStdout({
        spawnChild: () => {
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.kill = () => {};
          queueMicrotask(() => ac.abort());
          return child;
        },
        maxBytes: 1024,
        signal: ac.signal,
        abortGraceMs: 10,
        forceKillImpl: (_c, sig) => kills.push(sig),
      });
    } finally {
      clearTimeout(keepAlive);
    }
    assert.equal(aborted, null);
    assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
  });

  it("resultToText respects driver-specific object field flags", () => {
    assert.equal(resultToText(null), "");
    assert.equal(resultToText(42), "42");
    assert.equal(resultToText({ content: "c" }), "c");
    assert.equal(
      resultToText({ success: { content: "ok" } }, { includeSuccessContent: true }),
      "ok",
    );
    assert.equal(
      resultToText({ success: { content: "ok" } }),
      "{\"success\":{\"content\":\"ok\"}}",
    );
    assert.equal(resultToText({ text: "t" }, { includeText: true }), "t");
    assert.equal(resultToText({ message: "m" }, { includeMessage: true }), "m");
    assert.equal(resultToText({ message: "m" }, { includeText: true }), "{\"message\":\"m\"}");
  });

  it("buildMultimodalUserPrompt returns string without valid images and async iterable with images", async () => {
    assert.equal(buildMultimodalUserPrompt("hello", []), "hello");
    assert.equal(
      buildMultimodalUserPrompt("hello", [{ mediaType: "application/pdf", base64Data: "abc" }]),
      "hello",
    );

    const iterable = buildMultimodalUserPrompt("inspect", [
      { mediaType: "IMAGE/PNG", base64Data: "AAAA" },
      { mediaType: "text/plain", base64Data: "ignored" },
    ]);
    const chunks = [];
    for await (const chunk of iterable) chunks.push(chunk);
    assert.deepEqual(chunks, [
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAA" },
            },
          ],
        },
        parent_tool_use_id: null,
      },
    ]);
  });

  it("createIdleAbortableInput and querySupportedModelsWithIdleSession resolve and clean up on abort", async () => {
    const ac = new AbortController();
    const gen = createIdleAbortableInput(ac.signal);
    const nextPromise = gen.next();
    ac.abort();
    const step = await nextPromise;
    assert.equal(step.done, true);

    let returned = false;
    const models = await querySupportedModelsWithIdleSession({
      queryFn: ({ options }) => ({
        async supportedModels() {
          assert.equal(options.includePartialMessages, false);
          return [{ id: "m1" }];
        },
        return() {
          returned = true;
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
      queryOptions: { custom: true },
      mapModels: (list) => list.map((m) => m.id),
    });
    assert.deepEqual(models, ["m1"]);
    assert.equal(returned, true);
  });

  it("forwardAnthropicStreamEvent and forwardAnthropicToolResultBlocks forward expected payloads", () => {
    const events = [];
    const emitter = {
      text: (t) => events.push(["text", t]),
      reasoning: (r) => events.push(["reasoning", r]),
      toolResult: (id, out, name) => events.push(["toolResult", id, out, name]),
    };

    forwardAnthropicStreamEvent(
      { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      emitter,
    );
    forwardAnthropicStreamEvent(
      { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
      emitter,
    );
    forwardAnthropicStreamEvent({ type: "message_start" }, emitter);
    forwardAnthropicToolResultBlocks(
      [
        { type: "tool_result", tool_use_id: "t1", content: "plain" },
        { type: "tool_result", tool_use_id: "t2", content: [{ text: "obj" }] },
        { type: "text", text: "skip" },
      ],
      emitter,
    );

    assert.deepEqual(events, [
      ["text", "hi"],
      ["reasoning", "hmm"],
      ["toolResult", "t1", "plain", undefined],
      ["toolResult", "t2", "[{\"text\":\"obj\"}]", undefined],
    ]);
  });

  it("createAbortWait and createStopWait resolve deterministically and dispose cleanly", async () => {
    const ac = new AbortController();
    const wait = createAbortWait(ac.signal);
    let resolved = false;
    wait.promise.then(() => { resolved = true; });
    ac.abort();
    await wait.promise;
    assert.equal(resolved, true);
    wait.dispose();

    const preAborted = createAbortWait(ac.signal);
    await preAborted.promise;

    const stopWait = createStopWait();
    assert.equal(stopWait.stopped, false);
    stopWait.stop();
    stopWait.stop();
    assert.equal(stopWait.stopped, true);
    await stopWait.promise;
  });

  it("findFirstExistingExecutable skips missing paths and directories and returns first file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-driver-utils-"));
    try {
      const binPath = path.join(tmpDir, "tool-bin");
      fs.writeFileSync(binPath, "#!/bin/sh\n");
      assert.equal(
        findFirstExistingExecutable([
          undefined,
          path.join(tmpDir, "missing"),
          tmpDir,
          binPath,
        ]),
        binPath,
      );
      assert.equal(findFirstExistingExecutable([tmpDir, path.join(tmpDir, "missing")]), undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
