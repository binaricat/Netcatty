import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminalDirectoryController } from './terminalDirectoryController';
import { terminalCwdStore } from './terminalCwdStore';
import type { TerminalDirectoryIO } from '../../infrastructure/services/terminalDirectory';

function setup(overrides: Partial<TerminalDirectoryIO> = {}) {
  let cwd = '/old'; let ready = true; let current = true;
  const writes: string[] = [];
  const published: string[] = [];
  const controller = createTerminalDirectoryController({
    sessionId: 'test-directory', confirmationMs: 10,
    io: { cwd: async () => cwd, list: async () => ({ entries: [], home: null }), realpath: async path => path,
      write: data => { writes.push(data); cwd = '/next'; }, ...overrides },
    isCurrent: () => current, isReady: () => ready,
    publish: value => { published.push(value); terminalCwdStore.setCwd('test-directory', value, 'backend-strict'); },
  });
  return { controller, writes, published, busy: () => { ready = false; }, stale: () => { current = false; } };
}

test('navigation writes one quoted cd and waits for actual cwd before confirming', async () => {
  const ctx = setup(); const accepted: string[] = [];
  await ctx.controller.change('/next', new AbortController().signal, () => accepted.push('accepted'));
  assert.deepEqual(ctx.writes, ["cd -- '/next'\r"]);
  assert.deepEqual(accepted, ['accepted']);
  assert.deepEqual(ctx.published, ['/next']);
  ctx.controller.dispose();
});

test('busy, control-character and stale sessions never receive bytes', async () => {
  const ctx = setup(); ctx.busy();
  await assert.rejects(ctx.controller.change('/next', new AbortController().signal, () => {}), { code: 'busy' });
  const invalid = setup();
  await assert.rejects(invalid.controller.change('/next\n', new AbortController().signal, () => {}), { code: 'unsupportedPath' });
  const stale = setup(); stale.stale();
  await assert.rejects(stale.controller.change('/next', new AbortController().signal, () => {}), { code: 'unavailable' });
  assert.deepEqual([...ctx.writes, ...invalid.writes, ...stale.writes], []);
});

test('rechecks readiness after async path resolution; double submission is rejected', async () => {
  let finish!: (path: string) => void;
  const ctx = setup({ realpath: () => new Promise(resolve => { finish = resolve; }) });
  const first = ctx.controller.change('/next', new AbortController().signal, () => {});
  await assert.rejects(ctx.controller.change('/other', new AbortController().signal, () => {}), { code: 'busy' });
  ctx.busy(); finish('/next');
  await assert.rejects(first, { code: 'busy' });
  assert.deepEqual(ctx.writes, []);
});

test('a disposed connection rejects delayed reads and cannot publish into a new generation', async () => {
  let finish!: (cwd: string) => void;
  const ctx = setup({ cwd: () => new Promise(resolve => { finish = resolve; }) });
  const read = ctx.controller.refresh();
  ctx.controller.dispose(); finish('/stale');
  await assert.rejects(read, { code: 'unavailable' });
  assert.deepEqual(ctx.published, []);
});

test('a failed cd keeps the observed cwd and never retries the write', async () => {
  const ctx = setup({ write: () => {}, cwd: async () => '/old' });
  await assert.rejects(ctx.controller.change('/missing', new AbortController().signal, () => {}), { code: 'changeFailed' });
  assert.ok(ctx.published.every(value => value === '/old'));
});

test('directory symlinks confirm against physical cwd', async () => {
  const ctx = setup({ realpath: async path => path === '/link' ? '/real' : path, cwd: async () => '/real' });
  await ctx.controller.change('/link', new AbortController().signal, () => {});
  assert.equal(ctx.published.at(-1), '/real');
});
