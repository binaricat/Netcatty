import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectPluginBrandIcon } from '@netcatty/plugin-contract';
import { validateManifestValue } from './manifest.js';
import { checkPluginCompatibility } from './compatibility.js';
import { buildPluginPackage, validatePluginDirectory, validatePluginPackage } from './archive.js';

const example = new URL('../../../examples/plugins/starter-netcatty/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('netcatty.plugin.json', example), 'utf8'));
const png = await readFile(new URL('assets/logo-light.png', example));
test('brand metadata requires the new API and feature; legacy exact API remains supported', () => {
  assert.equal(validateManifestValue(manifest).valid, true);
  assert.equal(validateManifestValue({ ...manifest, features: {} }).valid, false);
  assert.equal(validateManifestValue({ ...manifest, engines: { ...manifest.engines, api: '0.1.0-internal' } }).valid, false);
  for (const light of ['../outside.png', '/tmp/logo.png', 'https://example.com/logo.png', 'assets/a.svg', 'a\\b.png']) {
    assert.equal(validateManifestValue({ ...manifest, icon: { kind: 'package', light } }).valid, false, light);
  }
  assert.equal(checkPluginCompatibility(manifest, { netcattyVersion: '1.0.0', apiVersion: '0.1.0-internal', features: [] }).compatible, false);
  assert.equal(checkPluginCompatibility(manifest, { netcattyVersion: '1.0.0', features: ['metadata.brand-icon'] }).compatible, true);
  const { icon: _icon, features: _features, ...legacy } = manifest;
  const result = checkPluginCompatibility({ ...legacy, engines: { ...legacy.engines, api: '0.1.0-internal' } }, { netcattyVersion: '1.0.0' });
  assert.equal(result.compatible, true);
  assert.equal(result.apiVersion, '0.1.0-internal');
});
test('brand raster inspection rejects oversized, animated, truncated and disguised inputs', () => {
  assert.equal(inspectPluginBrandIcon(png, 'logo.png').width, 128);
  const webp = Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvD8ADAAcQ0f/+ByKi/wEA', 'base64');
  assert.equal(inspectPluginBrandIcon(webp, 'logo.webp').width, 16);
  const animatedWebp = Buffer.from(webp); animatedWebp.write('ANIM', 12);
  assert.throws(() => inspectPluginBrandIcon(animatedWebp, 'logo.webp'), /Animated/);
  assert.throws(() => inspectPluginBrandIcon(png, 'logo.webp'));
  assert.throws(() => inspectPluginBrandIcon(Buffer.alloc(256 * 1024 + 1), 'logo.png'));
  const huge = Buffer.from(png); huge.writeUInt32BE(513, 16);
  assert.throws(() => inspectPluginBrandIcon(huge, 'logo.png'), /dimensions/);
  assert.throws(() => inspectPluginBrandIcon(png.subarray(0, 32), 'logo.png'));
  const animated = Buffer.from(png); const idat = animated.indexOf('IDAT'); animated.write('acTL', idat);
  assert.throws(() => inspectPluginBrandIcon(animated, 'logo.png'), /Animated/);
});
test('directory validation, packing and archive validation include both brand resources', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'netcatty-brand-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'plugin'); await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'index.js'), 'export function activate() {}');
  const m = { ...manifest, main: { browser: 'index.js' }, contributes: undefined, activationEvents: [] };
  await writeFile(path.join(dir, 'netcatty.plugin.json'), JSON.stringify(m));
  await writeFile(path.join(dir, 'assets/logo-light.png'), png);
  await assert.rejects(validatePluginDirectory(dir), /missing package file/);
  await writeFile(path.join(dir, 'assets/logo-dark.png'), png);
  const archive = path.join(root, 'plugin.ncpkg');
  await buildPluginPackage(dir, archive);
  assert.deepEqual((await validatePluginPackage(archive)).manifest.icon, m.icon);
  await writeFile(path.join(dir, 'assets/logo-dark.png'), Buffer.alloc(256 * 1024 + 1));
  await assert.rejects(validatePluginDirectory(dir), /size limit/);
});

test('undeclared PNG assets remain streamed even when their names sort before the manifest', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'netcatty-brand-stream-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'plugin'); await mkdir(dir);
  const { icon: _icon, features: _features, ...plain } = manifest;
  await writeFile(path.join(dir, 'netcatty.plugin.json'), JSON.stringify({ ...plain, main: { browser: 'index.js' }, contributes: undefined, activationEvents: [] }));
  await writeFile(path.join(dir, 'index.js'), 'export function activate() {}');
  for (let i = 0; i < 16; i++) await writeFile(path.join(dir, `a-${i}.png`), Buffer.alloc(240 * 1024));
  const archive = path.join(root, 'no-brand.ncpkg'); await buildPluginPackage(dir, archive);
  // Instrument the explicit byte aggregation boundary, not RSS/GC timing.
  const originalConcat = Buffer.concat; let retainedImageBodies = 0;
  Buffer.concat = (list, totalLength) => {
    if (list.reduce((sum, item) => sum + item.length, 0) >= 240 * 1024) retainedImageBodies++;
    return originalConcat(list, totalLength);
  };
  try {
    const result = await validatePluginPackage(archive);
    assert.equal(result.fileCount, 18);
    assert.equal(retainedImageBodies, 0, 'unreferenced images must never be concatenated and retained');
  } finally { Buffer.concat = originalConcat; }
});
