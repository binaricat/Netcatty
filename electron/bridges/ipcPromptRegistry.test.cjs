"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createIpcPromptRegistry } = require("./ipcPromptRegistry.cjs");
const fidoPromptHandler = require("./fidoPromptHandler.cjs");
const passphraseHandler = require("./passphraseHandler.cjs");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");

function withPatchedTimeouts(run) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let nextId = 1;
  const timeouts = new Map();

  global.setTimeout = (fn, delay, ...args) => {
    const id = nextId++;
    timeouts.set(id, { fn: () => fn(...args), delay });
    return id;
  };
  global.clearTimeout = (id) => {
    timeouts.delete(id);
  };

  return Promise.resolve()
    .then(() =>
      run({
        getPendingTimeouts: () => [...timeouts.values()],
        fireAllTimeouts: () => {
          const items = [...timeouts.entries()];
          timeouts.clear();
          for (const [, item] of items) item.fn();
        },
      }))
    .finally(() => {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    });
}

test("createIpcPromptRegistry enforces sender verification, ordering, TTL cleanup, and idempotent settlement", async () => {
  await withPatchedTimeouts(({ getPendingTimeouts, fireAllTimeouts }) => {
    const events = [];
    const registry = createIpcPromptRegistry({
      prefix: "test",
      ttlMs: 5000,
      cancelChannel: "netcatty:test-cancelled",
      logTag: "[TestPrompt]",
      notifyBeforeResolve: true,
    });

    const id = registry.generateRequestId();
    assert.match(id, /^test-/);

    const sender = {
      id: 7,
      isDestroyed: () => false,
      send: (channel, payload) => events.push({ kind: "send", channel, payload }),
    };

    registry.register(
      id,
      {
        resolveCallback: (result) => events.push({ kind: "resolve", result }),
        sender,
        webContentsId: 7,
      },
      {
        onTimeout: (timedOutId) => registry.cancel(timedOutId, "timeout", { timedOut: true }),
      },
    );

    assert.equal(getPendingTimeouts().length, 1);
    assert.equal(getPendingTimeouts()[0].delay, 5000);
    assert.deepEqual(registry.verifySender({ sender: { id: 99 } }, id), {
      ok: false,
      error: "Wrong sender",
    });
    assert.deepEqual(registry.verifySender({ sender: { id: 7 } }, "missing"), {
      ok: false,
      error: "Request not found",
    });
    assert.equal(registry.verifySender({ sender: { id: 7 } }, id).ok, true);

    fireAllTimeouts();
    assert.equal(registry.getMap().size, 0);
    assert.deepEqual(events, [
      { kind: "send", channel: "netcatty:test-cancelled", payload: { requestId: id, reason: "timeout" } },
      { kind: "resolve", result: { timedOut: true } },
    ]);

    // Settling again is a safe no-op.
    assert.equal(registry.settle(id, { second: true }), false);
  });
});

test("handler timeout semantics stay distinct across FIDO, passphrase, and keyboard-interactive", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "log", () => {});

  await withPatchedTimeouts(async ({ fireAllTimeouts }) => {
    const fidoSent = [];
    const fidoPromise = fidoPromptHandler.requestFidoPrompt(
      { id: 1, isDestroyed: () => false, send: (ch, p) => fidoSent.push({ ch, p }) },
      { kind: "pin", message: "PIN" },
    );

    const ppSent = [];
    const ppPromise = passphraseHandler.requestPassphrase(
      { id: 2, isDestroyed: () => false, send: (ch, p) => ppSent.push({ ch, p }) },
      "/tmp/id_ed25519",
      "id_ed25519",
      "host.example",
      false,
    );

    const kiEvents = [];
    const kiId = keyboardInteractiveHandler.generateRequestId();
    keyboardInteractiveHandler.storeRequest(
      kiId,
      (responses) => kiEvents.push({ kind: "finish", responses }),
      3,
      "session-ki-timeout",
      {
        isDestroyed: () => false,
        send: (ch, p) => kiEvents.push({ kind: "send", ch, p }),
      },
    );

    fireAllTimeouts();

    // 1. FIDO resolves { cancelled: true } and sends fido-prompt-timeout.
    assert.deepEqual(await fidoPromise, { cancelled: true });
    assert.ok(fidoSent.some((m) => m.ch === "netcatty:fido-prompt-timeout"));

    // 2. Passphrase resolves null and sends passphrase-timeout.
    assert.equal(await ppPromise, null);
    assert.ok(ppSent.some((m) => m.ch === "netcatty:passphrase-timeout"));

    // 3. Keyboard-interactive invokes finishCallback([]) STRICTLY BEFORE sending cancel IPC.
    assert.deepEqual(kiEvents, [
      { kind: "finish", responses: [] },
      {
        kind: "send",
        ch: "netcatty:keyboard-interactive-cancelled",
        p: { requestId: kiId, sessionId: "session-ki-timeout", reason: "timeout" },
      },
    ]);
  });
});

test("pre-aborted AbortSignal preserves differing cancel-IPC semantics between passphrase and FIDO", async (t) => {
  t.mock.method(console, "log", () => {});

  const abortedController = new AbortController();
  abortedController.abort();

  // Passphrase resolves { cancelled: true } immediately WITHOUT sending cancel IPC.
  const ppSent = [];
  const ppResult = await passphraseHandler.requestPassphrase(
    { id: 10, isDestroyed: () => false, send: (ch, p) => ppSent.push({ ch, p }) },
    "/tmp/id_rsa",
    "id_rsa",
    "host",
    false,
    { signal: abortedController.signal },
  );
  assert.deepEqual(ppResult, { cancelled: true });
  assert.deepEqual(ppSent, []);
  assert.equal(passphraseHandler.getRequests().size, 0);

  // FIDO sends netcatty:fido-prompt-cancelled with reason "helper-exited" and resolves { cancelled: true }.
  const fidoSent = [];
  const fidoResult = await fidoPromptHandler.requestFidoPrompt(
    { id: 11, isDestroyed: () => false, send: (ch, p) => fidoSent.push({ ch, p }) },
    { kind: "touch", signal: abortedController.signal },
  );
  assert.deepEqual(fidoResult, { cancelled: true });
  assert.equal(fidoSent.length, 1);
  assert.equal(fidoSent[0].ch, "netcatty:fido-prompt-cancelled");
  assert.equal(fidoSent[0].p.reason, "helper-exited");
  assert.equal(fidoPromptHandler.getRequests().size, 0);
});

test("passphraseHandler respects bootEpoch scoping and skipped/cancelled/response settlement", async (t) => {
  t.mock.method(console, "log", () => {});
  const sent = [];
  const sender = {
    id: 21,
    isDestroyed: () => false,
    send: (ch, p) => sent.push({ ch, p }),
  };

  const p1 = passphraseHandler.requestPassphrase(sender, "/k1", "k1", "h", false, {
    sessionId: "sess-1",
    bootEpoch: 2,
  });
  const reqId1 = sent.at(-1).p.requestId;

  // Stale bootEpoch (1 < 2) must NOT cancel the newer prompt.
  assert.equal(passphraseHandler.cancelPassphraseRequestsForSession("sess-1", "session-closed", 1), 0);
  assert.equal(passphraseHandler.getRequests().has(reqId1), true);

  // Matching bootEpoch (2) cancels it.
  assert.equal(passphraseHandler.cancelPassphraseRequestsForSession("sess-1", "session-closed", 2), 1);
  assert.deepEqual(await p1, { cancelled: true });
  assert.equal(sent.at(-1).ch, "netcatty:passphrase-cancelled");
  assert.equal(sent.at(-1).p.reason, "session-closed");

  // Skipped and passphrase responses settle cleanly.
  const p2 = passphraseHandler.requestPassphrase(sender, "/k2", "k2", "h", false);
  const reqId2 = sent.at(-1).p.requestId;
  assert.deepEqual(
    passphraseHandler.handleResponse({ sender: { id: 21 } }, { requestId: reqId2, skipped: true }),
    { success: true },
  );
  assert.deepEqual(await p2, { skipped: true });

  const p3 = passphraseHandler.requestPassphrase(sender, "/k3", "k3", "h", false);
  const reqId3 = sent.at(-1).p.requestId;
  assert.deepEqual(
    passphraseHandler.handleResponse({ sender: { id: 21 } }, { requestId: reqId3, passphrase: "secret" }),
    { success: true },
  );
  assert.deepEqual(await p3, { passphrase: "secret" });
});

test("keyboardInteractiveHandler invokes finishCallback before notifying cancellation on session cancel", () => {
  const order = [];
  const requestId = keyboardInteractiveHandler.generateRequestId("order");
  keyboardInteractiveHandler.storeRequest(
    requestId,
    (responses) => order.push({ step: "finish", responses }),
    55,
    "sess-order",
    {
      isDestroyed: () => false,
      send: (ch, p) => order.push({ step: "notify", ch, p }),
    },
  );

  assert.equal(keyboardInteractiveHandler.cancelRequestsForSession("sess-order", "closed"), 1);
  assert.deepEqual(order, [
    { step: "finish", responses: [] },
    {
      step: "notify",
      ch: "netcatty:keyboard-interactive-cancelled",
      p: { requestId, sessionId: "sess-order", reason: "closed" },
    },
  ]);
});
