import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginOscColorQuerySuppressionForCommand,
  endOscColorQuerySuppressionForCommand,
  installOscColorQuerySuppression,
  isDockerLogsCommand,
} from './oscColorQuerySuppression.ts';

type OscHandler = (data: string) => boolean | Promise<boolean>;

const createParser = () => {
  const handlers = new Map<number, OscHandler>();
  const disposed = new Set<number>();
  return {
    parser: {
      registerOscHandler(identifier: number, handler: OscHandler) {
        handlers.set(identifier, handler);
        return { dispose: () => disposed.add(identifier) };
      },
    },
    handlers,
    disposed,
  };
};

test('Docker log color-query suppression consumes queries but preserves color settings', async () => {
  const { parser, handlers, disposed } = createParser();
  const disposable = installOscColorQuerySuppression(parser, true);

  assert.deepEqual([...handlers.keys()], [10, 11, 12]);
  for (const identifier of [10, 11, 12]) {
    const handler = handlers.get(identifier);
    assert.ok(handler);
    assert.equal(await handler('?'), true);
    assert.equal(await handler(' ? '), true);
    assert.equal(await handler('rgb:11/22/33'), false);
    assert.equal(await handler('#123456'), false);
  }

  disposable?.dispose();
  assert.deepEqual([...disposed], [10, 11, 12]);
});

test('ordinary terminals do not install color-query suppression', () => {
  const { parser, handlers } = createParser();

  const disposable = installOscColorQuerySuppression(parser, false);

  assert.equal(disposable, undefined);
  assert.equal(handlers.size, 0);
});

test('docker logs detection covers direct and privileged commands without matching other docker commands', () => {
  assert.equal(isDockerLogsCommand('docker logs -f api'), true);
  assert.equal(isDockerLogsCommand('sudo -n docker logs --tail 200 api'), true);
  assert.equal(isDockerLogsCommand('/usr/bin/docker --context prod logs api'), true);
  assert.equal(isDockerLogsCommand('docker exec api sh'), false);
  assert.equal(isDockerLogsCommand('echo docker logs api'), false);
  assert.equal(isDockerLogsCommand('docker logs api; vim'), false);
  assert.equal(isDockerLogsCommand('docker logs api && vim'), false);
  assert.equal(isDockerLogsCommand('docker logs api | less'), false);
});

test('docker logs stays protected through prompt-like output and interrupt residue', async () => {
  const { parser, handlers } = createParser();
  const state = { current: false };
  installOscColorQuerySuppression(parser, () => state.current);

  const handler = handlers.get(11);
  assert.ok(handler);
  assert.equal(await handler('?'), false);
  beginOscColorQuerySuppressionForCommand(state, 'docker logs -f api');
  assert.equal(await handler('?'), true);
  assert.equal(await handler('rgb:11/22/33'), false);
  // Neither prompt-shaped log lines nor Ctrl+C are safe boundaries: output
  // already in flight can still contain color queries after the interrupt.
  assert.equal(await handler('?'), true);
  assert.equal(state.current, true);
});

test('the next trusted non-log command restores ordinary color queries', () => {
  const state = { current: true };
  beginOscColorQuerySuppressionForCommand(state, 'vim');
  assert.equal(state.current, false);
  endOscColorQuerySuppressionForCommand(state);
  assert.equal(state.current, false);
});
