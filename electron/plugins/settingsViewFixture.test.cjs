const assert = require('node:assert/strict');
const test = require('node:test');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { MessageChannel } = require('node:worker_threads');
const { PluginRpcRouter } = require('./rpcRouter.cjs');

test('actual settings-view fixture default export initializes and activates through the runtime peer', async (t) => {
  const { JSDOM } = require('jsdom'); const dom = new JSDOM('');
  const previous = globalThis.MutationObserver; globalThis.MutationObserver = dom.window.MutationObserver;
  t.after(() => { globalThis.MutationObserver = previous; dom.window.close(); });
  const root = resolve(__dirname, '../../examples/plugins/settings-view-fixture');
  const manifest = JSON.parse(await readFile(resolve(root, 'netcatty.plugin.json'), 'utf8'));
  assert.deepEqual(manifest.permissions.required, ['views', 'settings.read']);
  assert.equal(manifest.contributes.views[0].location, 'modal');
  assert.equal(manifest.contributes.settings[0].control, 'text');
  const html = await readFile(resolve(root, 'view.html'), 'utf8');
  assert.doesNotMatch(html, /<script|https?:\/\/|<iframe/i);
  const { startPluginRuntime } = await import('./runtime/runtimePeer.mjs');
  const { port1, port2 } = new MessageChannel();
  t.after(() => { port1.close(); port2.close(); });
  const host = new PluginRpcRouter({ pluginId: manifest.id, send: (message) => port1.postMessage(message) });
  t.after(() => host.close());
  port1.on('message', (message) => host.accept(message));
  const peer = await startPluginRuntime({
    port: port2,
    config: { pluginId: manifest.id, pluginVersion: manifest.version, netcattyVersion: '0.0.0', apiVersion: '0.1.0-internal', enabledFeatures: [] },
    loadPlugin: () => import(pathToFileURL(resolve(root, manifest.main.browser)).href),
  });
  t.after(() => peer.dispose());
  const initialized = await host.request('plugin.initialize', { netcattyVersion: '0.0.0', apiVersion: '0.1.0-internal', supportedFeatures: [] });
  assert.equal(initialized.pluginId, manifest.id);
  await host.request('plugin.activate', {});
  await host.request('plugin.deactivate', {});
});
