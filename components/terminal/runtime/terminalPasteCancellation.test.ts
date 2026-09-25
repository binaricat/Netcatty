import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { resolveTerminalBroadcastTargetIds } from "../../../domain/terminalBroadcast";
import * as pacedHelpers from "./terminalPacedBroadcast";
import { setTerminalBootEpoch } from "../../../domain/terminalBootEpoch";

const require = createRequire(import.meta.url);
const bridge = require("../../../electron/bridges/terminalBridge.cjs");
const runtime = readFileSync(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
const layer = readFileSync(new URL("../../TerminalLayer.tsx", import.meta.url), "utf8");
const backend = readFileSync(new URL("../../../application/state/useTerminalBackend.ts", import.meta.url), "utf8");
const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const broadcastStart = layer.indexOf("  const handleBroadcastInput = useCallback(");
const broadcastEnd = layer.indexOf("  const handleCommandSubmitted", broadcastStart);
const pluginStart = runtime.indexOf('        if (isPluginHostProtocol(ctx.host.protocol) && ctx.terminalBackend.signalPluginConnection)');
const pluginEnd = runtime.indexOf("        const interruptEventForKitty", pluginStart);
const hookStart = backend.indexOf("  const interruptSession = useCallback(");
const hookEnd = backend.indexOf("  const resizeSession", hookStart);

for (const path of ["source", "broadcast"] as const) {
  for (const failedSignal of [false, true]) {
    test(`${path} plugin interrupt cancels pending paste without duplicate raw interrupt (failure=${failedSignal})`, async t => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const writes: string[] = [];
      const calls: string[] = [];
      bridge.init({ sessions: new Map([["s", { stream: { write: (data: string) => writes.push(data) } }]]), electronModule: {} });
      bridge.writeToSession(null, { sessionId: "s", data: "one\ntwo\r", automated: true, lineDelayMs: 250 });
      const terminalBackend = {
        interruptSession(id: string, _trace?: unknown, options?: { cancelPendingWritesOnly?: boolean }) {
          calls.push(options?.cancelPendingWritesOnly ? "cancel" : "raw");
          bridge.interruptSession(null, { sessionId: id, ...options });
        },
        async signalPluginConnection() {
          calls.push("signal");
          if (failedSignal) throw new Error("unsupported");
        },
      };
      const env = { ...pacedHelpers,
        ctx: { host: { protocol: "plugin:test" }, terminalBackend }, id: "s", interruptTrace: {},
        terminalBackend, isPluginHostProtocol: () => true,
        useCallback: (fn: unknown) => fn, resolveTerminalBroadcastTargetIds: () => ["s"],
        sessionsRef: { current: [{ id: "s", protocol: "plugin:test" }] }, isGlobalBroadcastEnabled: true,
        canUseDirectSessionWriteFallback: () => true, broadcastPasswordBypassRef: { current: false }, broadcastInterruptPrioritizersRef: { current: new Map() },
        isTerminalSensitiveInputActive: () => false,
        invoke: undefined as unknown as (data: string, source: string) => void,
      };
      if (path === "source") vm.runInNewContext(compile(runtime.slice(pluginStart, pluginEnd)), env);
      else {
        vm.runInNewContext(compile(layer.slice(broadcastStart, broadcastEnd) + "\nglobalThis.invoke = handleBroadcastInput;"), env);
        env.invoke("\x03", "other");
      }
      await Promise.resolve();
      t.mock.timers.tick(1000);
      assert.deepEqual(calls, failedSignal ? ["cancel", "signal", "raw"] : ["cancel", "signal"]);
      assert.deepEqual(writes, failedSignal ? ["one\r", "\x03"] : ["one\r"]);
    });
  }
}

test("ordinary broadcast typing supersedes the recipient's paced paste", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: string[] = [];
  bridge.init({ sessions: new Map([["s", { stream: { write: (data: string) => writes.push(data) } }]]), electronModule: {} });
  const env = { ...pacedHelpers,
    terminalBackend: { writeToSession: (sessionId: string, data: string, options: object) => bridge.writeToSession(null, { sessionId, data, ...options }) },
    useCallback: (fn: unknown) => fn, resolveTerminalBroadcastTargetIds: () => ["s"],
    sessionsRef: { current: [{ id: "s", protocol: "ssh" }] }, isGlobalBroadcastEnabled: true,
    canUseDirectSessionWriteFallback: () => true, broadcastPasswordBypassRef: { current: false }, isTerminalSensitiveInputActive: () => false,
    invoke: undefined as unknown as (data: string, source: string, options?: object) => void,
  };
  vm.runInNewContext(compile(layer.slice(broadcastStart, broadcastEnd) + "\nglobalThis.invoke = handleBroadcastInput;"), env);
  env.invoke("one\ntwo\r", "other", { lineDelayMs: 250 });
  env.invoke("x", "other");
  t.mock.timers.tick(1000);
  assert.deepEqual(writes, ["one\r", "x"]);
});

test("backend hook preserves cancel-only options and never falls back to raw Ctrl+C for cancellation", () => {
  const calls: unknown[][] = [];
  let current: object = { interruptSession: (...args: unknown[]) => calls.push(args) };
  const env = {
    netcattyBridge: { get: () => current }, useCallback: (fn: unknown) => fn,
    invoke: undefined as unknown as (id: string, trace: unknown, options: object) => void,
  };
  vm.runInNewContext(compile(backend.slice(hookStart, hookEnd) + "\nglobalThis.invoke = interruptSession;"), env);
  env.invoke("s", undefined, { cancelPendingWritesOnly: true });
  assert.deepEqual(calls, [["s", undefined, { cancelPendingWritesOnly: true }]]);
  current = { writeToSession: () => assert.fail("cancel-only must not become raw Ctrl+C") };
  env.invoke("s", undefined, { cancelPendingWritesOnly: true });
});

for (const change of ["source-sensitive", "peer-sensitive", "peer-typing", "peer-interrupt", "peer-reconnect", "new-target", "removed-target", "paced-snippet"] as const) {
  test(`receipt-paced user broadcast rechecks ${change} without rescheduling peers`, t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const wire: Record<string, string[]> = { source: [], peer: [], newcomer: [] };
    const sensitive = new Set<string>();
    const batch: pacedHelpers.TerminalPacedBroadcast = {};
    setTerminalBootEpoch("peer", 1);
    const env = {
      ...pacedHelpers, useCallback: (fn: unknown) => fn, resolveTerminalBroadcastTargetIds,
      sessionsRef: { current: [{ id: "source", protocol: "ssh" }, { id: "peer", protocol: "ssh" }] as Array<{ id: string; protocol: string; workspaceId?: string }> },
      isGlobalBroadcastEnabled: true, canUseDirectSessionWriteFallback: () => true, broadcastPasswordBypassRef: { current: false },
      isTerminalSensitiveInputActive: (id: string) => sensitive.has(id),
      isPluginHostProtocol: () => false, broadcastInterruptPrioritizersRef: { current: new Map() },
      terminalBackend: {
        writeToSession(sessionId: string, data: string, options: object) { bridge.writeToSession(null, { sessionId, data, ...options }); },
        interruptSession(sessionId: string, _trace?: unknown, options?: object) { bridge.interruptSession(null, { sessionId, ...options }); },
      },
      invoke: undefined as unknown as (data: string, source: string, options?: object) => void,
    };
    vm.runInNewContext(compile(layer.slice(broadcastStart, broadcastEnd) + "\nglobalThis.invoke = handleBroadcastInput;"), env);
    bridge.init({ sessions: new Map(Object.keys(wire).map(id => [id, { webContentsId: 1, stream: { write: (data: string) => wire[id].push(data) } }])), electronModule: {
      webContents: { fromId: () => ({ send(channel: string, receipt: { sessionId: string; index?: number }) {
        if (channel === "netcatty:paste-write" && receipt.sessionId === "source" && receipt.index !== undefined) {
          env.invoke(receipt.index === 0 ? "first\r" : "second\r", "source", { pacedBroadcast: batch });
        }
      } }) },
    } });
    env.invoke("", "source", { pacedBroadcast: batch, preparePacedBroadcast: true });
    bridge.writeToSession(null, { sessionId: "source", data: "first\nsecond\r", automated: false, lineDelayMs: 250, pasteRequestId: "broadcast-test" });
    assert.deepEqual(wire.peer, ["first\r"]);
    if (change === "source-sensitive") sensitive.add("source");
    if (change === "peer-sensitive") sensitive.add("peer");
    if (change === "peer-typing" || change === "peer-interrupt") {
      env.invoke(change === "peer-typing" ? "typed" : "\x03", "other", { kittyKeyboardTargetSessionIds: ["peer"] });
    }
    if (change === "peer-reconnect") setTerminalBootEpoch("peer", 2);
    if (change === "new-target") env.sessionsRef.current.push({ id: "newcomer", protocol: "ssh" });
    if (change === "removed-target") env.sessionsRef.current[1].workspaceId = "other-workspace";
    if (change === "paced-snippet") env.invoke("snippet\r", "other", { automated: true, lineDelayMs: 250, kittyKeyboardTargetSessionIds: ["peer"] });
    const before = [...wire.peer];
    t.mock.timers.tick(250);
    assert.deepEqual(wire.source, ["first\r", "second\r"]);
    assert.deepEqual(wire.peer, change === "new-target" ? [...before, "second\r"] : before);
    assert.deepEqual(wire.newcomer, []);
  });
}
