const assert = require('node:assert/strict');
const test = require('node:test');
const { createWslDirectoryReader, getWslDirectoryArgs } = require('./wslDirectoryIntegration.cjs');

test('directory helper keeps the named distro and user and accepts only interactive launch arguments', () => {
  assert.deepEqual(getWslDirectoryArgs(['-d', 'Ubuntu', '--user', 'me', '--cd', '~'], 'Ubuntu'),
    ['--distribution', 'Ubuntu', '--user', 'me']);
  assert.equal(getWslDirectoryArgs(['-d', 'Ubuntu'], 'Other'), null);
  assert.equal(getWslDirectoryArgs(['-d', 'Ubuntu', '--exec', '/bin/bash'], 'Ubuntu'), null);
  assert.equal(getWslDirectoryArgs(['--cd', '~'], 'Ubuntu'), null);
});

test('a result from before input or from a replacement WSL Bash cannot confirm cwd', async () => {
  let finish;
  const reader = createWslDirectoryReader(() => new Promise(resolve => { finish = resolve; }));
  const old = reader.read();
  reader.invalidate();
  finish({ identity: '5:10', cwd: '/stale' });
  assert.equal((await old).success, false);

  const current = reader.read();
  finish({ identity: '5:10', cwd: '/mnt/c' });
  assert.equal((await current).cwd, '/mnt/c');

  const replacement = reader.read();
  finish({ identity: '5:99', cwd: '/different-session' });
  assert.equal((await replacement).success, false);
});
