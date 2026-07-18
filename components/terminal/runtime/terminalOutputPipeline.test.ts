import assert from "node:assert/strict";
import test from "node:test";

import type { Terminal as XTerm } from "@xterm/xterm";

import { createOutputFlowController } from "./outputFlowController.ts";
import {
  armTerminalInterruptDisplayGate,
  filterTerminalInterruptDisplayOutput,
  prioritizeTerminalInput,
  releaseTerminalFlowOutputForTerm,
  teardownTerminalOutputPipeline,
} from "./terminalOutputPipeline.ts";
import {
  FLOW_LOW_WATER_MARK,
  TERMINAL_INPUT_PRIORITY_PRESSURE_BYTES,
} from "./terminalFlowConstants.ts";
import {
  enqueueCoalescedTerminalWrite,
  flushTerminalWriteCoalescer,
  getTerminalWriteCoalescerPendingBytes,
  resetTerminalWriteCoalescer,
} from "./terminalWriteCoalescer.ts";
import {
  enqueueTerminalWrite,
  getTerminalWriteQueueDepth,
} from "./terminalWriteQueue.ts";
import { accumulateDeferredTerminalWriteAck } from "./terminalWriteAckDeferral.ts";
import { clearTerminalSessionFlowAck } from "./terminalFlowAckBuffer.ts";

const createFakeTerm = () => ({}) as XTerm;

test("teardownTerminalOutputPipeline resumes renderer pause and clears backlog", () => {
  const term = createFakeTerm();
  const events: string[] = [];
  const flow = createOutputFlowController({
    highWaterMark: 50,
    lowWaterMark: 10,
    onPause: () => events.push("pause"),
    onResume: () => events.push("resume"),
  });
  const backend = {
    setSessionFlowPaused: (_sessionId: string, paused: boolean) => {
      events.push(paused ? "ipc-pause" : "ipc-resume");
    },
    ackSessionFlow: () => {},
  };

  flow.received(60);
  enqueueTerminalWrite(term, 20, (done) => done());
  teardownTerminalOutputPipeline(
    { terminalBackend: backend, sessionRef: { current: "sess-1" } } as never,
    term,
    "sess-1",
    flow,
  );

  assert.deepEqual(events, ["pause", "resume", "ipc-resume"]);
});

test("releaseTerminalFlowOutputForTerm resumes renderer pause without a flow controller", () => {
  const term = createFakeTerm();
  const events: string[] = [];
  const backend = {
    setSessionFlowPaused: (_sessionId: string, paused: boolean) => {
      events.push(paused ? "ipc-pause" : "ipc-resume");
    },
    ackSessionFlow: () => {},
  };

  releaseTerminalFlowOutputForTerm(term, backend, "sess-1", undefined);

  assert.deepEqual(events, ["ipc-resume"]);
});

test("ordinary input priority preserves queued display output", () => {
  const term = createFakeTerm();
  const acked: number[] = [];
  const deferred: Array<() => void> = [];
  let completed = 0;
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => {},
    onResume: () => {},
  });
  const backend = {
    setSessionFlowPaused: () => {},
    ackSessionFlow: (_sessionId: string, bytes: number) => {
      acked.push(bytes);
    },
  };

  flow.received(FLOW_LOW_WATER_MARK + 80);
  enqueueTerminalWrite(term, 50, () => {});
  enqueueTerminalWrite(term, 30, (done) => {
    completed += 1;
    done();
  });
  const priority = prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => deferred.push(callback),
  );

  assert.equal(priority.scheduledBackendResume, false);
  assert.equal(priority.ackAfterInputBytes, 0);
  assert.equal(getTerminalWriteQueueDepth(term), 1);
  assert.deepEqual(acked, []);
  assert.deepEqual(deferred, []);
  assert.equal(completed, 0);
});

test("interrupt priority treats a 100 KiB backlog as input pressure", () => {
  const term = createFakeTerm();
  const flow = createOutputFlowController({
    highWaterMark: 1024 * 1024,
    lowWaterMark: FLOW_LOW_WATER_MARK,
    onPause: () => {},
    onResume: () => {},
  });
  const backend = {
    setSessionFlowPaused: () => {},
    ackSessionFlow: () => {},
  };

  assert.ok(100 * 1024 > TERMINAL_INPUT_PRIORITY_PRESSURE_BYTES);
  assert.ok(100 * 1024 < FLOW_LOW_WATER_MARK);
  flow.received(100 * 1024);

  const priority = prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    { reason: "interrupt" },
  );

  assert.equal(priority.skippedReason, undefined);
  assert.equal(priority.backlogBytes, 100 * 1024);
});

test("prioritizeTerminalInput flushes deferred xterm write ack bytes", () => {
  clearTerminalSessionFlowAck("sess-1");
  const term = createFakeTerm();
  const acked: number[] = [];
  const deferred: Array<() => void> = [];
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => {},
    onResume: () => {},
  });
  const backend = {
    ackSessionFlow: (_sessionId: string, bytes: number) => {
      acked.push(bytes);
    },
    setSessionFlowPaused: () => {},
  };

  accumulateDeferredTerminalWriteAck(term, 42);
  prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => deferred.push(callback),
  );

  assert.deepEqual(acked, []);
  deferred[0]!();
  assert.deepEqual(acked, [42]);
  assert.equal(flow.pendingBytes(), 0);
  clearTerminalSessionFlowAck("sess-1");
});

test("ordinary input priority leaves queued backlog intact", () => {
  const term = createFakeTerm();
  const events: string[] = [];
  const deferred: Array<() => void> = [];
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => events.push("pause"),
    onResume: () => events.push("resume"),
  });
  const backend = {
    setSessionFlowPaused: (_sessionId: string, paused: boolean) => {
      events.push(paused ? "ipc-pause" : "ipc-resume");
    },
    ackSessionFlow: () => {},
  };

  flow.received(FLOW_LOW_WATER_MARK + 1024);
  let release: (() => void) | null = null;
  enqueueTerminalWrite(term, 30, (done) => {
    release = done;
  });
  const priority = prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => deferred.push(callback),
  );

  assert.equal(priority.scheduledBackendResume, false);
  assert.equal(priority.writeQueueDepth, 0);
  assert.equal(getTerminalWriteQueueDepth(term), 0);
  assert.equal(events.includes("ipc-resume"), false);
  assert.deepEqual(deferred, []);
  events.push("input-forwarded");
  release?.();
  assert.deepEqual(events, ["pause", "input-forwarded"]);
});

test("ordinary input priority does not drop queued bytes or resume paused output", () => {
  const term = createFakeTerm();
  const events: string[] = [];
  const deferred: Array<() => void> = [];
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => events.push("pause"),
    onResume: () => events.push("resume"),
  });
  const backend = {
    setSessionFlowPaused: (_sessionId: string, paused: boolean) => {
      events.push(paused ? "ipc-pause" : "ipc-resume");
    },
    ackSessionFlow: () => {},
  };

  flow.received(110);
  enqueueTerminalWrite(term, 10, () => {});
  enqueueTerminalWrite(term, 100, () => {});
  const priority = prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => deferred.push(callback),
  );

  assert.equal(priority.scheduledBackendResume, false);
  assert.equal(priority.ackAfterInputBytes, 0);
  assert.deepEqual(events, ["pause"]);
  assert.equal(getTerminalWriteQueueDepth(term), 1);
  events.push("input-forwarded");
  assert.deepEqual(deferred, []);

  assert.deepEqual(events, ["pause", "input-forwarded"]);
});

test("ordinary input priority preserves a pending coalesced backlog above the pressure threshold", () => {
  clearTerminalSessionFlowAck("sess-1");
  const scheduler = globalThis as typeof globalThis & {
    requestAnimationFrame?: (callback: FrameRequestCallback) => number;
    cancelAnimationFrame?: (handle: number) => void;
  };
  const originalRequestAnimationFrame = scheduler.requestAnimationFrame;
  const originalCancelAnimationFrame = scheduler.cancelAnimationFrame;
  scheduler.requestAnimationFrame = () => 1;
  scheduler.cancelAnimationFrame = () => {};

  const term = createFakeTerm();
  const payload = "x".repeat(TERMINAL_INPUT_PRIORITY_PRESSURE_BYTES + 1024);
  const written: string[] = [];
  const events: string[] = [];
  const deferred: Array<() => void> = [];
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => events.push("pause"),
    onResume: () => events.push("resume"),
  });
  const backend = {
    setSessionFlowPaused: (_sessionId: string, paused: boolean) => {
      events.push(paused ? "ipc-pause" : "ipc-resume");
    },
    ackSessionFlow: () => {},
  };

  try {
    flow.received(payload.length);
    enqueueCoalescedTerminalWrite(
      term,
      payload,
      (data, ingressBytes) => {
        written.push(data);
        flow.written(ingressBytes);
      },
      payload.length,
    );
    const priority = prioritizeTerminalInput(
      term,
      "sess-1",
      flow,
      backend,
      (callback: () => void) => deferred.push(callback),
    );

    assert.equal(priority.scheduledBackendResume, false);
    assert.equal(flow.isPaused(), true);
    assert.deepEqual(events, ["pause"]);
    assert.deepEqual(deferred, []);
    assert.equal(getTerminalWriteCoalescerPendingBytes(term), payload.length);

    events.push("input-forwarded");
    flushTerminalWriteCoalescer(term);

    assert.equal(written.join(""), payload);
    // Payload is under the Tabby-sized unbroken shard (~128KB), so flush is one write.
    assert.equal(written.length, 1);
    assert.equal(flow.pendingBytes(), 0);
  } finally {
    resetTerminalWriteCoalescer(term);
    scheduler.requestAnimationFrame = originalRequestAnimationFrame;
    scheduler.cancelAnimationFrame = originalCancelAnimationFrame;
    clearTerminalSessionFlowAck("sess-1");
  }
});

test("ordinary input priority preserves pending line-edit echo when flushing deferred acks", () => {
  clearTerminalSessionFlowAck("sess-edit");
  const scheduler = globalThis as typeof globalThis & {
    requestAnimationFrame?: (callback: FrameRequestCallback) => number;
    cancelAnimationFrame?: (handle: number) => void;
  };
  const originalRequestAnimationFrame = scheduler.requestAnimationFrame;
  const originalCancelAnimationFrame = scheduler.cancelAnimationFrame;
  scheduler.requestAnimationFrame = () => 1;
  scheduler.cancelAnimationFrame = () => {};

  const term = createFakeTerm();
  const echoedHistoryCommand = "systemctl dddd";
  const written: string[] = [];
  const acked: number[] = [];
  const deferred: Array<() => void> = [];
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => {},
    onResume: () => {},
  });
  const backend = {
    ackSessionFlow: (_sessionId: string, bytes: number) => {
      acked.push(bytes);
    },
    setSessionFlowPaused: () => {},
  };

  try {
    accumulateDeferredTerminalWriteAck(term, 2);
    flow.received(echoedHistoryCommand.length);
    enqueueCoalescedTerminalWrite(
      term,
      echoedHistoryCommand,
      (data, ingressBytes) => {
        written.push(data);
        flow.written(ingressBytes);
      },
      echoedHistoryCommand.length,
    );
    assert.equal(getTerminalWriteCoalescerPendingBytes(term), echoedHistoryCommand.length);

    const priority = prioritizeTerminalInput(
      term,
      "sess-edit",
      flow,
      backend,
      (callback: () => void) => deferred.push(callback),
      { reason: "input" },
    );

    assert.equal(priority.ackAfterInputBytes, 2);
    assert.equal(flow.pendingBytes(), echoedHistoryCommand.length);
    assert.equal(getTerminalWriteCoalescerPendingBytes(term), echoedHistoryCommand.length);

    deferred[0]!();
    assert.deepEqual(acked, [2]);

    flushTerminalWriteCoalescer(term);
    assert.deepEqual(written, [echoedHistoryCommand]);
    assert.equal(flow.pendingBytes(), 0);
  } finally {
    resetTerminalWriteCoalescer(term);
    scheduler.requestAnimationFrame = originalRequestAnimationFrame;
    scheduler.cancelAnimationFrame = originalCancelAnimationFrame;
    clearTerminalSessionFlowAck("sess-edit");
  }
});

test("ordinary input priority keeps queued visible output intact", () => {
  clearTerminalSessionFlowAck("sess-input");
  const term = createFakeTerm();
  const acked: number[] = [];
  const deferred: Array<() => void> = [];
  const order: string[] = [];
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => {},
    onResume: () => {},
  });
  const backend = {
    ackSessionFlow: (_sessionId: string, bytes: number) => {
      acked.push(bytes);
    },
    setSessionFlowPaused: () => {},
  };

  flow.received(FLOW_LOW_WATER_MARK + 200);
  let releaseFirst: (() => void) | null = null;
  enqueueTerminalWrite(term, 20, (done) => {
    order.push("first");
    releaseFirst = done;
  });
  enqueueTerminalWrite(term, 30, (done) => {
    order.push("second");
    done();
  });
  accumulateDeferredTerminalWriteAck(term, 7);

  const priority = prioritizeTerminalInput(
    term,
    "sess-input",
    flow,
    backend,
    (callback: () => void) => deferred.push(callback),
    { reason: "input" },
  );

  assert.equal(priority.ackAfterInputBytes, 7);
  assert.equal(priority.writeQueueDepth, 1);
  assert.equal(flow.pendingBytes(), FLOW_LOW_WATER_MARK + 200);
  assert.deepEqual(order, ["first"]);

  deferred[0]!();
  assert.deepEqual(acked, [7]);
  releaseFirst?.();
  assert.deepEqual(order, ["first", "second"]);
  clearTerminalSessionFlowAck("sess-input");
});

test("interrupt priority drains queued display output for ssh-like interrupts", () => {
  const term = createFakeTerm();
  const events: string[] = [];
  const backend = {
    ackSessionFlow: (_sessionId: string, bytes: number) => {
      events.push(`ack:${bytes}`);
    },
    setSessionFlowPaused: (_sessionId: string, paused: boolean) => {
      events.push(paused ? "ipc-pause" : "ipc-resume");
    },
  };
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => events.push("pause"),
    onResume: () => {},
  });
  flow.received(FLOW_LOW_WATER_MARK + 1024);
  enqueueTerminalWrite(term, 20, () => {});
  enqueueTerminalWrite(term, 30, () => {});

  const priority = prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => {
      events.push("input-forwarded");
      callback();
    },
    {
      reason: "interrupt",
      drainStaleOutput: true,
      now: 4000,
      quietMs: 100,
      promptQuietMs: 80,
      maxDrainMs: 1000,
    },
  );

  assert.equal(priority.skippedReason, undefined);
  assert.equal(priority.scheduledBackendResume, true);
  assert.equal(priority.ackAfterInputBytes, 30);
  assert.equal(priority.writeQueueDepth, 1);
  assert.equal(flow.pendingBytes(), 0);
  assert.deepEqual(events, ["pause", "input-forwarded", "ack:30", "ipc-resume"]);
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "old output", { now: 4001 }),
    { accepted: false, data: "", droppedBytes: 10, reason: "draining" },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "more old^C\r\n$ ", { now: 4002 }),
    { accepted: true, data: "^C\r\n$ ", droppedBytes: 8, reason: "interrupt-echo" },
  );
});

test("interrupt display drain preserves alternate-screen exit controls", () => {
  const term = createFakeTerm();
  const backend = {
    ackSessionFlow: () => {},
    setSessionFlowPaused: () => {},
  };
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => {},
    onResume: () => {},
  });
  flow.received(FLOW_LOW_WATER_MARK + 1);

  prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => callback(),
    {
      reason: "interrupt",
      drainStaleOutput: true,
      now: 6100,
      quietMs: 500,
      promptQuietMs: 80,
      maxDrainMs: 1000,
    },
  );

  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "stale frame\x1b[?1049l", { now: 6101 }),
    {
      accepted: true,
      data: "\x1b[?1049l",
      droppedBytes: "stale frame".length,
      reason: "draining",
    },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "stale frame\x1b[?1049l\r\n$ ", { now: 6200 }),
    {
      accepted: true,
      data: "\x1b[?1049l$ ",
      droppedBytes: "stale frame\r\n".length,
      reason: "prompt-gap",
    },
  );
});

test("interrupt display drain excludes preserved restore from held password prefixes", () => {
  const term = createFakeTerm();
  armTerminalInterruptDisplayGate(term, {
    now: 6250,
    quietMs: 500,
    promptQuietMs: 80,
    maxDrainMs: 2500,
  });

  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "stale\n\x1b[?1049lPass", { now: 6251 }),
    {
      accepted: true,
      data: "\x1b[?1049l",
      droppedBytes: "stale\n".length,
      reason: "draining",
    },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "word: ", { now: 6252 }),
    {
      accepted: true,
      data: "Password: ",
      droppedBytes: 0,
      reason: "prompt-gap",
    },
  );
});

test("interrupt display drain excludes last of multiple restores from password prefixes", () => {
  const term = createFakeTerm();
  armTerminalInterruptDisplayGate(term, {
    now: 6255,
    quietMs: 500,
    promptQuietMs: 80,
    maxDrainMs: 2500,
  });

  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "\x1b[?25hstale\n\x1b[?1049lPass", { now: 6256 }),
    {
      accepted: true,
      data: "\x1b[?25h\x1b[?1049l",
      droppedBytes: "stale\n".length,
      reason: "draining",
    },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "word: ", { now: 6257 }),
    {
      accepted: true,
      data: "Password: ",
      droppedBytes: 0,
      reason: "prompt-gap",
    },
  );
});

test("interrupt display drain does not peel restore suffix from later password prefixes", () => {
  const term = createFakeTerm();
  armTerminalInterruptDisplayGate(term, {
    now: 6260,
    quietMs: 500,
    promptQuietMs: 80,
    maxDrainMs: 2500,
  });

  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "\x1b[?1049l\nlogin pass", { now: 6261 }),
    {
      accepted: true,
      data: "\x1b[?1049l",
      droppedBytes: 1,
      reason: "draining",
    },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "word: ", { now: 6262 }),
    {
      accepted: true,
      data: "login password: ",
      droppedBytes: 0,
      reason: "prompt-gap",
    },
  );
});

test("interrupt display drain does not leak incomplete SGR CSI into shell prompts", () => {
  const term = createFakeTerm();
  armTerminalInterruptDisplayGate(term, {
    now: 6270,
    quietMs: 500,
    promptQuietMs: 80,
    maxDrainMs: 2500,
  });

  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "old\x1b[31", { now: 6271 }),
    {
      accepted: false,
      data: "",
      droppedBytes: "old\x1b[31".length,
      reason: "draining",
    },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "$ ", { now: 6400 }),
    {
      accepted: true,
      data: "$ ",
      droppedBytes: 0,
      reason: "prompt-gap",
    },
  );
});

test("interrupt display drain preserves split alternate-screen exit controls", () => {
  clearTerminalSessionFlowAck("sess-1");
  const term = createFakeTerm();
  const backend = {
    ackSessionFlow: () => {},
    setSessionFlowPaused: () => {},
  };
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => {},
    onResume: () => {},
  });
  flow.received(FLOW_LOW_WATER_MARK + 1);

  prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => callback(),
    {
      reason: "interrupt",
      drainStaleOutput: true,
      now: 7100,
      quietMs: 500,
      promptQuietMs: 80,
      maxDrainMs: 1000,
    },
  );

  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "stale frame\x1b[?104", { now: 7101 }),
    {
      accepted: false,
      data: "",
      droppedBytes: "stale frame".length,
      reason: "draining",
    },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "9l^C\r\n$ ", { now: 7102 }),
    {
      accepted: true,
      data: "\x1b[?1049l^C\r\n$ ",
      droppedBytes: 0,
      reason: "interrupt-echo",
    },
  );
});

test("interrupt display drain preserves restore controls on split caret echo", () => {
  clearTerminalSessionFlowAck("sess-1");
  const term = createFakeTerm();
  const backend = {
    ackSessionFlow: () => {},
    setSessionFlowPaused: () => {},
  };
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => {},
    onResume: () => {},
  });
  flow.received(FLOW_LOW_WATER_MARK + 1);

  prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => callback(),
    {
      reason: "interrupt",
      drainStaleOutput: true,
      now: 7150,
      quietMs: 500,
      promptQuietMs: 80,
      maxDrainMs: 1000,
    },
  );

  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "stale frame\x1b[?104", { now: 7151 }),
    {
      accepted: false,
      data: "",
      droppedBytes: "stale frame".length,
      reason: "draining",
    },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "9l^", { now: 7152 }),
    {
      accepted: true,
      data: "\x1b[?1049l",
      droppedBytes: 1,
      reason: "draining",
    },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "C\r\n$ ", { now: 7153 }),
    {
      accepted: true,
      data: "^C\r\n$ ",
      droppedBytes: 0,
      acceptedBytes: 5,
      reason: "interrupt-echo",
    },
  );
});

test("interrupt display drain does not preserve unsafe combined private modes", () => {
  clearTerminalSessionFlowAck("sess-1");
  const term = createFakeTerm();
  const backend = {
    ackSessionFlow: () => {},
    setSessionFlowPaused: () => {},
  };
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => {},
    onResume: () => {},
  });
  flow.received(FLOW_LOW_WATER_MARK + 1);

  prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => callback(),
    {
      reason: "interrupt",
      drainStaleOutput: true,
      now: 7200,
      quietMs: 500,
      promptQuietMs: 80,
      maxDrainMs: 1000,
    },
  );

  const unsafeSequence = "\x1b[?1049;25h";
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, `stale frame${unsafeSequence}^C\r\n$ `, {
      now: 7201,
    }),
    {
      accepted: true,
      data: "^C\r\n$ ",
      droppedBytes: "stale frame".length + unsafeSequence.length,
      reason: "interrupt-echo",
    },
  );
});

test("interrupt display drain accepts prompt candidates with OSC title and spaces", () => {
  clearTerminalSessionFlowAck("sess-1");
  const term = createFakeTerm();
  const backend = {
    ackSessionFlow: () => {},
    setSessionFlowPaused: () => {},
  };
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => {},
    onResume: () => {},
  });
  flow.received(FLOW_LOW_WATER_MARK + 1);

  prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => callback(),
    {
      reason: "interrupt",
      drainStaleOutput: true,
      now: 7300,
      quietMs: 500,
      promptQuietMs: 80,
      maxDrainMs: 1000,
    },
  );

  assert.equal(
    filterTerminalInterruptDisplayOutput(term, "old output", { now: 7301 }).accepted,
    false,
  );
  const prompt = "\x1b]0;~/My Project\x07~/My Project$ ";
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, prompt, { now: 7400 }),
    {
      accepted: true,
      data: prompt,
      droppedBytes: 0,
      reason: "prompt-gap",
    },
  );
});

test("interrupt display drain accepts split OSC prompt candidates", () => {
  clearTerminalSessionFlowAck("sess-1");
  const term = createFakeTerm();
  const backend = {
    ackSessionFlow: () => {},
    setSessionFlowPaused: () => {},
  };
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => {},
    onResume: () => {},
  });
  flow.received(FLOW_LOW_WATER_MARK + 1);

  prioritizeTerminalInput(
    term,
    "sess-1",
    flow,
    backend,
    (callback: () => void) => callback(),
    {
      reason: "interrupt",
      drainStaleOutput: true,
      now: 7500,
      quietMs: 500,
      promptQuietMs: 80,
      maxDrainMs: 1000,
    },
  );

  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "old output\x1b]0;~/My ", { now: 7501 }),
    {
      accepted: false,
      data: "",
      droppedBytes: "old output".length,
      reason: "draining",
    },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "Project\x07~/My Project$ ", { now: 7600 }),
    {
      accepted: true,
      data: "\x1b]0;~/My Project\x07~/My Project$ ",
      droppedBytes: 0,
      reason: "prompt-gap",
    },
  );
});

test("interrupt priority skips stale display drain but still flushes deferred acks", () => {
  clearTerminalSessionFlowAck("sess-deferred");
  const term = createFakeTerm();
  const acked: number[] = [];
  const deferred: Array<() => void> = [];
  const backend = {
    ackSessionFlow: (_sessionId: string, bytes: number) => {
      acked.push(bytes);
    },
    setSessionFlowPaused: () => {},
  };

  accumulateDeferredTerminalWriteAck(term, 42);
  const priority = prioritizeTerminalInput(
    term,
    "sess-deferred",
    undefined,
    backend,
    (callback: () => void) => deferred.push(callback),
    {
      reason: "interrupt",
      drainStaleOutput: false,
      now: 5000,
      quietMs: 500,
      promptQuietMs: 80,
      maxDrainMs: 100,
    },
  );

  assert.equal(priority.skippedReason, undefined);
  assert.equal(priority.deferredAckBytes, 42);
  assert.equal(priority.scheduledBackendResume, true);
  assert.equal(priority.ackAfterInputBytes, 42);
  assert.equal(deferred.length, 1);
  deferred[0]!();
  assert.deepEqual(acked, [42]);
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "KeyboardInterrupt\r\n$ ", { now: 5001 }),
    {
      accepted: true,
      data: "KeyboardInterrupt\r\n$ ",
      droppedBytes: 0,
      reason: "inactive",
    },
  );
  clearTerminalSessionFlowAck("sess-deferred");
});

test("interrupt priority leaves display output alone below pressure threshold", () => {
  clearTerminalSessionFlowAck("sess-low-pressure");
  const term = createFakeTerm();
  const flow = createOutputFlowController({
    highWaterMark: 100,
    lowWaterMark: 20,
    onPause: () => {},
    onResume: () => {},
  });
  const backend = {
    ackSessionFlow: () => {},
    setSessionFlowPaused: () => {},
  };

  flow.received(119);
  const priority = prioritizeTerminalInput(
    term,
    "sess-low-pressure",
    flow,
    backend,
    (callback: () => void) => callback(),
    {
      reason: "interrupt",
      drainStaleOutput: true,
      now: 7800,
    },
  );

  assert.equal(priority.skippedReason, "below-threshold");
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(
      term,
      "Type  :qa  and press <Enter> to exit Vim",
      { now: 7801 },
    ),
    {
      accepted: true,
      data: "Type  :qa  and press <Enter> to exit Vim",
      droppedBytes: 0,
      reason: "inactive",
    },
  );
  clearTerminalSessionFlowAck("sess-low-pressure");
});

test("interrupt display drain accepts a sudo password prompt (#2010)", () => {
  const term = createFakeTerm();
  armTerminalInterruptDisplayGate(term, {
    now: 8000,
    quietMs: 500,
    promptQuietMs: 80,
    maxDrainMs: 2500,
  });

  assert.equal(
    filterTerminalInterruptDisplayOutput(term, "Reading package lists...\n", { now: 8001 }).accepted,
    false,
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "[sudo] password for alice: ", { now: 8010 }),
    {
      accepted: true,
      data: "[sudo] password for alice: ",
      droppedBytes: 0,
      reason: "password-prompt",
    },
  );
});

test("interrupt display drain accepts localized password prompts (#2010)", () => {
  for (const prompt of ["Password: ", "[sudo] alice 的密码：", "输入密码", "用户 的密码"]) {
    const term = createFakeTerm();
    armTerminalInterruptDisplayGate(term, {
      now: 8100,
      quietMs: 500,
      promptQuietMs: 80,
      maxDrainMs: 2500,
    });
    assert.equal(
      filterTerminalInterruptDisplayOutput(term, "stale\n", { now: 8101 }).accepted,
      false,
    );
    assert.deepEqual(
      filterTerminalInterruptDisplayOutput(term, prompt, { now: 8110 }),
      {
        accepted: true,
        data: prompt,
        droppedBytes: 0,
        reason: "password-prompt",
      },
      `expected password prompt to resume drain: ${JSON.stringify(prompt)}`,
    );
  }
});

test("interrupt display drain holds a split Password: prompt across chunks (#2010)", () => {
  const term = createFakeTerm();
  armTerminalInterruptDisplayGate(term, {
    now: 8300,
    quietMs: 500,
    promptQuietMs: 80,
    maxDrainMs: 2500,
  });

  assert.equal(
    filterTerminalInterruptDisplayOutput(term, "stale\n", { now: 8301 }).accepted,
    false,
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "Pass", { now: 8302 }),
    { accepted: false, data: "", droppedBytes: 0, reason: "draining" },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "word: ", { now: 8303 }),
    {
      accepted: true,
      data: "Password: ",
      droppedBytes: 0,
      reason: "prompt-gap",
    },
  );
});

test("interrupt display drain holds a split ANSI-colored Password: prompt", () => {
  const term = createFakeTerm();
  const red = "\x1b[31m";
  const reset = "\x1b[0m";
  armTerminalInterruptDisplayGate(term, {
    now: 8350,
    quietMs: 500,
    promptQuietMs: 80,
    maxDrainMs: 2500,
  });

  assert.equal(
    filterTerminalInterruptDisplayOutput(term, "stale\n", { now: 8351 }).accepted,
    false,
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, `${red}Pass`, { now: 8352 }),
    { accepted: false, data: "", droppedBytes: 0, reason: "draining" },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, `word:${reset} `, { now: 8353 }),
    {
      accepted: true,
      data: `${red}Password:${reset} `,
      droppedBytes: 0,
      reason: "prompt-gap",
    },
  );
});

test("interrupt display drain holds a password prefix split before trailing ANSI", () => {
  const term = createFakeTerm();
  const red = "\x1b[31m";
  const reset = "\x1b[0m";
  armTerminalInterruptDisplayGate(term, {
    now: 8370,
    quietMs: 500,
    promptQuietMs: 80,
    maxDrainMs: 2500,
  });

  assert.equal(
    filterTerminalInterruptDisplayOutput(term, "stale\n", { now: 8371 }).accepted,
    false,
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, `${red}Pass\x1b[`, { now: 8372 }),
    { accepted: false, data: "", droppedBytes: 0, reason: "draining" },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, `0mword: `, { now: 8373 }),
    {
      accepted: true,
      data: `${red}Pass${reset}word: `,
      droppedBytes: 0,
      reason: "prompt-gap",
    },
  );
});

test("interrupt display drain holds a password prefix split mid CSI parameter", () => {
  const term = createFakeTerm();
  const red = "\x1b[31m";
  const reset = "\x1b[0m";
  armTerminalInterruptDisplayGate(term, {
    now: 8380,
    quietMs: 500,
    promptQuietMs: 80,
    maxDrainMs: 2500,
  });

  assert.equal(
    filterTerminalInterruptDisplayOutput(term, "stale\n", { now: 8381 }).accepted,
    false,
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, `${red}Pass\x1b[0`, { now: 8382 }),
    { accepted: false, data: "", droppedBytes: 0, reason: "draining" },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, `mword: `, { now: 8383 }),
    {
      accepted: true,
      data: `${red}Pass${reset}word: `,
      droppedBytes: 0,
      reason: "prompt-gap",
    },
  );
});

test("interrupt display drain discards a held password prefix that does not complete", () => {
  const term = createFakeTerm();
  armTerminalInterruptDisplayGate(term, {
    now: 8400,
    quietMs: 500,
    promptQuietMs: 80,
    maxDrainMs: 2500,
  });

  assert.equal(
    filterTerminalInterruptDisplayOutput(term, "stale\n", { now: 8401 }).accepted,
    false,
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "Pass", { now: 8402 }),
    { accepted: false, data: "", droppedBytes: 0, reason: "draining" },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "$ ", { now: 8600 }),
    {
      accepted: true,
      data: "$ ",
      droppedBytes: 4,
      reason: "prompt-gap",
    },
  );
});

test("interrupt display drain discards CSI finals when mid-CSI password prefix fails", () => {
  const term = createFakeTerm();
  armTerminalInterruptDisplayGate(term, {
    now: 8420,
    quietMs: 500,
    promptQuietMs: 80,
    maxDrainMs: 2500,
  });

  assert.equal(
    filterTerminalInterruptDisplayOutput(term, "stale\n", { now: 8421 }).accepted,
    false,
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "Pass\x1b[0", { now: 8422 }),
    { accepted: false, data: "", droppedBytes: 0, reason: "draining" },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "m$ ", { now: 8600 }),
    {
      accepted: true,
      data: "$ ",
      droppedBytes: "Pass\x1b[0".length + 1,
      reason: "prompt-gap",
    },
  );
});

test("interrupt display drain does not hold ordinary password-related output", () => {
  const term = createFakeTerm();
  armTerminalInterruptDisplayGate(term, {
    now: 8700,
    quietMs: 500,
    promptQuietMs: 80,
    maxDrainMs: 2500,
  });

  assert.equal(
    filterTerminalInterruptDisplayOutput(term, "stale\n", { now: 8701 }).accepted,
    false,
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "Password authentication failed", { now: 8702 }),
    {
      accepted: false,
      data: "",
      droppedBytes: "Password authentication failed".length,
      reason: "draining",
    },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "$ ", { now: 8900 }),
    {
      accepted: true,
      data: "$ ",
      droppedBytes: 0,
      reason: "prompt-gap",
    },
  );
});

test("interrupt display drain holds split password prompts with leading text", () => {
  const term = createFakeTerm();
  armTerminalInterruptDisplayGate(term, {
    now: 9000,
    quietMs: 500,
    promptQuietMs: 80,
    maxDrainMs: 2500,
  });

  assert.equal(
    filterTerminalInterruptDisplayOutput(term, "stale\n", { now: 9001 }).accepted,
    false,
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "alice@host's pass", { now: 9002 }),
    { accepted: false, data: "", droppedBytes: 0, reason: "draining" },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "word: ", { now: 9003 }),
    {
      accepted: true,
      data: "alice@host's password: ",
      droppedBytes: 0,
      reason: "prompt-gap",
    },
  );
});

test("interrupt display drain accepts a fresh one-chunk password prompt before the quiet gap", () => {
  const term = createFakeTerm();
  armTerminalInterruptDisplayGate(term, {
    now: 9100,
    quietMs: 500,
    promptQuietMs: 80,
    maxDrainMs: 2500,
  });

  assert.equal(
    filterTerminalInterruptDisplayOutput(term, "old flood\n", { now: 9101 }).accepted,
    false,
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "Password: ", { now: 9110 }),
    {
      accepted: true,
      data: "Password: ",
      droppedBytes: 0,
      reason: "password-prompt",
    },
  );
});

test("interrupt display drain accepts a last-line password prompt after a large stale prefix", () => {
  const term = createFakeTerm();
  armTerminalInterruptDisplayGate(term, {
    now: 9120,
    quietMs: 500,
    promptQuietMs: 80,
    maxDrainMs: 2500,
    promptCandidateBytes: 512,
  });

  assert.equal(
    filterTerminalInterruptDisplayOutput(term, "stale\n", { now: 9121 }).accepted,
    false,
  );
  const largeChunk = `${"x".repeat(600)}\n[sudo] password for alice: `;
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, largeChunk, { now: 9130 }),
    {
      accepted: true,
      data: "[sudo] password for alice: ",
      droppedBytes: 601,
      reason: "password-prompt",
    },
  );
});

test("interrupt display drain does not hold short ASCII trailing letters as password prefixes", () => {
  const term = createFakeTerm();
  armTerminalInterruptDisplayGate(term, {
    now: 9300,
    quietMs: 500,
    promptQuietMs: 80,
    maxDrainMs: 2500,
  });

  assert.equal(
    filterTerminalInterruptDisplayOutput(term, "stale\n", { now: 9301 }).accepted,
    false,
  );
  // Full-width "password：" must not lower ASCII minLen to 1, or "copy p" is held
  // and a later "assword:" chunk can bypass quiet-gap.
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "copy p", { now: 9302 }),
    {
      accepted: false,
      data: "",
      droppedBytes: "copy p".length,
      reason: "draining",
    },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "assword: ", { now: 9310 }),
    {
      accepted: false,
      data: "",
      droppedBytes: "assword: ".length,
      reason: "draining",
    },
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "$ ", { now: 9500 }),
    {
      accepted: true,
      data: "$ ",
      droppedBytes: 0,
      reason: "prompt-gap",
    },
  );
});

test("interrupt display drain rejects held password-prefix completion across a line break", () => {
  const term = createFakeTerm();
  armTerminalInterruptDisplayGate(term, {
    now: 9200,
    quietMs: 500,
    promptQuietMs: 80,
    maxDrainMs: 2500,
  });

  assert.equal(
    filterTerminalInterruptDisplayOutput(term, "stale\n", { now: 9201 }).accepted,
    false,
  );
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "Pass", { now: 9202 }),
    { accepted: false, data: "", droppedBytes: 0, reason: "draining" },
  );
  // A newline before Password: discards the held "Pass" prefix (not a same-line
  // completion), but the fresh complete password line is still preserved.
  assert.deepEqual(
    filterTerminalInterruptDisplayOutput(term, "\nPassword: ", { now: 9210 }),
    {
      accepted: true,
      data: "Password: ",
      droppedBytes: 4 + 1,
      reason: "password-prompt",
    },
  );
});
