import assert from "node:assert/strict";
import test from "node:test";

import type { Terminal as XTerm } from "@xterm/xterm";

import { createOutputFlowController } from "./outputFlowController.ts";
import {
  filterTerminalInterruptDisplayOutput,
  prioritizeTerminalInput,
  releaseTerminalFlowOutputForTerm,
  teardownTerminalOutputPipeline,
} from "./terminalOutputPipeline.ts";
import { FLOW_LOW_WATER_MARK } from "./terminalFlowConstants.ts";
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
  const payload = "x".repeat(FLOW_LOW_WATER_MARK + 1024);
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
    assert.ok(written.length > 1);
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
