import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useToolAccessGuidanceState, type ToolAccessGuidanceState } from './useToolAccessGuidanceState';
import { AI_STATE_CHANGED_EVENT } from './aiStateEvents';
import { STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED } from '../../infrastructure/config/storageKeys';
import type { AIToolIntegrationMode } from '../../infrastructure/ai/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function harness() {
  const requests: ReturnType<typeof deferred<unknown>>[] = [];
  const events = new EventTarget();
  const values = new Map([[STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED, 'true']]);
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
    window: {
      netcatty: {
        externalMcpGetStatus: () => { const request = deferred<unknown>(); requests.push(request); return request.promise; },
        aiSkillsCliGetInvocation: async () => ({ ok: true, skillPath: '/fixture/skills/SKILL.md', commandPrefix: 'fixture-cli' }),
      },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events), setTimeout, clearTimeout,
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  let result!: ToolAccessGuidanceState;
  function Harness({ mode }: { mode: AIToolIntegrationMode }) { result = useToolAccessGuidanceState(mode); return null; }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(<Harness mode="mcp" />); });
  return {
    requests, events, values, result: () => result,
    skills: async () => { await act(async () => renderer.update(<Harness mode="skills" />)); },
    close: async () => {
      await act(async () => renderer.unmount());
      for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    },
  };
}
const status = (path: string) => ({ ok: true, enabled: true, state: 'running', launcherPath: path, discoveryPath: `${path}.json` });

test('older MCP guidance response cannot overwrite a newer enable-state refresh', async () => {
  const h = await harness();
  try {
    assert.equal(h.requests.length, 1);
    await act(async () => h.events.dispatchEvent(new CustomEvent(AI_STATE_CHANGED_EVENT, { detail: { key: STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED } })));
    assert.equal(h.requests.length, 2);
    await act(async () => h.requests[1].resolve(status('/fixture/new')));
    assert.equal(h.result().mcpLauncherPath, '/fixture/new');
    await act(async () => h.requests[0].resolve(status('/fixture/old')));
    assert.equal(h.result().mcpLauncherPath, '/fixture/new');
  } finally { await h.close(); }
});

test('switching to Skills ignores pending MCP results and preserves resolved Skills guidance', async () => {
  const h = await harness();
  try {
    await h.skills();
    await act(async () => h.requests[0].resolve(status('/fixture/stale')));
    assert.equal(h.result().mcpLauncherPath, null);
    assert.equal(h.result().skillPath, '/fixture/skills/SKILL.md');
    assert.equal(h.result().commandPrefix, 'fixture-cli');
  } finally { await h.close(); }
});

test('MCP guidance completion after unmount has no visible state or retry work', async () => {
  const h = await harness();
  const initial = h.result();
  await h.close();
  await act(async () => h.requests[0].resolve(status('/fixture/stale')));
  assert.equal(h.result(), initial);
});
