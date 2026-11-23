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
  const locale = process.env.NC_GITHUB_LOCALE || 'en';
  assert.ok(['en', 'zh-CN', 'zh-TW'].includes(locale));
  const labels = {
    en: { plugins: 'Plugins', browse: 'Browse', install: 'Install from GitHub', repository: 'GitHub repository', confirm: 'Install disabled', back: 'Back', invalid: 'repository only', noRelease: 'no published stable release', expired: 'preview expired', ask: 'Ask', trust: 'I trust this repository', review: 'No build scripts run' },
    'zh-CN': { plugins: '插件', browse: '浏览', install: '从 GitHub 安装', repository: 'GitHub 仓库', confirm: '安装并保持禁用', back: '返回', invalid: '请只填写仓库地址', noRelease: '尚未发布稳定版本', expired: '预览已失效', ask: '询问', trust: '已审查并信任此仓库', review: '安装过程不会运行构建脚本' },
    'zh-TW': { plugins: '外掛程式', browse: '瀏覽', install: '從 GitHub 安裝', repository: 'GitHub 儲存庫', confirm: '安裝並保持停用', back: '返回', invalid: '請只填寫儲存庫位址', noRelease: '尚未發布穩定版本', expired: '預覽已失效', ask: '詢問', trust: '已審查並信任此儲存庫', review: '安裝過程不會執行建置腳本' },
  }[locale];
  const repository = 'netcatty-smoke/starter-plugin';
  const rejectedRepository = 'netcatty-smoke/rejected-plugin';
  const tag = 'v0.1.3';
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    await new Promise(resolve => setTimeout(resolve, 300)); // Make the real busy state visible.
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/repos/netcatty-smoke/no-release') return send(200, { full_name: 'netcatty-smoke/no-release', private: false });
    if (req.url === '/repos/netcatty-smoke/no-release/releases/latest') return send(404, { message: 'No release' });
    for (const selected of [repository, rejectedRepository, 'owner/repo']) {
      if (req.url === `/repos/${selected}`) return send(200, { full_name: selected, private: false });
      if (req.url === `/repos/${selected}/releases/latest`) return send(200, { tag_name: tag, draft: false, prerelease: false, assets: [{ id: 123, state: 'uploaded', name: 'starter.ncpkg', size: bytes.length, digest, browser_download_url: `https://github.com/${selected}/releases/download/${tag}/starter.ncpkg` }] });
      if (req.url === `/repos/${selected}/commits/${tag}`) return send(200, { sha: 'a'.repeat(40) });
      if (req.url === `/${selected}/releases/download/${tag}/starter.ncpkg`) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length }); res.end(bytes); return; }
    }
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
    const rendererErrors = [];
    sw.on('pageerror', error => rendererErrors.push(String(error)));
    sw.on('console', message => { if (message.type() === 'error') log(`GitHub settings console: ${message.text()}`); });
    await sw.waitForLoadState('domcontentloaded');
    // Use the actual Settings language selector and its existing persisted state.
    if (locale !== 'en') {
      await sw.getByRole('tab', { name: 'Appearance', exact: true }).click();
      const language = sw.locator('[data-settings-anchor="appearance-language"] button[role="combobox"]');
      await language.click();
      await sw.getByRole('option', { name: locale === 'zh-CN' ? '简体中文' : '繁體中文', exact: true }).click();
    }
    await sw.waitForFunction(expected => document.documentElement.lang === expected, locale);
    await sw.getByRole('tab', { name: labels.plugins, exact: true }).click();
    await sw.getByRole('button', { name: labels.browse, exact: true }).click();
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
    await sw.getByRole('button', { name: labels.install, exact: true }).click();
    const dialog = sw.locator('[data-plugin-github-install]');
    const input = dialog.getByRole('textbox', { name: labels.repository });
    await input.fill('https://evil.example/owner/repo');
    await input.press('Enter');
    await dialog.getByRole('alert').filter({ hasText: labels.invalid }).waitFor();
    assert.equal(requests.length, 0);
    await shot('github-invalid-input');
    await input.fill('github.com/netcatty-smoke/no-release');
    await input.press('Enter');
    await dialog.getByRole('alert').filter({ hasText: labels.noRelease }).waitFor();
    await shot('github-no-release');
    const trustChecks = [];
    const inputFormats = [];
    for (const [index, value] of ['https://github.com/owner/repo', 'github.com/owner/repo', 'owner/repo'].entries()) {
      await input.fill(value);
      await shot(`github-format-${index + 1}-input`);
      const requestStart = requests.length;
      await input.press('Enter');
      const reviewed = dialog.locator('[data-plugin-github-preview]');
      await reviewed.waitFor({ timeout: 30000 });
      assert.ok((await reviewed.innerText()).includes('https://github.com/owner/repo'));
      assert.ok((await reviewed.innerText()).includes(labels.review));
      await dialog.getByText(labels.trust, { exact: false }).waitFor();
      assert.equal(await dialog.getByRole('checkbox').isChecked(), false);
      assert.equal(await dialog.getByRole('button', { name: labels.confirm, exact: true }).isDisabled(), true);
      assert.deepEqual(requests.slice(requestStart), ['/repos/owner/repo', '/repos/owner/repo/releases/latest', `/repos/owner/repo/commits/${tag}`, `/owner/repo/releases/download/${tag}/starter.ncpkg`]);
      inputFormats.push({ input: value, canonicalOrigin: 'https://github.com/owner/repo', realPreview: true, requests: requests.slice(requestStart), unchecked: true, installDisabled: true });
      await shot(`github-format-${index + 1}-preview`);
      await dialog.getByRole('button', { name: labels.back, exact: true }).click();
      await reviewed.waitFor({ state: 'hidden' });
    }
    for (const attempt of ['first', 'same-package-retry']) {
      await input.fill(rejectedRepository);
      await input.press('Enter');
      await dialog.locator('[data-plugin-github-preview]').waitFor({ timeout: 30000 });
      const confirm = dialog.getByRole('button', { name: labels.confirm, exact: true });
      const checkbox = dialog.getByRole('checkbox');
      assert.equal(await checkbox.isChecked(), false);
      assert.equal(await confirm.isDisabled(), true);
      trustChecks.push({ attempt, checked: false, installDisabled: true });
      await checkbox.check();
      // Use the real host cleanup path to invalidate the downloaded preview,
      // just as expiry does. Never replace install IPC or fake its response.
      await sw.evaluate(() => window.netcatty.discardGitHubPlugin());
      await confirm.click();
      await dialog.getByRole('alert').filter({ hasText: labels.expired }).waitFor();
      assert.equal(await dialog.locator('[data-plugin-github-preview]').count(), 0);
      assert.deepEqual(await sw.evaluate(() => window.netcatty.listPlugins()), []);
      await shot(`github-rejected-${attempt}`);
      log(`GitHub real host rejection after download: ${attempt}; no installed package`);
    }
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
    const confirm = dialog.getByRole('button', { name: labels.confirm, exact: true });
    assert.equal(await confirm.isDisabled(), true);
    assert.equal(await dialog.getByRole('checkbox').isChecked(), false);
    trustChecks.push({ attempt: 'different-repository', checked: false, installDisabled: true });
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
    const displayName = installed[0].manifest.displayName;
    const pluginName = typeof displayName === 'string' ? displayName : displayName?.[locale] ?? displayName?.en ?? installed[0].manifest.name;
    await sw.getByRole('button', { name: pluginName, exact: true }).click();
    await sw.locator('[data-host-security-surface]').waitFor();
    const modes = sw.locator('[data-host-security-surface]').getByRole('combobox');
    await modes.first().waitFor();
    await modes.first().click();
    await sw.getByRole('option', { name: labels.ask, exact: true }).click();
    await sw.getByRole('combobox').filter({ hasText: labels.ask }).waitFor();
    await modes.first().scrollIntoViewIfNeeded();
    await shot('github-installed-permission-mode');
    await sw.keyboard.press('Escape');
    await sw.getByRole('button', { name: labels.browse, exact: true }).waitFor();
    await sw.getByRole('button', { name: labels.browse, exact: true }).click();
    await sw.getByRole('button', { name: pluginName, exact: true }).click();
    await sw.locator('[data-host-security-surface]').getByRole('combobox').filter({ hasText: labels.ask }).waitFor();
    assert.match(await sw.locator('[data-plugin-detail]').innerText(), /https:\/\/github.com\/netcatty-smoke\/starter-plugin/);
    await shot('github-reopened-source');
    await sw.waitForTimeout(1000);
    log(`GitHub install smoke PASS: ${requests.length} controlled HTTP requests; validated actual starter .ncpkg; no plugin enabled`);
    assert.deepEqual(rendererErrors, []);
    await fs.writeFile(path.join(OUT, 'github-fixture-evidence.json'), JSON.stringify({ locale, inputFormats, fixture: repository, controlledLoopback: true, requests, sha256: digest.slice(7), trustChecks, realPreviewRejections: 2, rendererErrors, installed, videoErrors: videoErrors.slice(-3) }, null, 2));
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
