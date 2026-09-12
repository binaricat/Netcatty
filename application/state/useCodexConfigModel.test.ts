import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useCodexConfigModel } from './useCodexConfigModel';
import type { ExternalAgentConfig } from '../../infrastructure/ai/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const agent: ExternalAgentConfig = {
  id: 'discovered_codex', name: 'Codex', command: 'codex', sdkBackend: 'codex', enabled: true,
  env: { CODEX_HOME: '/fixture/custom' },
};

for (const codexRuntime of ['sdk', 'app-server'] as const) {
  test(`${codexRuntime}: quick send waits for the picker probe and receives its custom model`, async () => {
    let resolve!: (result: unknown) => void;
    const calls: unknown[] = [];
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { netcatty: {
      aiCodexGetIntegration: (opts: unknown) => { calls.push(opts); return new Promise(done => { resolve = done; }); },
    } } });
    let result!: ReturnType<typeof useCodexConfigModel>;
    function Harness({ config }: { config: ExternalAgentConfig }) {
      result = useCodexConfigModel(config, true);
      return null;
    }
    let root!: TestRenderer.ReactTestRenderer;
    try {
      const config = { ...agent, codexRuntime };
      await act(async () => { root = TestRenderer.create(React.createElement(Harness, { config })); });
      assert.equal(result.model, null);
      let sent = false;
      const sending = result.loadModel().then(model => { sent = true; return model; });
      await Promise.resolve();
      assert.equal(sent, false);
      assert.equal(calls.length, 1);
      assert.deepEqual((calls[0] as { agentEnv: unknown }).agentEnv, agent.env);
      await act(async () => { resolve({ customConfig: { model: 'glm-5' } }); await sending; });
      assert.equal(await sending, 'glm-5');
      assert.equal(result.model, 'glm-5');
      // A different agent must not inherit the previous home/model or promise.
      await act(async () => { root.update(React.createElement(Harness, { config: { ...config, env: { CODEX_HOME: '/fixture/other' } } })); });
      assert.equal(result.model, null);
      assert.equal(calls.length, 2);
      await act(async () => { resolve({ customConfig: null }); await result.loadModel(); });
      assert.equal(result.model, null);
    } finally {
      await act(async () => root?.unmount());
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });
}

test('non-Codex agents keep their model flow without probing Codex', async () => {
  let result!: ReturnType<typeof useCodexConfigModel>;
  function Harness() { result = useCodexConfigModel(undefined, true); return null; }
  let root!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => { root = TestRenderer.create(React.createElement(Harness)); });
    assert.equal(await result.loadModel(), null);
  } finally { await act(async () => root.unmount()); }
});
