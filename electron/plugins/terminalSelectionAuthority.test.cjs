"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { TerminalSelectionAuthority, LIMITS } = require("./terminalSelectionAuthority.cjs");
const { privateOwner, LOCAL_SOURCE, OFFICIAL_SOURCE } = require("./sourceIdentity.cjs");

function fixture(t) {
  const sender = { id: 7, isDestroyed: () => false };
  let window = { webContents: sender }, generation = 0, time = 100, alive = true, source = LOCAL_SOURCE;
  const listeners = new Map();
  const manager = { getPluginSessionBinding(id, owner) { return alive && owner === 7 && ['a', 'b'].includes(id) ? { epoch: 'worker-a', generation } : null; } };
  for (const key of ['onSessionOwned', 'onSessionClosed', 'onWorkerExit']) manager[key] = (fn) => { listeners.set(key, fn); return { dispose() {} }; };
  const database = { privateOwner: (id) => privateOwner(source, id), publicPluginId: (owner) => owner === privateOwner(source, 'com.example.synthetic') ? 'com.example.synthetic' : null };
  const context = { pluginId: 'com.example.synthetic', pluginVersion: '1.0.0', runtimeId: 'runtime-a', manifest: { features: { required: ['terminal.selection-sharing', 'terminal.input-drafts'] } } };
  const authority = new TerminalSelectionAuthority({ database, getWindow: () => window, getManager: () => manager, clock: () => time });
  t.after(() => authority.shutdown());
  const select = (sessionId = 'a', rendererId = 'renderer-a') => authority.setTarget(sender, { sessionId, rendererId, label: 'Synthetic terminal' });
  select();
  return { authority, context, sender, select, database, capture: () => authority.capture(sender, context),
    reconnect() { generation++; listeners.get('onSessionOwned')?.(); }, close() { alive = false; listeners.get('onSessionClosed')?.(); },
    replaceOwner() { window = { webContents: { id: 9 } }; }, expire() { time += LIMITS.handleTtlMs; authority.invalidate(); }, replaceSource() { source = OFFICIAL_SOURCE; authority.invalidate(); } };
}

test('references bind source/runtime/version/window/connection/renderer and reveal no raw objects or text', (t) => {
  const f = fixture(t), target = f.capture();
  const receipt = f.authority.issue(target, f.context);
  assert.deepEqual(Object.keys(receipt).sort(), ['expiresAt', 'handle']);
  assert.equal(f.authority.resolve(receipt.handle, f.context), target);
  assert.equal(JSON.stringify([...f.authority.handles.values()]).includes('selected text'), false);
  for (const delta of [{ runtimeId: 'other' }, { pluginVersion: '2.0.0' }, { pluginId: 'com.example.other' }]) {
    assert.throws(() => f.authority.resolve(receipt.handle, { ...f.context, ...delta }), /unavailable/);
  }
  f.select('b');
  assert.throws(() => f.authority.resolve(receipt.handle, f.context), /unavailable/);
  const second = f.authority.issue(f.capture(), f.context);
  assert.notEqual(second.handle, receipt.handle);
});

for (const action of ['reconnect', 'close', 'replaceOwner', 'expire', 'replaceSource']) test(`revokes references on ${action}`, (t) => {
  const f = fixture(t), receipt = f.authority.issue(f.capture(), f.context);
  f[action]();
  assert.throws(() => f.authority.resolve(receipt.handle, f.context), /unavailable/);
});
for (const method of ['releaseRuntime', 'releasePlugin', 'clearHandles']) test(`${method} revokes references`, (t) => {
  const f = fixture(t), receipt = f.authority.issue(f.capture(), f.context);
  f.authority[method](method === 'releaseRuntime' ? f.context.runtimeId : f.context.pluginId);
  assert.throws(() => f.authority.resolve(receipt.handle, f.context), /unavailable/);
});
test('renderer replacement and explicit null never fall back to a different session', (t) => {
  const f = fixture(t), receipt = f.authority.issue(f.capture(), f.context);
  f.select('a', 'attached-renderer');
  assert.throws(() => f.authority.resolve(receipt.handle, f.context), /unavailable/);
  f.authority.setTarget(f.sender, { sessionId: null });
  assert.throws(() => f.capture(), /Select a live terminal/);
  assert.throws(() => f.authority.setTarget({ id: 8 }, { sessionId: null }), /another window/);
});
test('missing database ownership and a bare plugin ID fail closed', (t) => {
  const f = fixture(t);
  f.database.privateOwner = () => f.context.pluginId;
  assert.throws(() => f.capture(), /source owner/);
  delete f.database.privateOwner;
  assert.throws(() => f.capture(), /source owner/);
});
test('quotas, undeclared features and malformed targets fail before issuing a reference', (t) => {
  const f = fixture(t);
  assert.throws(() => f.authority.capture(f.sender, { ...f.context, manifest: {} }), /not declared/);
  assert.throws(() => f.authority.setTarget(f.sender, { sessionId: 'a' }), /Invalid/);
  const target = f.capture();
  for (let i = 0; i < LIMITS.handlesPerRuntime; i++) f.authority.issue(target, f.context);
  assert.throws(() => f.authority.issue(target, f.context), /limit/);
});

test('expiry timer is armed lazily on handles or watches and disarmed on all 1->0 paths', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t);
  let invalidations = 0;
  f.authority.onDidInvalidate(() => { invalidations += 1; });

  assert.equal(f.authority.timer, null, 'no idle timer when handles and watches are empty');
  t.mock.timers.tick(5_000);
  assert.equal(invalidations, 0, 'idle authority must not wake on a 1s interval');

  const target = f.capture();
  f.authority.issue(target, f.context);
  assert.notEqual(f.authority.timer, null, 'issue() arms timer');
  t.mock.timers.tick(1_000);
  assert.equal(invalidations, 1);

  // Keeping a second handle active preserves the timer when only one runtime is released.
  const otherContext = { ...f.context, runtimeId: 'runtime-b' };
  f.authority.issue(target, otherContext);
  f.authority.releaseRuntime('runtime-a');
  assert.notEqual(f.authority.timer, null, 'timer stays armed while another handle remains');
  f.authority.releaseRuntime('runtime-b');
  assert.equal(f.authority.timer, null, 'releaseRuntime() disarms timer at 1->0');

  f.authority.issue(target, f.context);
  assert.notEqual(f.authority.timer, null);
  f.authority.releasePlugin(f.context.pluginId);
  assert.equal(f.authority.timer, null, 'releasePlugin() disarms timer at 1->0');

  f.authority.issue(target, f.context);
  assert.notEqual(f.authority.timer, null);
  f.authority.clearHandles();
  assert.equal(f.authority.timer, null, 'clearHandles() disarms timer at 1->0');

  // prune() disarms when the last handle expires on a timer tick.
  f.authority.issue(target, f.context);
  assert.notEqual(f.authority.timer, null);
  f.expire();
  assert.equal(f.authority.handles.size, 0);
  assert.equal(f.authority.timer, null, 'prune() disarms timer when last handle expires');
  const countAfterExpire = invalidations;
  t.mock.timers.tick(5_000);
  assert.equal(invalidations, countAfterExpire, 'no further ticks after last handle expires');

  // Ref-counted watch leases keep the timer armed even when handles.size === 0.
  const watchA = f.authority.watch();
  const watchB = f.authority.watch();
  assert.notEqual(f.authority.timer, null, 'watch() arms timer while a dialog is pending');
  t.mock.timers.tick(1_000);
  assert.equal(invalidations, countAfterExpire + 1);
  watchA.dispose();
  watchA.dispose(); // idempotent
  assert.notEqual(f.authority.timer, null, 'timer stays armed until last watch disposes');
  watchB.dispose();
  assert.equal(f.authority.timer, null, 'disposing last watch disarms timer');

  // shutdown() disarms active watches and prevents re-arming.
  const watchC = f.authority.watch();
  assert.notEqual(f.authority.timer, null);
  f.authority.shutdown();
  assert.equal(f.authority.timer, null, 'shutdown() disarms timer');
  watchC.dispose();
  const postShutdown = f.authority.watch();
  assert.equal(f.authority.timer, null, 'watch() after shutdown() must not arm timer');
  postShutdown.dispose();
});
