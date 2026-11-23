"use strict";
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { GitHubInstallService, fetchGitHubBytes, assertGitHubUrl } = require('./githubInstallService.cjs');
const { PluginDatabase } = require('./database.cjs');
const { PackageStore } = require('./packageStore.cjs');
const { PluginManager } = require('./pluginManager.cjs');
const { createPluginPaths } = require('./paths.cjs');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'netcatty-github-test-'));
  const database = new PluginDatabase(createPluginPaths(root).database);
  t.after(async () => { database.close(); await fs.rm(root, { recursive: true, force: true }); });
  const packageStore = new PackageStore({ paths: createPluginPaths(root), database, netcattyVersion: '0.0.0', apiVersion: '0.1.0-internal.1', supportedFeatures: ['metadata.brand-icon'], allowAdvancedPlugins: false });
  const manager = new PluginManager({ database, packageStore, runtimeSupervisor: { startEnabled() {}, stop() {}, start() {} } });
  await manager.initialize();
  const cli = await import('@netcatty/plugin-cli');
  const archive = path.join(root, 'fixture.ncpkg');
  // This is the real existing first-party example, packaged by the actual CLI.
  await cli.buildPluginPackage(path.resolve('examples/plugins/starter-netcatty'), archive);
  const bytes = await fs.readFile(archive);
  const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  const asset = { id: 123, name: 'starter.ncpkg', state: 'uploaded', size: bytes.length, digest, browser_download_url: 'https://github.com/owner/repo/releases/download/v0.1.0/starter.ncpkg', ...options.asset };
  const release = { tag_name: 'v0.1.0', draft: false, prerelease: false, assets: [asset], ...options.release };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (options.fetch) return options.fetch(url, init);
    if (url === 'https://api.github.com/repos/owner/repo') return Response.json({ full_name: 'Owner/Repo', private: false });
    if (url.endsWith('/releases/latest')) return Response.json(release);
    if (url.includes('/commits/')) return Response.json({ sha: 'a'.repeat(40) });
    if (url === asset.browser_download_url) return new Response(options.bytes ?? bytes);
    throw new Error('Unexpected fixture URL: ' + url);
  };
  const service = new GitHubInstallService({ manager, fetch: fetchImpl, getTempFilePath: (name) => path.join(root, name) });
  t.after(async () => { for (const owner of service.previews.keys()) await service.discard(owner); });
  return { root, manager, service, database, bytes, calls, cli, asset };
}

test('actual example package downloads, previews permissions, installs disabled, survives recovery and retains repository binding', async t => {
  const f = await fixture(t);
  const owner = {};
  const preview = await f.service.prepare(owner, 'github.com/Owner/Repo.git/');
  assert.equal((await f.manager.list()).length, 0, 'review does not install');
  assert.equal(preview.source.origin, 'https://github.com/owner/repo');
  assert.equal(preview.source.commit, 'a'.repeat(40));
  assert.equal(preview.source.tag, 'v0.1.0');
  assert.equal(preview.manifest.id, 'com.netcatty.starter');
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every(call => call.init.credentials === 'omit' && call.init.redirect === 'manual' && !call.init.headers.Authorization));
  await assert.rejects(f.service.install({}, preview.token), /expired/);
  const plugin = await f.service.install(owner, preview.token);
  assert.equal(plugin.enabled, false);
  assert.equal(plugin.archiveSha256, preview.archiveSha256);
  assert.deepEqual(plugin.source, preview.source);
  await f.manager.packageStore.recover();
  assert.deepEqual(f.database.getActivePlugin(plugin.id).source, preview.source);
  assert.equal(f.service.previews.size, 0);
  await assert.rejects(f.service.install(owner, preview.token), /expired/);
  await assert.rejects(f.manager.install(path.join(f.root, 'fixture.ncpkg'), { enable: false }), /source differs/);
});

test('preview tampering, stale selections and cancellation cannot install unreviewed bytes', async t => {
  const f = await fixture(t);
  const owner = {};
  const first = await f.service.prepare(owner, 'owner/repo');
  const second = await f.service.prepare(owner, 'https://github.com/owner/repo');
  await assert.rejects(f.service.install(owner, first.token), /expired/);
  const pending = f.service.previews.get(owner);
  await fs.copyFile(path.join(f.root, 'fixture.ncpkg'), pending.archive);
  pending.preview.archiveSha256 = '0'.repeat(64);
  await assert.rejects(f.service.install(owner, second.token), /changed after preview/);
  assert.equal((await f.manager.list()).length, 0);
  const third = await f.service.prepare(owner, 'owner/repo');
  await f.service.discard(owner, third.token);
  await assert.rejects(f.service.install(owner, third.token), /expired/);
});

test('release resolver rejects missing tags/artifacts, ambiguous packages and asset substitution without installing', async t => {
  for (const release of [{ tag_name: '' }, { prerelease: true }, { assets: [] }, { assets: [{ name: 'a.ncpkg' }, { name: 'b.ncpkg' }] }]) {
    await t.test(JSON.stringify(release), async t => {
      const f = await fixture(t, { release });
      await assert.rejects(f.service.prepare({}, 'owner/repo'), /release|assets|asset/);
      assert.equal((await f.manager.list()).length, 0);
    });
  }
  for (const asset of [{ name: '../evil.ncpkg' }, { browser_download_url: 'https://github.com/another/repo/releases/download/v0.1.0/starter.ncpkg' }, { size: 999999999 }, { digest: 'sha256:' + '0'.repeat(64) }]) {
    await t.test(JSON.stringify(asset), async t => {
      const f = await fixture(t, { asset });
      await assert.rejects(f.service.prepare({}, 'owner/repo'), /artifact|belong|size|SHA-256/);
      assert.equal(f.service.previews.size, 0);
    });
  }
});

test('HTML/XML and invalid ZIP fail real package validation', async t => {
  for (const bytes of [Buffer.from('<html>not a plugin</html>'), Buffer.from('<?xml version="1.0"?><Error/>'), Buffer.from('PK\x03\x04corrupt')]) {
    await t.test(bytes.toString(), async t => {
      const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
      const f = await fixture(t, { bytes, asset: { size: bytes.length, digest } });
      await assert.rejects(f.service.prepare({}, 'owner/repo'), /package|zip|ZIP|archive|central|small/i);
      assert.equal((await f.manager.list()).length, 0);
    });
  }
});

test('transport distinguishes offline, rate limit, inaccessible repository and server failure; rejects unsafe redirects and bounds streaming', async () => {
  const url = 'https://api.github.com/repos/owner/repo/releases/latest';
  const run = (fetchImpl, extra = {}) => fetchGitHubBytes(url, { limit: 10, api: true, fetchImpl, ...extra });
  await assert.rejects(run(async () => { throw new Error('offline'); }), /network connection/);
  for (const [status, expected] of [[404, /not found/], [401, /access denied/], [403, /access denied/], [429, /rate limit/], [500, /HTTP 500/]]) await assert.rejects(run(async () => new Response('', { status })), expected);
  await assert.rejects(run(async () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })), /rate limit/);
  await assert.rejects(run(async () => new Response('', { status: 301, headers: { location: 'https://api.github.com/repos/another/repo' } })), /moved/);
  for (const destination of ['http://github.com/file', 'https://evil.com/file', 'https://github.com:444/file', 'https://user:pass@github.com/file', 'https://release-assets.githubusercontent.com.evil.com/file']) {
    await assert.rejects(fetchGitHubBytes('https://github.com/owner/repo/releases/download/v1/test.ncpkg', { limit: 10, fetchImpl: async () => new Response('', { status: 302, headers: { location: destination } }) }), /approved HTTPS/);
  }
  assert.equal(assertGitHubUrl('https://release-assets.githubusercontent.com/asset?signature=fixture'), 'https://release-assets.githubusercontent.com/asset?signature=fixture');
  await assert.rejects(run(async () => new Response('12345678901')), /size limit/);
  await assert.rejects(run(async () => new Response('', { headers: { 'content-length': '11' } })), /size limit/);
  await assert.rejects(run(async () => new Response('<html/>', { headers: { 'content-type': 'text/html' } })), /HTML\/XML/);
  await assert.rejects(run(async () => new Response('<Error/>', { headers: { 'content-type': 'application/xml' } })), /HTML\/XML/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run(async () => { throw new Error('aborted'); }, { signal: controller.signal }), /timed out/);
  let redirects = 0;
  const bytes = await fetchGitHubBytes('https://github.com/owner/repo/releases/download/v1/test.ncpkg', { limit: 10, fetchImpl: async () => ++redirects === 1 ? new Response('', { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset?signature=fixture' } }) : new Response('PK') });
  assert.equal(bytes.toString(), 'PK');
});

test('repository absence, missing stable release/tag commit, malformed metadata and transfer truncation stay distinct', async t => {
  for (const [which, expected] of [
    ['repository', /repository or asset not found/], ['release', /no published stable release/], ['commit', /release tag has no accessible commit/],
    ['json', /expected JSON object/], ['truncated', /size mismatch/], ['manifest', /changed after preview/],
  ]) await t.test(which, async t => {
    const f = await fixture(t);
    if (which === 'manifest') {
      const owner = {};
      const preview = await f.service.prepare(owner, 'owner/repo');
      f.service.previews.get(owner).preview.manifest.publisher = 'unreviewed';
      await assert.rejects(f.service.install(owner, preview.token), expected);
    } else {
      const original = f.service.fetch;
      f.service.fetch = async (url, init) => {
        if ((which === 'repository' && url.endsWith('/owner/repo')) || (which === 'release' && url.endsWith('/latest')) || (which === 'commit' && url.includes('/commits/'))) return new Response('', { status: 404 });
        if (which === 'json' && url.endsWith('/latest')) return Response.json(null);
        if (which === 'truncated' && url.startsWith('https://github.com/')) return new Response(f.bytes.subarray(0, 30));
        return original(url, init);
      };
      await assert.rejects(f.service.prepare({}, 'owner/repo'), expected);
    }
    assert.equal((await f.manager.list()).length, 0);
  });
});

test('CRC/content corruption is rejected even when the release size and SHA-256 match the downloaded ZIP', async t => {
  const f = await fixture(t);
  const damaged = Buffer.from(f.bytes);
  // Mutate stored file data, leaving all ZIP metadata and the manifest untouched.
  const marker = damaged.indexOf(Buffer.from('export'));
  assert.ok(marker > 0);
  damaged[marker] ^= 1;
  const original = f.service.fetch;
  f.service.fetch = async (url, init) => {
    if (url.endsWith('/latest')) return Response.json({ tag_name: 'v0.1.0', assets: [{ ...f.asset, digest: 'sha256:' + createHash('sha256').update(damaged).digest('hex') }] });
    if (url.startsWith('https://github.com/')) return new Response(damaged);
    return original(url, init);
  };
  await assert.rejects(f.service.prepare({}, 'owner/repo'), /CRC|checksum|integrity/i);
  assert.equal((await f.manager.list()).length, 0);
});
