import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import React, { useCallback, useEffect, useRef, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import ts from "typescript";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Exercise the production lifecycle and asynchronous resolver together, without
// loading the unrelated provider forms or making real CLI/authentication calls.
const source = readFileSync(new URL("./SettingsAITab.tsx", import.meta.url), "utf8");
const lifecycleStart = source.indexOf("  const mountedRef = useRef(true);");
const lifecycleEnd = source.indexOf("\n  const applyResolvedAgentPath", lifecycleStart);
const resolverStart = source.indexOf("  const resolveAgentPath = useCallback");
const resolverEnd = source.indexOf("\n  useEffect(() => {", resolverStart);
assert.ok(lifecycleStart >= 0 && lifecycleEnd > lifecycleStart);
assert.ok(resolverStart >= 0 && resolverEnd > resolverStart);
const declarations = source.slice(lifecycleStart, lifecycleEnd) + source.slice(resolverStart, resolverEnd);
const setters = ["Codex", "Claude", "Copilot", "Cursor", "Codebuddy", "Opencode", "Grok"];
const bindings = ["useRef", "useEffect", "useCallback", "getBridge", "applyResolvedAgentPath", "cursorApiKeyEncrypted",
  ...setters.map(name => `setIsResolving${name}`)];
const runHooks = vm.runInNewContext(ts.transpile(`(function(ctx) {
  const { ${bindings.join(",")} } = ctx;
  ${declarations}
  return resolveAgentPath;
})`, { target: ts.ScriptTarget.ES2022 }), { console }) as
  (ctx: Record<string, unknown>) => (key: string) => Promise<unknown>;

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(done => { resolve = done; });
  return { promise, resolve };
}

async function mountResolver() {
  const calls: ReturnType<typeof deferred>[] = [];
  const applied: unknown[] = [];
  const state: { busy: boolean; resolve?: (key: string) => Promise<unknown> } = { busy: false };
  const bridge = { aiResolveCli: () => { const pending = deferred(); calls.push(pending); return pending.promise; } };
  function Harness() {
    const [busy, setBusy] = useState(false);
    state.busy = busy;
    state.resolve = runHooks({
      useRef, useEffect, useCallback,
      getBridge: () => bridge,
      applyResolvedAgentPath: (_key: string, result: unknown) => applied.push(result),
      cursorApiKeyEncrypted: "",
      ...Object.fromEntries(setters.map(name => [`setIsResolving${name}`, setBusy])),
    });
    return null;
  }
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => { root = TestRenderer.create(React.createElement(React.StrictMode, null, React.createElement(Harness))); });
  return { calls, applied, state, root };
}

test("AI detection accepts completed requests after StrictMode effect replay", async () => {
  const h = await mountResolver();
  try {
    let request!: Promise<unknown>;
    await act(async () => { request = h.state.resolve!("cursor"); });
    assert.equal(h.state.busy, true);
    const result = { installed: true, available: true, cliBinPath: "/fixture/cursor-agent" };
    await act(async () => { h.calls[0].resolve(result); await request; });
    assert.deepEqual(h.applied, [result]);
    assert.equal(h.state.busy, false);
  } finally { await act(async () => h.root.unmount()); }
});

test("AI detection still ignores completion after real unmount", async () => {
  const h = await mountResolver();
  let request!: Promise<unknown>;
  await act(async () => { request = h.state.resolve!("cursor"); });
  await act(async () => h.root.unmount());
  h.calls[0].resolve({ installed: true });
  await request;
  assert.deepEqual(h.applied, []);
});

test("an older AI detection result cannot replace or finish the newer request", async () => {
  const h = await mountResolver();
  try {
    let old!: Promise<unknown>;
    let current!: Promise<unknown>;
    await act(async () => { old = h.state.resolve!("cursor"); current = h.state.resolve!("cursor"); });
    await act(async () => { h.calls[0].resolve({ installed: false }); await old; });
    assert.deepEqual(h.applied, []);
    assert.equal(h.state.busy, true);
    const result = { installed: true };
    await act(async () => { h.calls[1].resolve(result); await current; });
    assert.deepEqual(h.applied, [result]);
    assert.equal(h.state.busy, false);
  } finally { await act(async () => h.root.unmount()); }
});
