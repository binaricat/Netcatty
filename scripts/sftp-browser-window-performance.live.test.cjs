"use strict";
/* global process, __dirname, console, setTimeout, clearTimeout */
// Run with Electron. NETCATTY_SFTP_WINDOW_BASELINE=1 loads the list/tree virtualization sources from Git
// with NETCATTY_SFTP_WINDOW_BASELINE_REF=<unfixed commit> for the red control.
// All fixture inputs stay identical; no implicit HEAD baseline changes after commit.
if (!process.versions.electron) {
  require('node:test')('large SFTP browser windows stay bounded', { skip: 'run with Electron for native layout and input' }, () => {});
} else {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { app, BrowserWindow } = require('electron');
  const temp = require('../electron/bridges/tempDirBridge.cjs');
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(`${temp.getTempFilePath('sftp-window-performance')}-`);
  const artifacts = fs.mkdtempSync(`${temp.getTempFilePath('sftp-window-results')}-`);
  app.setPath('userData', profile);
  app.on('window-all-closed', () => {});
  let window, vite;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const run = code => window.webContents.executeJavaScript(code).catch(error => { throw new Error(`${error.message}\nWhile executing: ${code}`); });
  async function until(code, label) {
    for (let i = 0; i < 200; i++) { if (await run(code)) return; await wait(25); }
    throw new Error(label);
  }
  async function click(selector, double = false) {
    app.focus({ steal: true }); window.focus(); window.webContents.focus();
    const point = await run(`(() => {const e=document.querySelector(${JSON.stringify(selector)});const r=e?.getBoundingClientRect();return r&&{x:Math.round(r.x+Math.min(150,r.width/2)),y:Math.round(r.y+r.height/2)}})()`);
    assert.ok(point, `click target ${selector}`);
    assert.ok(point.y > 0 && point.y < 800, 'row is inside the viewport');
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    await wait(20);
    for (const clickCount of double ? [1, 2] : [1]) {
      for (const type of ['mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, button: 'left', clickCount, ...point });
    }
    await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  }
  async function hideRestoreSelectedLast() {
    await click('#visibility'); await wait(100);
    await click('#visibility'); await wait(100);
    await until(`(() => {const e=document.querySelector('[data-entry-name="file-004999.txt"]');const r=e?.getBoundingClientRect();return e?.dataset.selected==='true'&&r.height>0&&r.top>=-1&&r.bottom<=innerHeight+1})()`, 'last selected row remains visible after hide/restore');
  }
  async function scrollToEnd(selector) {
    const point = await run(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    // Chromium caps each injected wheel to approximately one viewport. Repeat
    // native wheel inputs instead of treating a huge delta as a jump-to-end.
    for (let i = 0; i < 450; i++) {
      const done = await run(`(() => {const e=document.querySelector(${JSON.stringify(selector)});return e.scrollTop+e.clientHeight>=e.scrollHeight-1})()`);
      if (done) { await wait(50); return; }
      window.webContents.sendInputEvent({ type: 'mouseWheel', deltaX: 0, deltaY: -1000000, canScroll: true, ...point });
      await wait(5);
    }
    throw new Error('native wheel did not reach the end');
  }
  const cleanup = async code => { window?.destroy(); await vite?.close(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(code); };
  const watchdog = setTimeout(() => { console.error('SFTP_WINDOW_TIMEOUT'); void cleanup(1); }, 120000);
  void app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    const baseline = process.env.NETCATTY_SFTP_WINDOW_BASELINE === '1';
    const baselineRef = process.env.NETCATTY_SFTP_WINDOW_BASELINE_REF;
    if (baseline) assert.ok(baselineRef, 'baseline control requires NETCATTY_SFTP_WINDOW_BASELINE_REF=<unfixed commit>');
    const paths = ['components/sftp/hooks/useSftpPaneVirtualList.ts', 'components/sftp/useSftpPaneTreeRows.tsx', 'components/sftp/SftpPaneTreeView.tsx'];
    const originals = new Map(baseline ? paths.map(file => [path.join(root, file), execFileSync('git', ['show', `${baselineRef}:${file}`], { cwd: root, encoding: 'utf8' })]) : []);
    const tailwind = (await import('@tailwindcss/vite')).default;
    vite = await createServer({ configFile: false, root, cacheDir: path.join(profile, 'vite-cache'), resolve: { alias: { '@': root } }, optimizeDeps: { entries: ['scripts/fixtures/sftp-browser-window-performance.tsx'] }, logLevel: 'error', clearScreen: false, server: { host: '127.0.0.1', port: 5379, strictPort: true, hmr: false }, plugins: [tailwind(), { name: 'sftp-window-audit', enforce: 'pre',
      load(id) { return originals.get(id.split('?')[0]); },
      configureServer(server) { server.middlewares.use('/__sftp_window_fixture', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html><head><meta charset="utf-8"><title>SFTP Window Performance Fixture</title><link rel="stylesheet" href="/index.css"><style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}</style></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/sftp-browser-window-performance.tsx"></script></body></html>');
      }); },
    }] });
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    window = new BrowserWindow({ show: true, width: 1280, height: 800, title: 'SFTP Window Performance Fixture', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    const errors = [];
    window.webContents.on('console-message', event => { if (event.level === 'error' || event.level >= 3) errors.push(event.message); });
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(origin) && !details.url.startsWith('data:') }));
    await window.loadURL(`${origin}/__sftp_window_fixture`);
    await until('window.sftpWindowAudit && document.querySelector("[data-sftp-row]")', 'list mounts');
    await wait(120);
    assert.equal(await run('Math.round(document.querySelector("[data-sftp-row]").getBoundingClientRect().height)'), 44, 'real comfortable-row CSS loaded');
    await click('#visibility'); await wait(60);
    await click('#visibility'); await wait(60);
    await scrollToEnd('[data-section=terminal-sftp-list]');
    await until(`!!document.querySelector('[data-entry-name="file-004999.txt"]')`, 'list scroll reaches final file');
    await click('[data-entry-name="file-004999.txt"]');
    await until(`document.querySelector('[data-entry-name="file-004999.txt"]')?.dataset.selected==="true"`, 'last file selection');
    await click('[data-entry-name="file-004999.txt"]', true);
    await until('sftpWindowAudit.opened.includes("file-004999.txt")', 'last file double-click opens');
    await click('#density'); await wait(100);
    assert.equal(await run('document.querySelector("[data-sftp-row]").dataset.sftpListDensity'), 'compact');
    assert.equal(await run('Math.round(document.querySelector("[data-sftp-row]").getBoundingClientRect().height)'), 24, 'real compact-row CSS loaded');
    await scrollToEnd('[data-section=terminal-sftp-list]');
    await until(`!!document.querySelector('[data-entry-name="file-004999.txt"]')`, 'compact list reaches final file');
    await click('#density'); await wait(100);
    await hideRestoreSelectedLast();
    await click('#view'); await wait(100);
    await click('[data-section="terminal-sftp-tree-row"][data-entry-name="folder"]', true);
    await until(`sftpWindowAudit.loads.includes("/fixture/folder") && !!document.querySelector('[data-entry-name="nested-child.txt"]')`, 'directory expands using fixture child loader');
    await click('[data-entry-name="nested-child.txt"]', true);
    await until('sftpWindowAudit.opened.includes("nested-child.txt")', 'expanded tree child opens');
    await click('#visibility'); await wait(100);
    await click('#visibility'); await wait(100);
    await run(`document.querySelector('[data-section="terminal-sftp-tree-row"]').closest('.overflow-y-auto').id='tree-scroll-fixture'`);
    await scrollToEnd('#tree-scroll-fixture');
    await until(`!!document.querySelector('[data-entry-name="file-004999.txt"]')`, 'tree scroll reaches final file');
    await click('[data-entry-name="file-004999.txt"]');
    await until(`document.querySelector('[data-entry-name="file-004999.txt"]')?.dataset.selected==="true"`, 'tree last file selection');
    await hideRestoreSelectedLast();
    const result = await run('sftpWindowAudit');
    result.baseline = baseline;
    result.baselineRef = baseline ? baselineRef : null;
    result.maxRows = Math.max(...result.commits.map(commit => commit.rows));
    const screenshot = await window.webContents.capturePage();
    result.additional = [];
    for (const scenario of [{ query: '?count=20', small: true }, { query: '?hidden=1' }, { query: '?hidden=1&tree=1' }]) {
      await window.loadURL(`${origin}/__sftp_window_fixture${scenario.query}`);
      await until('!!window.sftpWindowAudit', 'additional scenario mounts');
      await wait(100);
      await click('#visibility'); await wait(80);
      await click('#visibility'); await wait(80);
      const sample = await run('sftpWindowAudit');
      result.additional.push({ query: scenario.query, ...sample });
      if (scenario.small) assert.ok(sample.commits.every(commit => commit.rows === 22), 'small directory retains all rows');
      else assert.ok(await run('document.querySelector("#pane").style.display==="none"'), 'initially hidden pane survives restore and rehide');
    }
    // Parked panes may receive a smaller refresh while their scroll handlers
    // cannot publish the browser-clamped position. Keep every commit nonempty.
    result.shrinkWhileHidden = [];
    for (const scenario of [
      { view: 'list', query: '?shrink=1', before: 'file-004999.txt', after: 'file-000099.txt', height: 44 },
      { view: 'tree', query: '?count=100&tree=1&shrink=1', before: 'file-000099.txt', after: 'file-000059.txt', height: 28 },
    ]) {
      await window.loadURL(`${origin}/__sftp_window_fixture${scenario.query}`);
      await until('!!window.sftpWindowAudit', 'shrink scenario mounts');
      await wait(100);
      await scrollToEnd('#pane .overflow-y-auto');
      await until(`!!document.querySelector('[data-entry-name="${scenario.before}"]')`, 'shrink scenario starts at the final page');
      await click('#visibility'); await wait(100);
      await click('#shrink'); await wait(100);
      await click('#visibility'); await wait(100);
      const shrink = await run(`(() => {
        const container=document.querySelector('#pane .overflow-y-auto');
        const viewport=container.getBoundingClientRect();
        const rows=[...container.querySelectorAll('[data-sftp-row],[data-section="terminal-sftp-tree-row"]')].map(element=>({name:element.dataset.entryName,top:element.getBoundingClientRect().top,bottom:element.getBoundingClientRect().bottom,height:element.getBoundingClientRect().height}));
        return {scrollTop:container.scrollTop,scrollHeight:container.scrollHeight,clientHeight:container.clientHeight,viewport:viewport.toJSON(),rows,audit:sftpWindowAudit};
      })()`);
      result.shrinkWhileHidden.push({ view: scenario.view, ...shrink });
      console.log('SFTP_WINDOW_SHRINK_RESULT', JSON.stringify({ view: scenario.view, ...shrink }));
      fs.writeFileSync(path.join(artifacts, `shrink-${scenario.view}.json`), JSON.stringify(shrink, null, 2));
      fs.writeFileSync(path.join(artifacts, `shrink-${scenario.view}.png`), (await window.webContents.capturePage()).toPNG());
      assert.ok(shrink.rows.length > 0 && shrink.rows.length <= 100, 'restored smaller listing has a bounded nonempty row window without another scroll');
      const last = shrink.rows.find(row => row.name === scenario.after);
      assert.ok(last && last.top >= shrink.viewport.top - 1 && last.bottom <= shrink.viewport.bottom + 1, 'the browser-clamped final page shows its last file');
      const visible = shrink.rows.filter(row => row.bottom > shrink.viewport.top && row.top < shrink.viewport.bottom);
      assert.ok(visible.length > 0, 'restored rows intersect the actual viewport');
      for (const row of shrink.rows) {
        const index = row.name === '..' ? 0 : row.name === 'folder' ? 1 : Number(row.name.slice(5, 11)) + 2;
        assert.ok(Math.abs(row.top - (shrink.viewport.top + index * scenario.height - shrink.scrollTop)) <= 1, 'row positions match the real clamped scroll offset');
      }
    }
    assert.ok(result.shrinkWhileHidden.every(sample => sample.audit.commits.filter(commit => commit.phase.endsWith(':shrink-hidden') || commit.phase.endsWith(':restore')).every(commit => commit.rows > 0 && commit.rows <= 100)), 'hidden refresh and first restore commit keep bounded nonempty list/tree row windows');
    console.log('SFTP_WINDOW_PERFORMANCE_RESULT', JSON.stringify(result));
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(artifacts, 'window.png'), screenshot.toPNG());
    console.log('SFTP_WINDOW_ARTIFACTS', artifacts);
    assert.deepEqual(errors, [], 'no renderer errors');
    for (const phase of ['list:first', 'list:hide', 'list:restore', 'tree:first', 'tree:hide', 'tree:restore']) assert.ok(result.commits.some(commit => commit.phase === phase), `recorded ${phase}`);
    assert.ok([result, ...result.additional.filter(sample => !sample.query.includes('count=20'))].every(sample => sample.commits.every(commit => commit.rows <= 100)), `SFTP_FILE_WINDOW_UNBOUNDED: max ${result.maxRows} mounted rows`);
    console.log('SFTP_WINDOW_PERFORMANCE_OK');
  }).catch(async error => { process.exitCode = 1; console.error(error); if(window && !window.isDestroyed()) console.error('SFTP_WINDOW_FAILURE_STATE', await run(`(() => {const e=document.querySelector('[data-entry-name="file-004999.txt"]');const r=e?.getBoundingClientRect();const sc=document.querySelector('#tree-scroll-fixture');return {selected:e?.dataset.selected,rect:r?.toJSON(),innerHeight,scroll:sc&&{top:sc.scrollTop,height:sc.clientHeight,max:sc.scrollHeight},rows:document.querySelectorAll('[data-sftp-row],[data-section="terminal-sftp-tree-row"]').length}})()`)); if(window && !window.isDestroyed()) fs.writeFileSync(path.join(artifacts, 'failure.png'), (await window.webContents.capturePage()).toPNG()); console.error('SFTP_WINDOW_ARTIFACTS', artifacts); process.exitCode = 1; }).finally(async () => {
    clearTimeout(watchdog); await cleanup(process.exitCode || 0);
  });
}
