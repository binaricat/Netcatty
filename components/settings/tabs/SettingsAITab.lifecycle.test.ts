import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import ts from "typescript";
import { canSendWithAgent } from "../../ai/agentSendEligibility";
import { buildManagedAgentState, getUnavailablePreferredHarness } from "./ai/managedAgentState";
import type { ExternalAgentConfig } from "../../../infrastructure/ai/types";

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


// Mount the same option computation and normalization effect that the
// Settings tab runs after a probe has updated the actual saved agent state.
const pickerStart = source.indexOf("  // Agent options for default agent");
const pickerEnd = source.indexOf("\n  useEffect(() => {\n    const bridge", pickerStart);
assert.ok(pickerStart >= 0 && pickerEnd > pickerStart);
const runDefaultPicker = vm.runInNewContext(ts.transpile(`(function(ctx) {
  const { useMemo, useEffect, externalAgents, defaultAgentId, setDefaultAgentId, t,
    canSendWithAgent, getUnavailablePreferredHarness, React, AgentIconBadge } = ctx;
  ${source.slice(pickerStart, pickerEnd)}
  return agentOptions;
})`, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }), { console }) as
  (ctx: Record<string, unknown>) => { value: string; disabled?: boolean }[];

test("Settings retains the unavailable saved default, blocks sends and restores the same choice", async () => {
  const agent: ExternalAgentConfig = {
    id: "discovered_copilot",
    name: "GitHub Copilot CLI",
    command: "/fixture/copilot",
    commandSource: "manual",
    sdkBackend: "copilot",
    enabled: true,
    available: true,
  };
  let options: ReturnType<typeof runDefaultPicker> = [];
  let choice = "";
  function Harness({ agents }: { agents: ExternalAgentConfig[] }) {
    const [defaultAgentId, setDefaultAgentId] = useState(agent.id);
    options = runDefaultPicker({
      useMemo, useEffect, externalAgents: agents, defaultAgentId, setDefaultAgentId,
      t: (key: string) => key, canSendWithAgent, getUnavailablePreferredHarness, React,
      AgentIconBadge: () => null,
    });
    choice = defaultAgentId;
    return null;
  }
  const failed = buildManagedAgentState([agent], agent.id, "copilot", null, "manual");
  const recovered = buildManagedAgentState(failed.agents, agent.id, "copilot", {
    path: agent.command, available: true, version: "1.0.106",
  }, "manual");
  let root!: TestRenderer.ReactTestRenderer;
  const render = (agents: ExternalAgentConfig[]) => React.createElement(Harness, { agents });
  try {
    await act(async () => { root = TestRenderer.create(render([agent])); });
    await act(async () => { root.update(render(failed.agents)); });
    assert.equal(choice, agent.id);
    assert.equal(options.find(option => option.value === agent.id)?.disabled, true);
    assert.equal(canSendWithAgent(choice, failed.agents), false);
    await act(async () => { root.update(render(recovered.agents)); });
    assert.equal(choice, agent.id);
    assert.equal(options.find(option => option.value === agent.id)?.disabled, undefined);
    assert.equal(canSendWithAgent(choice, recovered.agents), true);
    const reset = buildManagedAgentState(recovered.agents, agent.id, "copilot", null, "auto");
    await act(async () => { root.update(render(reset.agents)); });
    assert.equal(choice, "catty");
  } finally { await act(async () => root.unmount()); }
});
