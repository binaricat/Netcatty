const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getTempFilePath } = require('../../tempDirBridge.cjs');
const { listOpenCodeModels, resetOpenCodeListServerPool } = require('./opencodeDriver.cjs');

test('OpenCode releases the process-env gate after spawning separate catalog profiles', {
  skip: process.platform === 'win32' && 'fixture executable uses a POSIX shebang',
  timeout: 15000,
}, async (t) => {
  try { await import('@opencode-ai/sdk'); } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    t.skip('optional OpenCode SDK is not installed');
    return;
  }
  const root = fs.mkdtempSync(`${getTempFilePath('opencode-startup-test')}-`);
  const binPath = path.join(root, 'opencode');
  const startedPath = path.join(root, 'started');
  const readyPath = path.join(root, 'ready');
  const originalHome = process.env.HOME;
  fs.writeFileSync(binPath, `#!${process.execPath}
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = ${JSON.stringify(root)};
const profile = path.basename(process.env.HOME);
fs.appendFileSync(path.join(root, 'started'), profile + '\\n');
if (profile === 'profile-failed') process.exit(7);
const port = Number(process.argv.find(arg => arg.startsWith('--port=')).split('=')[1]);
const server = http.createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ providers: [], default: { fixture: profile } }));
});
const poll = setInterval(() => {
  if (!fs.existsSync(path.join(root, 'ready'))) return;
  clearInterval(poll);
  server.listen(port, '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:' + port));
}, 10);
`, { mode: 0o755 });
  const loads = ['profile-a', 'profile-b'].map(profile => listOpenCodeModels({
    binPath,
    env: { PATH: process.env.PATH, HOME: path.join(root, profile) },
  }));
  // Observe every rejection immediately, including failures during cleanup.
  const settled = Promise.allSettled(loads);
  try {
    const deadline = Date.now() + 5000;
    let profiles = [];
    while (Date.now() < deadline) {
      profiles = fs.existsSync(startedPath) ? fs.readFileSync(startedPath, 'utf8').trim().split('\n') : [];
      if (profiles.length === 2) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepEqual(profiles.sort(), ['profile-a', 'profile-b'], 'both profiles must spawn without waiting for either server to become ready');
    assert.equal(process.env.HOME, originalHome, 'the parent environment must be restored while servers start');
    fs.writeFileSync(readyPath, 'ready');
    const results = await settled;
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled']);
    assert.deepEqual(results.map(result => result.value.currentModelId), ['fixture/profile-a', 'fixture/profile-b']);
    // A rejected startup must restore the environment and release the gate
    // as well, so a subsequent profile still starts with its own HOME.
    resetOpenCodeListServerPool();
    const failed = await listOpenCodeModels({
      binPath, env: { PATH: process.env.PATH, HOME: path.join(root, 'profile-failed') },
    }).catch(error => {
      assert.match(error.message, /Server exited with code 7/);
      return { models: [] };
    });
    assert.equal(failed.models.length, 0);
    assert.equal(process.env.HOME, originalHome);
    const retry = await listOpenCodeModels({
      binPath, env: { PATH: process.env.PATH, HOME: path.join(root, 'profile-retry') },
    });
    assert.equal(retry.currentModelId, 'fixture/profile-retry');
    assert.equal(process.env.HOME, originalHome);
  } finally {
    fs.writeFileSync(readyPath, 'ready');
    await settled;
    resetOpenCodeListServerPool();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
