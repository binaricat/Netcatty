import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

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
      const env = {
        ctx: { host: { protocol: "plugin:test" }, terminalBackend }, id: "s", interruptTrace: {},
        terminalBackend, isPluginHostProtocol: () => true,
        useCallback: (fn: unknown) => fn, resolveTerminalBroadcastTargetIds: () => ["s"],
        sessionsRef: { current: [{ id: "s", protocol: "plugin:test" }] }, isGlobalBroadcastEnabled: true,
        canUseDirectSessionWriteFallback: () => true, broadcastInterruptPrioritizersRef: { current: new Map() },
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
  const env = {
    terminalBackend: { writeToSession: (sessionId: string, data: string, options: object) => bridge.writeToSession(null, { sessionId, data, ...options }) },
    useCallback: (fn: unknown) => fn, resolveTerminalBroadcastTargetIds: () => ["s"],
    sessionsRef: { current: [{ id: "s", protocol: "ssh" }] }, isGlobalBroadcastEnabled: true,
    canUseDirectSessionWriteFallback: () => true, isTerminalSensitiveInputActive: () => false,
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
