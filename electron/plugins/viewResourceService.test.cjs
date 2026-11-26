'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PluginViewResources } = require('./viewResourceService.cjs');
test('view images reject traversal, symlink escapes, external SVGs and oversize data before decoding', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'netcatty-view-image-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'package'); await fs.mkdir(root);
  const resources = new PluginViewResources({ electron: {}, packageStore: { preparePackageRoot: async () => root } });
  let decoded = 0; resources.rasterize = async () => { decoded++; throw new Error('Unexpected decoding'); };
  for (const name of ['../secret', '/secret', 'https://example.invalid/image.png', 'a/../b.png', 'a%2fsecret', 'a\\b.png']) await assert.rejects(resources.image({}, name), /path/);
  await fs.writeFile(path.join(directory, 'secret.png'), 'private'); await fs.symlink(path.join(directory, 'secret.png'), path.join(root, 'escape.png'));
  await assert.rejects(resources.image({}, 'escape.png'), /symlink/);
  await fs.writeFile(path.join(root, 'huge.png'), Buffer.alloc(512 * 1024 + 1));
  await assert.rejects(resources.image({}, 'huge.png'), /size/);
  for (const source of ['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="https://example.invalid/secret"/></svg>', '<svg xmlns="http://www.w3.org/2000/svg" width="999999" height="10"/>', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>attack()</script></svg>']) {
    await fs.writeFile(path.join(root, 'bad.svg'), source); await assert.rejects(resources.image({}, 'bad.svg'));
  }
  assert.equal(decoded, 0);
});

test('view images cache decoded results by plugin version/hash and never cache transient failures', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'netcatty-view-image-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'package'); await fs.mkdir(root);
  // Minimal valid 1x1 PNG header/bytes
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  ]);
  await fs.writeFile(path.join(root, 'icon.png'), pngHeader);
  const resources = new PluginViewResources({ electron: {}, packageStore: { preparePackageRoot: async () => root } });
  let attempts = 0;
  resources.rasterize = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient timeout');
    return pngHeader;
  };
  const plugin = { id: 'com.test.db', activeVersion: '0.2.0', archiveSha256: 'abc123' };
  await assert.rejects(resources.image(plugin, 'icon.png'), /transient timeout/);
  const first = await resources.image(plugin, 'icon.png');
  const second = await resources.image(plugin, 'icon.png');
  assert.equal(first.url, second.url);
  assert.equal(attempts, 2);
  resources.dispose();
});
