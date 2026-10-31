import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminalDirectoryController } from './terminalDirectoryController';
import {
  observeTerminalDirectory, registerTerminalDirectory,
  scheduleObservedTerminalDirectoryRefresh,
} from './terminalDirectoryRegistry';

test('manual terminal output refreshes cwd without a trusted command-completion event', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cwd = '/before'; let reads = 0;
  const published: string[] = [];
  const controller = createTerminalDirectoryController({
    sessionId: 'unrecognized-prompt', isCurrent: () => true, isReady: () => false,
    io: { cwd: async () => { reads++; return cwd; },
      list: async () => ({ entries: [], home: null }), realpath: async value => value, write() {} },
    publish: value => { published.push(value); },
  });
  const unregister = registerTerminalDirectory('unrecognized-prompt', controller);
  const stopObserving = observeTerminalDirectory('unrecognized-prompt');
  t.after(() => { stopObserving(); unregister(); });
  cwd = '/after-manual-cd';
  // Multiple prompt/output chunks produce just one read. No trusted prompt
  // detection, command-completed callback, or parsed `cd` is involved.
  scheduleObservedTerminalDirectoryRefresh('unrecognized-prompt');
  t.mock.timers.tick(80);
  scheduleObservedTerminalDirectoryRefresh('unrecognized-prompt');
  t.mock.timers.tick(149);
  assert.equal(reads, 0);
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(published, ['/after-manual-cd']);
  assert.equal(reads, 1);
  t.mock.timers.tick(60_000);
  assert.equal(reads, 1, 'no polling after output has settled');
});

test('disabling chips cancels a queued output refresh and ignores future terminal output', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const controller = createTerminalDirectoryController({
    sessionId: 'hidden-chips', isCurrent: () => true, isReady: () => true,
    io: { cwd: async () => { reads++; return '/unused'; }, list: async () => ({ entries: [], home: null }),
      realpath: async value => value, write() {} }, publish() {},
  });
  const unregister = registerTerminalDirectory('hidden-chips', controller);
  t.after(unregister);
  const stopObserving = observeTerminalDirectory('hidden-chips');
  scheduleObservedTerminalDirectoryRefresh('hidden-chips');
  stopObserving();
  t.mock.timers.tick(1000);
  scheduleObservedTerminalDirectoryRefresh('hidden-chips');
  t.mock.timers.tick(1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0);
});
