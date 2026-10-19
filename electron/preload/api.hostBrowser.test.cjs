const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createPreloadApi } = require('./api.cjs');

test('browser requests survive before the lazy terminal receiver subscribes', () => {
  const ipcRenderer = new EventEmitter();
  const api = createPreloadApi({ ipcRenderer, webUtils: {} });
  const first = { host: { id: 'first' } };
  const second = { host: { id: 'second' }, url: 'http://localhost:3000/' };
  const delivered = [];
  ipcRenderer.emit('netcatty:host-browser:request-panel', {}, first);
  ipcRenderer.emit('netcatty:host-browser:request-panel', {}, second);
  const off = api.onHostBrowserPanelRequest((request) => delivered.push(request));
  assert.deepEqual(delivered, [first, second]);
  off();
  const third = { host: { id: 'third' } };
  ipcRenderer.emit('netcatty:host-browser:request-panel', {}, third);
  const offAgain = api.onHostBrowserPanelRequest((request) => delivered.push(request));
  assert.deepEqual(delivered, [first, second, third], 'queued requests must be consumed once');
  ipcRenderer.emit('netcatty:host-browser:request-panel', {}, first);
  assert.deepEqual(delivered, [first, second, third, first]);
  offAgain();
});
