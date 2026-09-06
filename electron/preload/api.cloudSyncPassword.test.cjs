const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createPreloadApi } = require('./api.cjs');

test('password-availability subscription exposes no IPC payload and unsubscribes', () => {
  const ipcRenderer = new EventEmitter();
  const api = createPreloadApi({ ipcRenderer, webUtils: {} });
  const calls = [];
  const unsubscribe = api.onCloudSyncSessionPasswordAvailable((...args) => calls.push(args));
  ipcRenderer.emit('netcatty:cloudSync:session:passwordAvailable', { sender: 'private' }, 'must-not-forward');
  assert.deepEqual(calls, [[]]);
  unsubscribe();
  ipcRenderer.emit('netcatty:cloudSync:session:passwordAvailable', {});
  assert.equal(calls.length, 1);
  assert.equal(ipcRenderer.listenerCount('netcatty:cloudSync:session:passwordAvailable'), 0);
});
