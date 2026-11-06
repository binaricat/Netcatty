// NC_EXTRA for the existing real Electron smoke harness. No product test switch.
// Uses the actual starter .ncpkg and a host-only transport injection to a loopback fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { buildPluginPackage } from '../packages/plugin-cli/dist/index.js';

export default async function githubInstallSmoke({ app, win, log, OUT }) {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const archive = path.join(OUT, 'starter-fixture.ncpkg');
  await buildPluginPackage(path.join(repoRoot, 'examples/plugins/starter-netcatty'), archive);
  const bytes = await fs.readFile(archive);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const repository = 'netcatty-smoke/starter-plugin';
  const tag = 'v0.1.3';
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    await new Promise(resolve => setTimeout(resolve, 300)); // Make the real busy state visible.
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/repos/netcatty-smoke/no-release') return send(200, { full_name: 'netcatty-smoke/no-release', private: false });
    if (req.url === '/repos/netcatty-smoke/no-release/releases/latest') return send(404, { message: 'No release' });
    if (req.url === `/repos/${repository}`) return send(200, { full_name: repository, private: false });
    if (req.url === `/repos/${repository}/releases/latest`) return send(200, { tag_name: tag, draft: false, prerelease: false, assets: [{ id: 123, state: 'uploaded', name: 'starter.ncpkg', size: bytes.length, digest, browser_download_url: `https://github.com/${repository}/releases/download/${tag}/starter.ncpkg` }] });
    if (req.url === `/repos/${repository}/commits/${tag}`) return send(200, { sha: 'a'.repeat(40) });
    if (req.url === `/${repository}/releases/download/${tag}/starter.ncpkg`) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length }); res.end(bytes); return; }
    send(404, { message: 'Unknown controlled fixture path' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
  let video;
  let sw;
  try {
    // Trusted main-process automation changes only the network boundary. The UI,
    // parser, resolver, validation, preview tokens, IPC and installation remain real.
    await app.evaluate((_, origin) => {
      const original = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = new URL(String(input));
        if (['api.github.com', 'github.com'].includes(url.hostname)) return original(`${origin}${url.pathname}`, init);
        return original(input, init);
      };
    }, fixtureOrigin);
    const windowPromise = app.waitForEvent('window');
    await win.evaluate(() => window.netcatty.openSettingsWindow());
    sw = await windowPromise;
    await sw.waitForLoadState('domcontentloaded');
    await sw.getByRole('tab', { name: 'Plugins', exact: true }).click();
    await sw.getByRole('button', { name: 'Browse', exact: true }).click();
    const shot = async name => {
      await sw.screenshot({ path: path.join(OUT, `${name}.png`) });
      log(`GitHub screenshot ${name}`);
      await sw.waitForTimeout(900);
    };
    video = spawn('ffmpeg', ['-y', '-f', 'x11grab', '-video_size', '1440x900', '-framerate', '15', '-i', process.env.DISPLAY, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(OUT, 'github-install.mp4')], { stdio: ['ignore', 'ignore', 'pipe'] });
    const videoErrors = [];
    video.stderr.on('data', data => videoErrors.push(String(data)));
    video.on('error', error => videoErrors.push(String(error)));
    await shot('github-manager');
    await sw.getByRole('button', { name: 'Install from GitHub', exact: true }).click();
    const dialog = sw.locator('[data-plugin-github-install]');
    const input = dialog.getByRole('textbox', { name: 'GitHub repository' });
    await input.fill('https://evil.example/owner/repo');
    await input.press('Enter');
    await dialog.getByRole('alert').filter({ hasText: 'repository only' }).waitFor();
    assert.equal(requests.length, 0);
    await shot('github-invalid-input');
    await input.fill('github.com/netcatty-smoke/no-release');
    await input.press('Enter');
    await dialog.getByRole('alert').filter({ hasText: 'no published stable release' }).waitFor();
    await shot('github-no-release');
    await input.fill('https://github.com/netcatty-smoke/starter-plugin.git/');
    await shot('github-input');
    await input.press('Enter');
    await dialog.getByRole('status').waitFor();
    await shot('github-downloading');
    const preview = dialog.locator('[data-plugin-github-preview]');
    await preview.waitFor({ timeout: 30000 });
    assert.match(await preview.innerText(), /https:\/\/github.com\/netcatty-smoke\/starter-plugin/);
    assert.match(await preview.innerText(), /v0\.1\.3/);
    assert.match(await preview.innerText(), /SHA-256/);
    const confirm = dialog.getByRole('button', { name: 'Install disabled', exact: true });
    assert.equal(await confirm.isDisabled(), true);
    await shot('github-review-permissions');
    await confirm.scrollIntoViewIfNeeded();
    await shot('github-permission-confirmation');
    await dialog.getByRole('checkbox').check();
    await confirm.click();
    await dialog.waitFor({ state: 'hidden' });
    const installed = await sw.evaluate(() => window.netcatty.listPlugins());
    assert.equal(installed.length, 1);
    assert.equal(installed[0].enabled, false);
    assert.equal(installed[0].source.origin, `https://github.com/${repository}`);
    assert.equal(installed[0].archiveSha256, digest.slice(7));
    await shot('github-installed');
    await sw.getByRole('button', { name: 'Plugin Starter', exact: true }).click();
    await sw.locator('[data-host-security-surface]').waitFor();
    const modes = sw.locator('[data-host-security-surface]').getByRole('combobox');
    await modes.first().waitFor();
    await modes.first().click();
    await sw.getByRole('option', { name: 'Ask', exact: true }).click();
    await sw.getByRole('combobox').filter({ hasText: 'Ask' }).waitFor();
    await modes.first().scrollIntoViewIfNeeded();
    await shot('github-installed-permission-mode');
    await sw.keyboard.press('Escape');
    await sw.getByRole('button', { name: 'Browse', exact: true }).waitFor();
    await sw.getByRole('button', { name: 'Browse', exact: true }).click();
    await sw.getByRole('button', { name: 'Plugin Starter', exact: true }).click();
    await sw.locator('[data-host-security-surface]').getByRole('combobox').filter({ hasText: 'Ask' }).waitFor();
    assert.match(await sw.locator('[data-plugin-detail]').innerText(), /https:\/\/github.com\/netcatty-smoke\/starter-plugin/);
    await shot('github-reopened-source');
    await sw.waitForTimeout(1000);
    log(`GitHub install smoke PASS: ${requests.length} controlled HTTP requests; validated actual starter .ncpkg; no plugin enabled`);
    await fs.writeFile(path.join(OUT, 'github-fixture-evidence.json'), JSON.stringify({ fixture: repository, controlledLoopback: true, requests, sha256: digest.slice(7), installed, videoErrors: videoErrors.slice(-3) }, null, 2));
    return true;
  } catch (error) {
    if (sw) {
      await sw.screenshot({ path: path.join(OUT, 'github-failure.png') }).catch(() => {});
      await fs.writeFile(path.join(OUT, 'github-failure-dom.txt'), await sw.locator('body').innerText().catch(() => 'unavailable'));
    }
    throw error;
  } finally {
    if (video && video.exitCode === null) { const stopped = new Promise(resolve => video.once('exit', resolve)); video.kill('SIGINT'); await stopped; }
    await new Promise(resolve => server.close(resolve));
  }
}
