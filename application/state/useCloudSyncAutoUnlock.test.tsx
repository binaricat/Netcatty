import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { createDomRenderer, flushEffects, installDomEnvironment, runWithAct } from '../../components/test-support/renderReactDom.tsx';
import { useCloudSyncAutoUnlock } from './useCloudSyncAutoUnlock.ts';

for (const strict of [false, true]) {
  test(`pending password read is handed off when its owner unmounts (StrictMode=${strict})`, async () => {
    const dom = installDomEnvironment();
    const renderer = await createDomRenderer(dom.document);
    const pending: Array<(value: string | null) => void> = [];
    let unlocks = 0;
    const manager = { unlock: async () => { unlocks++; return true; } };
    const bridge = { cloudSyncGetSessionPassword: () => new Promise<string | null>(resolve => { pending.push(resolve); }) };
    function Consumer() {
      useCloudSyncAutoUnlock({ securityState: 'LOCKED', masterKeyIdentity: 'handoff-key', manager, bridge });
      return null;
    }
    function tree(owner: boolean) {
      return React.createElement(strict ? React.StrictMode : React.Fragment, null,
        owner ? React.createElement(Consumer, { key: 'owner' }) : null,
        React.createElement(Consumer, { key: 'peer' }));
    }
    try {
      await renderer.render(tree(true));
      await flushEffects();
      assert.ok(pending.length > 0);
      await renderer.render(tree(false));
      await flushEffects();
      await runWithAct(async () => { for (const resolve of pending) resolve('fixture-only'); });
      await flushEffects();
      assert.equal(unlocks, 1, 'cancelled owners must not unlock when their old responses arrive');
    } finally { await renderer.unmount(); dom.cleanup(); }
  });
}

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

for (const strict of [false, true]) {
  test(`a failed attempt during key rotation keeps the password for the arriving config (StrictMode=${strict})`, async () => {
    const dom = installDomEnvironment();
    const renderer = await createDomRenderer(dom.document);
    let password: string | null = null;
    let cleared = 0;
    let currentIdentity = 'old-key';
    const listeners = new Set<() => void>();
    const unlocked: Array<[string, string]> = [];
    const manager = {
      unlock: async (value: string) => {
        unlocked.push([currentIdentity, value]);
        return currentIdentity === 'new-key';
      },
    };
    const bridge = {
      cloudSyncGetSessionPassword: async () => password,
      cloudSyncClearSessionPassword: async () => { cleared++; return true; },
      onCloudSyncSessionPasswordAvailable: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    };
    function Harness() {
      useCloudSyncAutoUnlock({ securityState: 'LOCKED', masterKeyIdentity: currentIdentity, manager, bridge });
      return null;
    }
    try {
      await renderer.render(strict ? React.createElement(React.StrictMode, null, React.createElement(Harness)) : React.createElement(Harness));
      await flushEffects();
      // The password notification overtakes the config event: the peer is
      // still locked on the old config when the new password arrives.
      await runWithAct(async () => { password = 'rotation-password'; for (const cb of listeners) cb(); });
      await flushEffects();
      assert.deepEqual(unlocked, [['old-key', 'rotation-password']], 'the new password was tried against the old config');
      assert.equal(cleared, 0, 'the failed attempt must not clear the shared password');
      // The config event arrives afterwards; the retained password must
      // still be available to auto-unlock the rotated key.
      currentIdentity = 'new-key';
      await renderer.render(strict ? React.createElement(React.StrictMode, null, React.createElement(Harness)) : React.createElement(Harness));
      await flushEffects();
      assert.deepEqual(unlocked, [
        ['old-key', 'rotation-password'],
        ['new-key', 'rotation-password'],
      ]);
      assert.equal(cleared, 0);
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
  function Harness({ state, identity = 'key' }: { state: string; identity?: string }) {
    useCloudSyncAutoUnlock({ securityState: state, masterKeyIdentity: identity, manager, bridge });
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
    await runWithAct(async () => { onAvailable?.(); });
    await flushEffects();
    assert.equal(calls, 1, 'a peer password event after deliberate lock must not reopen this vault');
    await renderer.render(null);
    await renderer.render(React.createElement(Harness, { state: 'LOCKED' }));
    await runWithAct(async () => { onAvailable?.(); });
    await flushEffects();
    assert.equal(calls, 1, 'a remounted consumer must retain the manager deliberate lock');
    await renderer.render(React.createElement(Harness, { state: 'LOCKED', identity: 'replacement-key' }));
    await flushEffects();
    assert.equal(calls, 2, 'a genuinely replaced key can still initialize automatically');
  } finally { await renderer.unmount(); dom.cleanup(); }
});

for (const strict of [false, true]) {
  test(`remount reads a password shared while no consumer was mounted (StrictMode=${strict})`, async () => {
    const dom = installDomEnvironment();
    const renderer = await createDomRenderer(dom.document);
    let password: string | null = null;
    let reads = 0;
    const unlocked: string[] = [];
    const manager = { unlock: async (value: string) => { unlocked.push(value); return true; } };
    const bridge = { cloudSyncGetSessionPassword: async () => { reads++; return password; } };
    function Consumer() {
      useCloudSyncAutoUnlock({ securityState: 'LOCKED', masterKeyIdentity: 'remount-key', manager, bridge });
      return null;
    }
    const tree = () => React.createElement(strict ? React.StrictMode : React.Fragment, null, React.createElement(Consumer));
    try {
      await renderer.render(tree());
      await flushEffects();
      assert.ok(reads > 0);
      assert.deepEqual(unlocked, []);
      await renderer.render(null);
      await flushEffects();
      password = 'fixture-shared-while-absent';
      await renderer.render(tree());
      await flushEffects();
      assert.deepEqual(unlocked, ['fixture-shared-while-absent']);
    } finally { await renderer.unmount(); dom.cleanup(); }
  });
}

test('remount during an active derivation does not start a duplicate unlock', async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  let finish!: (value: boolean) => void;
  let unlocks = 0;
  const manager = { unlock: () => { unlocks++; return new Promise<boolean>(resolve => { finish = resolve; }); } };
  const bridge = { cloudSyncGetSessionPassword: async () => 'fixture-only' };
  function Consumer() {
    useCloudSyncAutoUnlock({ securityState: 'LOCKED', masterKeyIdentity: 'active-key', manager, bridge });
    return null;
  }
  try {
    await renderer.render(React.createElement(Consumer));
    await flushEffects();
    assert.equal(unlocks, 1);
    await renderer.render(null);
    await renderer.render(React.createElement(Consumer));
    await flushEffects();
    assert.equal(unlocks, 1);
    await runWithAct(async () => finish(true));
    await flushEffects();
    assert.equal(unlocks, 1);
  } finally { await renderer.unmount(); dom.cleanup(); }
});

test('two StrictMode consumers share one derivation after initial effect replay', async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  const pending: Array<(value: string | null) => void> = [];
  let unlocks = 0;
  const manager = { unlock: async () => { unlocks++; return true; } };
  const bridge = { cloudSyncGetSessionPassword: () => new Promise<string | null>(resolve => pending.push(resolve)) };
  function Consumer() {
    useCloudSyncAutoUnlock({ securityState: 'LOCKED', masterKeyIdentity: 'strict-shared', manager, bridge });
    return null;
  }
  try {
    await renderer.render(React.createElement(React.StrictMode, null,
      React.createElement(Consumer, { key: 'one' }), React.createElement(Consumer, { key: 'two' })));
    await flushEffects();
    await runWithAct(async () => { for (const resolve of pending) resolve('fixture-only'); });
    await flushEffects();
    assert.equal(unlocks, 1);
  } finally { await renderer.unmount(); dom.cleanup(); }
});

test('password notification and a later peer mount share the same attempt', async () => {
  const dom = installDomEnvironment();
  const renderer = await createDomRenderer(dom.document);
  let password: string | null = null;
  const listeners = new Set<() => void>();
  let unlocks = 0;
  const manager = { unlock: async () => { unlocks++; return false; } };
  const bridge = {
    cloudSyncGetSessionPassword: async () => password,
    onCloudSyncSessionPasswordAvailable: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
  function Consumer() {
    useCloudSyncAutoUnlock({ securityState: 'LOCKED', masterKeyIdentity: 'notification-key', manager, bridge });
    return null;
  }
  const tree = (late: boolean) => React.createElement(React.Fragment, null,
    React.createElement(Consumer, { key: 'one' }), React.createElement(Consumer, { key: 'two' }),
    late ? React.createElement(Consumer, { key: 'late' }) : null);
  try {
    await renderer.render(tree(false));
    await flushEffects();
    assert.equal(unlocks, 0);
    await runWithAct(async () => { password = 'fixture-only'; for (const cb of listeners) cb(); });
    await flushEffects();
    assert.equal(unlocks, 1);
    await renderer.render(tree(true));
    await flushEffects();
    assert.equal(unlocks, 1, 'new consumers share the notification generation');
  } finally { await renderer.unmount(); dom.cleanup(); }
});
