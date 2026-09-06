import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { createDomRenderer, flushEffects, installDomEnvironment, runWithAct } from '../../components/test-support/renderReactDom.tsx';
import { useCloudSyncAutoUnlock } from './useCloudSyncAutoUnlock.ts';

for (const strict of [false, true]) {
  test(`peer auto-unlocks when password arrives after the config (StrictMode=${strict})`, async () => {
    const dom = installDomEnvironment();
    const renderer = await createDomRenderer(dom.document);
    let password: string | null = null;
    const listeners = new Set<() => void>();
    const unlocked: string[] = [];
    const manager = { unlock: async (value: string) => { unlocked.push(value); return true; } };
    const bridge = {
      cloudSyncGetSessionPassword: async () => password,
      onCloudSyncSessionPasswordAvailable: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    };
    function Harness() {
      useCloudSyncAutoUnlock({ securityState: 'LOCKED', masterKeyIdentity: 'first-key', manager, bridge });
      return null;
    }
    try {
      await renderer.render(strict ? React.createElement(React.StrictMode, null, React.createElement(Harness)) : React.createElement(Harness));
      await flushEffects();
      assert.deepEqual(unlocked, [], 'the initial read really happened before the password existed');
      await runWithAct(async () => { password = 'fixture-only'; for (const cb of listeners) cb(); });
      await flushEffects();
      assert.deepEqual(unlocked, ['fixture-only']);
    } finally { await renderer.unmount(); dom.cleanup(); }
    assert.equal(listeners.size, 0);
  });
}

test('completed auto-unlock does not undo a later deliberate lock', async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  let calls = 0;
  const manager = { unlock: async () => { calls++; return true; } };
  let onAvailable: (() => void) | undefined;
  const bridge = {
    cloudSyncGetSessionPassword: async () => 'fixture-only',
    onCloudSyncSessionPasswordAvailable: (cb: () => void) => { onAvailable = cb; return () => { onAvailable = undefined; }; },
  };
  function Harness({ state }: { state: string }) {
    useCloudSyncAutoUnlock({ securityState: state, masterKeyIdentity: 'key', manager, bridge });
    return null;
  }
  try {
    await renderer.render(React.createElement(Harness, { state: 'LOCKED' }));
    await flushEffects();
    await renderer.render(React.createElement(Harness, { state: 'UNLOCKED' }));
    await runWithAct(async () => { onAvailable?.(); });
    await renderer.render(React.createElement(Harness, { state: 'LOCKED' }));
    await flushEffects();
    assert.equal(calls, 1);
  } finally { await renderer.unmount(); dom.cleanup(); }
});
