import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import {
  MAX_PENDING_SCRIPT_RECORDING_INPUT_CHARS,
  SCRIPT_RECORDING_LIMIT_EVENT,
  useScriptRecorder,
} from "./useScriptRecorder";

type Recorder = ReturnType<typeof useScriptRecorder>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushReact() {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

test("oversized unsubmitted recording input stops explicitly and preserves earlier steps", async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const eventTarget = new EventTarget() as EventTarget & Record<string, unknown>;
  let stopCalls = 0;
  Object.assign(eventTarget, {
    netcatty: {
      scriptRecordingStart: async () => ({ ok: true }),
      scriptRecordingStop: async () => {
        stopCalls += 1;
        return {
          steps: [{ type: "send", value: "kept" }],
          code: "await nct.screen.sendLine('kept');",
        };
      },
    },
    setInterval,
    clearInterval,
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: eventTarget });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  let recorder: ReturnType<typeof useScriptRecorder> | null = null;
  let renderer: ReactTestRenderer | null = null;
  let limitDetail: { sessionId: string; code: string } | null = null;
  eventTarget.addEventListener(SCRIPT_RECORDING_LIMIT_EVENT, (event) => {
    limitDetail = (event as CustomEvent<{ sessionId: string; code: string }>).detail;
  });

  function Probe() {
    recorder = useScriptRecorder("session-1");
    return null;
  }

  await act(async () => { renderer = create(React.createElement(Probe)); });
  await act(async () => { await recorder!.startRecording(); });
  assert.equal(recorder!.isRecording, true);

  await act(async () => {
    recorder!.recordInput("x".repeat(MAX_PENDING_SCRIPT_RECORDING_INPUT_CHARS + 1));
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.equal(stopCalls, 1);
  assert.equal(recorder!.isRecording, false);
  assert.equal(limitDetail?.sessionId, "session-1");
  assert.equal(limitDetail?.code, "await nct.screen.sendLine('kept');");
  await act(async () => renderer!.unmount());
});

test("automatic stop remains closed across an elapsed-time rerender and ignores later input", async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const stopResult = deferred<{ steps: []; code: string }>();
  const intervalCallbacks = new Set<() => void>();
  let stopCalls = 0;
  const appended: Array<{ type: string; value?: unknown }> = [];
  const eventTarget = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(eventTarget, {
    netcatty: {
      scriptRecordingStart: async () => ({ ok: true }),
      scriptRecordingStop: () => {
        stopCalls += 1;
        return stopResult.promise;
      },
      scriptRecordingAppendStep: async (_sessionId: string, step: { type: string; value?: unknown }) => {
        appended.push(step);
        return { stopped: false };
      },
    },
    setInterval: (callback: () => void) => {
      intervalCallbacks.add(callback);
      return callback;
    },
    clearInterval: (callback: () => void) => intervalCallbacks.delete(callback),
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: eventTarget });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  let recorder: Recorder | null = null;
  let renderer: ReactTestRenderer | null = null;
  function Probe() {
    recorder = useScriptRecorder("session-1");
    return null;
  }

  await act(async () => { renderer = create(React.createElement(Probe)); });
  await act(async () => { await recorder!.startRecording(); });
  const elapsedTick = [...intervalCallbacks][0];
  assert.ok(elapsedTick);

  act(() => {
    recorder!.recordInput("x".repeat(MAX_PENDING_SCRIPT_RECORDING_INPUT_CHARS + 1));
  });
  assert.equal(stopCalls, 1);
  assert.equal(recorder!.isRecording, false);

  await act(async () => {
    elapsedTick();
  });
  await act(async () => {
    recorder!.recordInput("must-not-be-buffered");
    await recorder!.recordEnter();
  });
  assert.deepEqual(appended, []);

  stopResult.resolve({ steps: [], code: "" });
  await flushReact();
  await act(async () => renderer!.unmount());
});

test("repeated oversized input issues only one automatic stop", async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const stopResult = deferred<{ steps: []; code: string }>();
  const intervalCallbacks = new Set<() => void>();
  let stopCalls = 0;
  const eventTarget = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(eventTarget, {
    netcatty: {
      scriptRecordingStart: async () => ({ ok: true }),
      scriptRecordingStop: () => {
        stopCalls += 1;
        return stopResult.promise;
      },
    },
    setInterval: (callback: () => void) => {
      intervalCallbacks.add(callback);
      return callback;
    },
    clearInterval: (callback: () => void) => intervalCallbacks.delete(callback),
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: eventTarget });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  let recorder: Recorder | null = null;
  let renderer: ReactTestRenderer | null = null;
  function Probe() {
    recorder = useScriptRecorder("session-1");
    return null;
  }

  await act(async () => { renderer = create(React.createElement(Probe)); });
  await act(async () => { await recorder!.startRecording(); });
  const elapsedTick = [...intervalCallbacks][0];
  assert.ok(elapsedTick);
  act(() => {
    recorder!.recordInput("x".repeat(MAX_PENDING_SCRIPT_RECORDING_INPUT_CHARS + 1));
  });
  await act(async () => {
    elapsedTick();
  });
  act(() => {
    recorder!.recordInput("y".repeat(MAX_PENDING_SCRIPT_RECORDING_INPUT_CHARS + 1));
  });
  let manualStopPromise!: ReturnType<Recorder["stopRecording"]>;
  act(() => {
    manualStopPromise = recorder!.stopRecording();
  });
  assert.equal(stopCalls, 1);

  stopResult.resolve({ steps: [], code: "" });
  await act(async () => { await manualStopPromise; });
  await act(async () => renderer!.unmount());
});

test("automatic stop failure stays stopped and a later recording can start", async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const firstStop = deferred<{ steps: []; code: string }>();
  let startCalls = 0;
  let stopCalls = 0;
  const limitEvents: Array<{ steps: unknown[]; code: string }> = [];
  const eventTarget = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(eventTarget, {
    netcatty: {
      scriptRecordingStart: async () => {
        startCalls += 1;
        return { ok: true };
      },
      scriptRecordingStop: () => {
        stopCalls += 1;
        return firstStop.promise;
      },
    },
    setInterval,
    clearInterval,
  });
  eventTarget.addEventListener(SCRIPT_RECORDING_LIMIT_EVENT, (event) => {
    limitEvents.push((event as CustomEvent<{ steps: unknown[]; code: string }>).detail);
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: eventTarget });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  let recorder: Recorder | null = null;
  let renderer: ReactTestRenderer | null = null;
  function Probe() {
    recorder = useScriptRecorder("session-1");
    return null;
  }

  await act(async () => { renderer = create(React.createElement(Probe)); });
  await act(async () => { await recorder!.startRecording(); });
  act(() => {
    recorder!.recordInput("x".repeat(MAX_PENDING_SCRIPT_RECORDING_INPUT_CHARS + 1));
  });
  assert.equal(recorder!.isRecording, false);

  firstStop.reject(new Error("stop failed"));
  await flushReact();
  assert.equal(recorder!.isRecording, false);
  assert.equal(stopCalls, 1);
  assert.deepEqual(limitEvents.map(({ steps, code }) => ({ steps, code })), [{ steps: [], code: "" }]);

  await act(async () => { await recorder!.startRecording(); });
  assert.equal(startCalls, 2);
  assert.equal(recorder!.isRecording, true);
  await act(async () => renderer!.unmount());
});

test("restart waits for an in-flight automatic stop and is not closed by its completion", async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const stopResult = deferred<{ steps: []; code: string }>();
  let startCalls = 0;
  const eventTarget = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(eventTarget, {
    netcatty: {
      scriptRecordingStart: async () => {
        startCalls += 1;
        return { ok: true };
      },
      scriptRecordingStop: () => stopResult.promise,
    },
    setInterval,
    clearInterval,
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: eventTarget });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  let recorder: Recorder | null = null;
  let renderer: ReactTestRenderer | null = null;
  function Probe() {
    recorder = useScriptRecorder("session-1");
    return null;
  }

  await act(async () => { renderer = create(React.createElement(Probe)); });
  await act(async () => { await recorder!.startRecording(); });
  act(() => {
    recorder!.recordInput("x".repeat(MAX_PENDING_SCRIPT_RECORDING_INPUT_CHARS + 1));
  });

  let restartPromise!: Promise<void>;
  act(() => {
    restartPromise = recorder!.startRecording();
  });
  await flushReact();
  assert.equal(startCalls, 1);

  stopResult.resolve({ steps: [], code: "" });
  await act(async () => { await restartPromise; });
  assert.equal(startCalls, 2);
  assert.equal(recorder!.isRecording, true);
  await act(async () => renderer!.unmount());
});

test("manual stop still returns its recording and permits a clean restart", async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let startCalls = 0;
  let stopCalls = 0;
  const eventTarget = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(eventTarget, {
    netcatty: {
      scriptRecordingStart: async () => {
        startCalls += 1;
        return { ok: true };
      },
      scriptRecordingStop: async () => {
        stopCalls += 1;
        return {
          steps: [{ type: "send", value: "kept" }],
          code: "await nct.screen.sendLine('kept');",
        };
      },
    },
    setInterval,
    clearInterval,
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: eventTarget });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  let recorder: Recorder | null = null;
  let renderer: ReactTestRenderer | null = null;
  function Probe() {
    recorder = useScriptRecorder("session-1");
    return null;
  }

  await act(async () => { renderer = create(React.createElement(Probe)); });
  await act(async () => { await recorder!.startRecording(); });
  let result!: Awaited<ReturnType<Recorder["stopRecording"]>>;
  await act(async () => { result = await recorder!.stopRecording(); });
  assert.equal(stopCalls, 1);
  assert.equal(recorder!.isRecording, false);
  assert.equal(result.code, "await nct.screen.sendLine('kept');");

  await act(async () => { await recorder!.startRecording(); });
  assert.equal(startCalls, 2);
  assert.equal(recorder!.isRecording, true);
  await act(async () => renderer!.unmount());
});

test("confirmed line-by-line recording awaits each send and prompt step in order", async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const steps: Array<{ type: string; value?: unknown; sensitive?: boolean }> = [];
  const eventTarget = new EventTarget();
  Object.assign(eventTarget, {
    netcatty: {
      scriptRecordingStart: async () => ({ ok: true }),
      scriptRecordingAppendStep: async (_id: string, step: typeof steps[number]) => {
        await new Promise(resolve => setImmediate(resolve));
        steps.push(step);
        return { stopped: false };
      },
    },
    setInterval, clearInterval,
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: eventTarget });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  let recorder!: Recorder;
  let renderer!: ReactTestRenderer;
  function Probe() { recorder = useScriptRecorder("session-1"); return null; }
  await act(async () => { renderer = create(React.createElement(Probe)); });
  try {
    await act(async () => { await recorder.startRecording(); });
    await act(async () => {
      recorder.recordInput("echo ");
      recorder.recordInput("first\r\ncd /tmp\r");
      await recorder.recordEnter({ lineByLine: true });
    });
    assert.deepEqual(steps.map(step => [step.type, step.value]), [
      ["send", "echo first"], ["waitForPrompt", undefined],
      ["send", "cd /tmp"], ["waitForPrompt", undefined],
    ]);
    steps.length = 0;
    await act(async () => {
      recorder.recordInput("secret\nsecond secret\r");
      await recorder.recordEnter({ lineByLine: true, sensitive: true });
    });
    assert.deepEqual(steps.filter(step => step.type === "send").map(step => step.sensitive), [true, true]);
  } finally {
    await act(async () => renderer.unmount());
  }
});
