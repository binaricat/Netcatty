'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PluginViewResources } = require('./viewResourceService.cjs');
test('view images reject traversal, symlink escapes, external SVGs and oversize data before decoding', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'netcatty-view-image-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
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
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
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

test('view images persist validated PNGs to disk cache and recover cleanly from corrupt cache files', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'netcatty-view-image-disk-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
  const root = path.join(directory, 'package');
  const cacheDir = path.join(directory, 'image-cache');
  await fs.mkdir(root);
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  ]);
  await fs.writeFile(path.join(root, 'db.png'), pngHeader);
  const plugin = { id: 'com.test.db', activeVersion: '0.3.0', archiveSha256: 'a'.repeat(64) };
  let rasterizeCalls = 0;
  const rasterizeIcon = async () => {
    rasterizeCalls += 1;
    return pngHeader;
  };
  const firstResources = new PluginViewResources({
    electron: {},
    packageStore: { preparePackageRoot: async () => root },
    rasterizeIcon,
    cacheDir,
  });
  const cold = await firstResources.image(plugin, 'db.png');
  assert.equal(rasterizeCalls, 1);
  // Wait briefly for best-effort atomic disk cache write.
  for (let i = 0; i < 40; i += 1) {
    const files = await fs.readdir(cacheDir).catch(() => []);
    if (files.some((f) => f.endsWith('.png') && !f.startsWith('.tmp-'))) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  firstResources.dispose();

  // Second instance (simulating app restart) hits disk cache with 0 rasterize calls.
  const secondResources = new PluginViewResources({
    electron: {},
    packageStore: { preparePackageRoot: async () => { throw new Error('should not touch package on disk hit'); } },
    rasterizeIcon,
    cacheDir,
  });
  const warm = await secondResources.image(plugin, 'db.png');
  assert.equal(warm.url, cold.url);
  assert.equal(rasterizeCalls, 1);
  secondResources.dispose();

  // Corrupt the cached PNG on disk -> third instance rejects corrupt bytes and re-rasterizes cleanly.
  const cachedFiles = (await fs.readdir(cacheDir)).filter((f) => f.endsWith('.png'));
  assert.equal(cachedFiles.length, 1);
  await fs.writeFile(path.join(cacheDir, cachedFiles[0]), Buffer.from('not-a-png'));
  const thirdResources = new PluginViewResources({
    electron: {},
    packageStore: { preparePackageRoot: async () => root },
    rasterizeIcon,
    cacheDir,
  });
  const recovered = await thirdResources.image(plugin, 'db.png');
  assert.equal(recovered.url, cold.url);
  assert.equal(rasterizeCalls, 2);
  thirdResources.dispose();
});
