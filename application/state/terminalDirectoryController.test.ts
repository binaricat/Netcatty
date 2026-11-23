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

test('output arriving during an old cwd query retains one fresh follow-up query', async () => {
  let finish!: (cwd: string) => void;
  let reads = 0;
  const ctx = setup({ cwd: () => {
    reads++;
    return reads === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve('/after-cd');
  } });
  const oldRead = ctx.controller.refresh();
  const queued = ctx.controller.refresh();
  finish('/before-cd');
  await Promise.all([oldRead, queued]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal(ctx.published.at(-1), '/after-cd');
  ctx.controller.dispose();
});

test('another terminal updating cannot override the current terminal strict cwd result', async t => {
  const id = 'strict-after-other-session';
  let finish!: (cwd: string) => void;
  const published: string[] = [];
  terminalCwdStore.setCwd(id, '/stale-osc7', 'stale');
  const controller = createTerminalDirectoryController({
    sessionId: id, isCurrent: () => true, isReady: () => true,
    io: { cwd: () => new Promise(resolve => { finish = resolve; }),
      list: async () => ({ entries: [], home: null }), realpath: async value => value, write() {} },
    publish: value => { published.push(value); terminalCwdStore.setCwd(id, value, 'backend-strict'); },
  });
  t.after(() => controller.dispose());
  const pending = controller.refresh();
  terminalCwdStore.setCwd('unrelated-session', '/other', 'osc7');
  finish('/actual-after-cd');
  assert.equal(await pending, '/actual-after-cd');
  assert.deepEqual(published, ['/actual-after-cd']);
  assert.equal(terminalCwdStore.getCwd(id), '/actual-after-cd');
});

test('another terminal cannot turn this submission pre-write OSC 7 into a fresh report', async t => {
  const id = 'pre-write-osc7-after-other-session';
  let finish!: (cwd: string) => void;
  const published: string[] = [];
  terminalCwdStore.setCwd(id, '/before', 'osc7');
  const controller = createTerminalDirectoryController({
    sessionId: id, confirmationMs: 20, isCurrent: () => true, isReady: () => true,
    io: { cwd: () => new Promise(resolve => { finish = resolve; }),
      list: async () => ({ entries: [], home: null }), realpath: async value => value, write() {} },
    publish: cwd => { published.push(cwd); terminalCwdStore.setCwd(id, cwd, 'backend-strict'); },
  });
  t.after(() => controller.dispose());
  const changing = controller.change('/after', new AbortController().signal, () => {});
  await new Promise(resolve => setImmediate(resolve));
  terminalCwdStore.setCwd(id + '-other', '/other', 'osc7');
  finish('/after');
  await changing;
  assert.deepEqual(published, ['/after']);
  assert.equal(terminalCwdStore.getCwd(id), '/after');
});

for (const nextCwd of ['/new-osc7', '/original']) {
  test(`a later OSC 7 report from this terminal wins (${nextCwd})`, async t => {
    const id = 'same-session-osc7-' + nextCwd;
    let finish!: (cwd: string) => void;
    const published: string[] = [];
    terminalCwdStore.setCwd(id, '/original', 'stale');
    const controller = createTerminalDirectoryController({
      sessionId: id, isCurrent: () => true, isReady: () => true,
      io: { cwd: () => new Promise(resolve => { finish = resolve; }),
        list: async () => ({ entries: [], home: null }), realpath: async value => value, write() {} },
      publish: value => { published.push(value); },
    });
    t.after(() => controller.dispose());
    const pending = controller.refresh();
    terminalCwdStore.setCwd(id, nextCwd, 'osc7');
    finish('/older-backend-result');
    assert.equal(await pending, nextCwd);
    assert.deepEqual(published, []);
  });
}

for (const probe of ['fails', 'stalls'] as const) {
  test(`a fresh post-write OSC 7 confirms navigation when the strict cwd probe ${probe}`, { timeout: 2000 }, async t => {
    const id = 'osc7-confirm-' + probe;
    const writes: string[] = [];
    terminalCwdStore.setCwd(id, '/old', 'osc7');
    const controller = createTerminalDirectoryController({
      sessionId: id, confirmationMs: 1000, isCurrent: () => true, isReady: () => true,
      io: {
        cwd: () => probe === 'fails' ? Promise.reject(new Error('no process cwd support')) : new Promise(() => {}),
        list: async () => ({ entries: [], home: null }), realpath: async value => value,
        write: data => {
          writes.push(data);
          setImmediate(() => terminalCwdStore.setCwd(id, '/next', 'osc7'));
        },
      },
      publish() { assert.fail('an unavailable probe must not publish a guessed cwd'); },
    });
    t.after(() => controller.dispose());
    await controller.change('/next', new AbortController().signal, () => {});
    assert.deepEqual(writes, ["cd -- '/next'\r"]);
    assert.equal(controller.hasConfirmedCwd(), true);
  });
}

test('navigation can probe past its pre-write OSC 7 when the shell stops reporting', async t => {
  const id = 'probe-after-pre-write-osc7';
  terminalCwdStore.setCwd(id, '/before', 'osc7');
  const controller = createTerminalDirectoryController({
    sessionId: id, isCurrent: () => true, isReady: () => true,
    io: { cwd: async () => '/after', list: async () => ({ entries: [], home: null }),
      realpath: async value => value, write() {} },
    publish: cwd => terminalCwdStore.setCwd(id, cwd, 'backend-strict'),
  });
  t.after(() => controller.dispose());
  await controller.change('/after', new AbortController().signal, () => {});
  assert.equal(terminalCwdStore.getCwd(id), '/after');
  assert.equal(terminalCwdStore.getSource(id), 'backend-strict');
});

for (const report of ['stale', 'other-session', 'other-source', 'fresh-unchanged'] as const) {
  test(`OSC 7 confirmation uses this submission's session revision (${report})`, { timeout: 2000 }, async t => {
    const id = 'osc7-revision-confirm-' + report;
    terminalCwdStore.setCwd(id, '/next', 'osc7');
    const controller = createTerminalDirectoryController({
      sessionId: id, confirmationMs: 20, isCurrent: () => true, isReady: () => true,
      io: {
        cwd: async () => { throw new Error('no process cwd support'); },
        list: async () => ({ entries: [], home: null }), realpath: async value => value,
        write() {
          if (report !== 'stale') setImmediate(() => terminalCwdStore.setCwd(
            report === 'other-session' ? id + '-other' : id, '/next', report === 'other-source' ? 'inferred' : 'osc7',
          ));
        },
      },
      publish() {},
    });
    t.after(() => controller.dispose());
    const change = controller.change('/next', new AbortController().signal, () => {});
    if (report === 'fresh-unchanged') await change;
    else await assert.rejects(change, { code: 'changeFailed' });
  });
}

for (const cancellation of ['abort', 'dispose'] as const) {
  test(`a fresh OSC 7 cannot confirm a cancelled directory change (${cancellation})`, { timeout: 2000 }, async t => {
    const id = 'osc7-cancel-' + cancellation;
    const abort = new AbortController();
    const controller = createTerminalDirectoryController({
      sessionId: id, isCurrent: () => true, isReady: () => true,
      io: { cwd: () => new Promise(() => {}), list: async () => ({ entries: [], home: null }),
        realpath: async value => value,
        write() { setImmediate(() => {
          if (cancellation === 'abort') abort.abort(); else controller.dispose();
          terminalCwdStore.setCwd(id, '/next', 'osc7');
        }); } },
      publish() {},
    });
    t.after(() => controller.dispose());
    await assert.rejects(controller.change('/next', abort.signal, () => {}), { code: 'unavailable' });
  });
}
