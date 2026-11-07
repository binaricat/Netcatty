import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import type { TransferTask } from "../../domain/models";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useAppStartupEffects } from "./useAppStartupEffects.ts";
import { sftpTransferCenterStore } from "../state/sftpTransferCenterStore.ts";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge.ts";

const makeTask = (id: string, status: TransferTask["status"]): TransferTask => ({
  id,
  fileName: `${id}.txt`,
  sourcePath: `/source/${id}.txt`,
  targetPath: `/target/${id}.txt`,
  sourceConnectionId: "local",
  targetConnectionId: "remote",
  direction: "upload",
  status,
  totalBytes: 10,
  transferredBytes: 2,
  speed: 1,
  startTime: 1,
  isDirectory: false,
});

for (const accept of [false, true]) {
  test(`app Quit with an unfinished transfer: ${accept ? "confirm quits" : "declining reports \"transfers\" before resuming only transferring and queued tasks"}`, async (t) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    const g = globalThis as unknown as { window?: { confirm?: (m: string) => boolean } };
    const hadWindow = "window" in g; const previousConfirm = g.window?.confirm;
    if (!g.window) g.window = {};
    let prompts = 0;
    g.window.confirm = () => { prompts++; return accept; };
    let renderer: ReactTestRenderer | undefined;
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
    t.after(async () => {
      releaseResume();
      await act(async () => renderer?.unmount());
      if (hadWindow && g.window) g.window.confirm = previousConfirm; else delete g.window;
      if (previous) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
      else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    });
    const calls: string[] = [];
    const reports: Array<[boolean, string | undefined]> = [];
    let resumeSettled = false;
    let query!: () => Promise<void>;
    t.mock.method(sftpTransferCenterStore, "getSnapshot", () => ({
      tasks: [
        { id: "running", status: "transferring" },
        { id: "queued", status: "queued" },
        { id: "already-paused", status: "paused" },
        { id: "pausing", status: "pausing" },
        { id: "interrupted", status: "interrupted" },
        { id: "packed-running", status: "transferring", controlKind: "packed-download", resumable: false },
        { id: "packed-queued", status: "queued", controlKind: "packed-download", resumable: false },
        { id: "child", parentTaskId: "running", status: "transferring" },
      ],
    }) as unknown as ReturnType<typeof sftpTransferCenterStore.getSnapshot>);
    t.mock.method(sftpTransferCenterStore, "pause", async (id: string) => { calls.push(`pause:${id}`); });
    t.mock.method(sftpTransferCenterStore, "resume", async (id: string) => {
      calls.push(`resume:${id}`);
      await resumeGate;
      resumeSettled = true;
    });
    t.mock.method(netcattyBridge, "get", () => ({
      onCheckDirtyEditors: (callback: typeof query) => { query = callback; return () => {}; },
      reportDirtyEditorsResult: (dirty: boolean, reason?: string) => {
        calls.push("report");
        reports.push([dirty, reason]);
      },
    }));
    function Probe() {
      useAppStartupEffects({ enabled: false, updateState: {}, sessions: [], hosts: [], keys: [], identities: [], knownHosts: [], proxyProfiles: [], groupConfigs: [], workspaces: [], portForwardingRules: [], t: (key: string) => key });
      return null;
    }
    await act(async () => { renderer = create(React.createElement(Probe)); });
    const paused = [
      "pause:running",
      "pause:queued",
      "pause:already-paused",
      "pause:pausing",
      "pause:interrupted",
    ];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        query(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("dirty check waited on resume")), 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(resumeSettled, false, "the dirty-check reply must not wait for resume");
    if (accept) {
      assert.deepEqual(reports, [[true, "transfers"], [false, undefined]]);
      assert.deepEqual(calls, ["report", ...paused, "report"], "accepted quit leaves every prompted task paused");
    } else {
      assert.deepEqual(reports, [[true, "transfers"], [true, "transfers"]], "main must be told the prompt was already answered");
      assert.deepEqual(calls, ["report", ...paused, "report", "resume:running", "resume:queued"],
        "report precedes resume, and only transferring/queued rows the prompt paused are resumed");
      // Dedicated resume promises can represent the whole transfer lifetime.
      // A second close must still prompt while those promises remain pending.
      await query();
      assert.equal(prompts, 2);
      assert.equal(resumeSettled, false);
      assert.equal(reports.length, 4);
    }
  });
}

for (const accept of [false, true]) {
  test(`packed-only quit still asks for confirmation without pausing or resuming (${accept ? "accept" : "cancel"})`, async (t) => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    let renderer: ReactTestRenderer | undefined;
    let prompts = 0;
    let query!: () => Promise<void>;
    const reports: Array<[boolean, string | undefined]> = [];
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      confirm() { prompts++; return accept; },
    } });
    t.after(async () => {
      await act(async () => renderer?.unmount());
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
      if (previousAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct); else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    });
    t.mock.method(sftpTransferCenterStore, "getSnapshot", () => ({
      activeCount: 1, queuedCount: 0, attentionCount: 0,
      tasks: [{ ...makeTask("packed", "transferring"), controlKind: "packed-download", resumable: false }],
    }));
    t.mock.method(sftpTransferCenterStore, "pause", async () => { assert.fail("packed downloads cannot be paused"); });
    t.mock.method(sftpTransferCenterStore, "resume", async () => { assert.fail("packed selections cannot be replayed"); });
    t.mock.method(netcattyBridge, "get", () => ({
      onCheckDirtyEditors(callback: typeof query) { query = callback; return () => {}; },
      reportDirtyEditorsResult(dirty: boolean, reason?: string) { reports.push([dirty, reason]); },
    }));
    function Probe() {
      useAppStartupEffects({ enabled: false, updateState: {}, sessions: [], hosts: [], keys: [], identities: [], knownHosts: [], proxyProfiles: [], groupConfigs: [], workspaces: [], portForwardingRules: [], t: (key: string) => key });
      return null;
    }
    await act(async () => { renderer = create(React.createElement(Probe)); });
    await query();
    assert.equal(prompts, 1);
    assert.deepEqual(reports, [[true, "transfers"], accept ? [false, undefined] : [true, "transfers"]]);
  });
}

for (const outcome of ["pause-rejected", "pause-expired", "prompt-expired"] as const) {
  test(`transfer quit refuses ${outcome} and resumes only the formerly active task`, async (t) => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    let renderer: ReactTestRenderer | undefined;
    let now = 0;
    let prompts = 0;
    let resumes = 0;
    const replies: Array<{ dirty: boolean; reason?: string; requestId?: string; pending?: boolean }> = [];
    let query!: (request: { requestId: string; deadline: number }) => Promise<void>;
    t.mock.method(Date, "now", () => now);
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      confirm() { prompts++; now = 6000; return true; },
    } });
    t.after(async () => {
      await act(async () => renderer?.unmount());
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
      if (previousAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct); else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    });
    t.mock.method(sftpTransferCenterStore, "getSnapshot", () => ({ activeCount: 1, queuedCount: 0, attentionCount: 0, tasks: [makeTask("running", "transferring")] }));
    t.mock.method(sftpTransferCenterStore, "pause", async () => {
      if (outcome === "pause-rejected") throw new Error("pause failed");
      if (outcome === "pause-expired") now = 6000;
    });
    t.mock.method(sftpTransferCenterStore, "resume", async () => { resumes++; });
    t.mock.method(netcattyBridge, "get", () => ({
      onCheckDirtyEditors: (callback: typeof query) => { query = callback; return () => {}; },
      reportDirtyEditorsResult: (dirty: boolean, reason?: string, options?: { requestId?: string; pending?: boolean }) => {
        replies.push({ dirty, reason, ...options });
      },
    }));
    function Probe() {
      useAppStartupEffects({ enabled: false, updateState: {}, sessions: [], hosts: [], keys: [], identities: [], knownHosts: [], proxyProfiles: [], groupConfigs: [], workspaces: [], portForwardingRules: [], t: (key: string) => key });
      return null;
    }
    await act(async () => { renderer = create(React.createElement(Probe)); });
    await query({ requestId: outcome, deadline: 5000 });
    assert.deepEqual(replies, [
      { dirty: true, reason: "transfers", requestId: outcome, pending: true },
      { dirty: true, reason: "transfers", requestId: outcome },
    ]);
    assert.equal(prompts, outcome === "prompt-expired" ? 1 : 0);
    assert.equal(resumes, 1);
  });
}

test("a cancelled task can close after an expired stuck pause, and its late completion cannot resume it", async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  let renderer: ReactTestRenderer | undefined;
  let now = 0;
  let cancelled = false;
  let prompts = 0;
  let resumes = 0;
  let releasePause!: () => void;
  const pause = new Promise<void>((resolve) => { releasePause = resolve; });
  const replies: Array<{ dirty: boolean; requestId?: string; pending?: boolean }> = [];
  let query!: (request: { requestId: string; deadline: number }) => Promise<void>;
  t.mock.method(Date, "now", () => now);
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { confirm() { prompts++; return false; } } });
  t.after(async () => {
    releasePause();
    await act(async () => renderer?.unmount());
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct); else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });
  t.mock.method(sftpTransferCenterStore, "getSnapshot", () => ({ activeCount: cancelled ? 0 : 1, queuedCount: 0, attentionCount: 0, tasks: [makeTask("stuck", cancelled ? "cancelled" : "transferring")] }));
  t.mock.method(sftpTransferCenterStore, "pause", () => pause);
  t.mock.method(sftpTransferCenterStore, "resume", async () => { resumes++; });
  t.mock.method(netcattyBridge, "get", () => ({
    onCheckDirtyEditors: (callback: typeof query) => { query = callback; return () => {}; },
    reportDirtyEditorsResult: (dirty: boolean, _reason?: string, options?: { requestId?: string; pending?: boolean }) => replies.push({ dirty, ...options }),
  }));
  function Probe() {
    useAppStartupEffects({ enabled: false, updateState: {}, sessions: [], hosts: [], keys: [], identities: [], knownHosts: [], proxyProfiles: [], groupConfigs: [], workspaces: [], portForwardingRules: [], t: (key: string) => key });
    return null;
  }
  await act(async () => { renderer = create(React.createElement(Probe)); });
  const first = query({ requestId: "stuck", deadline: 5000 });
  await query({ requestId: "overlap", deadline: 5000 });
  assert.deepEqual(replies.at(-1), { dirty: true, requestId: "overlap" });
  now = 6000;
  cancelled = true;
  await query({ requestId: "after-cancel", deadline: 11000 });
  assert.deepEqual(replies.at(-1), { dirty: false, requestId: "after-cancel" });
  const replyCount = replies.length;
  releasePause();
  await first;
  assert.equal(replies.length, replyCount, "superseded attempt must not reply again");
  assert.equal(prompts, 0);
  assert.equal(resumes, 0, "late completion must not undo the user's cancellation");
});

test("retry Cancel preserves the expired attempt auto-resume ownership", async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  let renderer: ReactTestRenderer | undefined;
  let now = 0;
  let status: TransferTask["status"] = "transferring";
  let prompts = 0;
  let resumes = 0;
  let releasePause!: () => void;
  const pause = new Promise<void>((resolve) => { releasePause = resolve; });
  const replies: Array<{ dirty: boolean; requestId?: string; pending?: boolean }> = [];
  let query!: (request: { requestId: string; deadline: number }) => Promise<void>;
  t.mock.method(Date, "now", () => now);
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { confirm() { prompts++; return false; } } });
  t.after(async () => {
    releasePause();
    await act(async () => renderer?.unmount());
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct); else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });
  t.mock.method(sftpTransferCenterStore, "getSnapshot", () => ({ activeCount: status === "transferring" || status === "pausing" ? 1 : 0, queuedCount: 0, attentionCount: 0, tasks: [makeTask("stuck", status)] }));
  t.mock.method(sftpTransferCenterStore, "pause", () => { status = "pausing"; return pause; });
  t.mock.method(sftpTransferCenterStore, "resume", async () => { resumes++; });
  t.mock.method(netcattyBridge, "get", () => ({
    onCheckDirtyEditors: (callback: typeof query) => { query = callback; return () => {}; },
    reportDirtyEditorsResult: (dirty: boolean, _reason?: string, options?: { requestId?: string; pending?: boolean }) => replies.push({ dirty, ...options }),
  }));
  function Probe() {
    useAppStartupEffects({ enabled: false, updateState: {}, sessions: [], hosts: [], keys: [], identities: [], knownHosts: [], proxyProfiles: [], groupConfigs: [], workspaces: [], portForwardingRules: [], t: (key: string) => key });
    return null;
  }
  await act(async () => { renderer = create(React.createElement(Probe)); });
  const first = query({ requestId: "stuck", deadline: 5000 });
  await query({ requestId: "overlap", deadline: 5000 });
  assert.deepEqual(replies.at(-1), { dirty: true, requestId: "overlap" });
  now = 6000;
  const retry = query({ requestId: "retry", deadline: 11000 });
  status = "paused";
  releasePause();
  await Promise.all([first, retry]);
  assert.equal(prompts, 1);
  assert.equal(resumes, 1, "Cancel must restore work running before the first attempt");
  assert.deepEqual(replies.at(-1), { dirty: true, requestId: "retry" });
});
