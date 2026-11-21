// Adapted from terminal-broadcast-ssh.live.cjs: packaged app, real SSH, native input.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Server } = require('ssh2');
const loginPassword = crypto.randomBytes(24).toString('hex');
const root = path.resolve(process.env.QA_ROOT);
const scenario = process.argv[2] || 'persistence';
assert(['persistence', 'ssh', 'sftp', 'host-filter'].includes(scenario));
const pinned = require(path.resolve(__dirname, process.env.QA_CANDIDATE || 'candidate.json'));
const evidence = path.join(root, 'evidence', scenario);
const executable = path.join(root, 'package/opt/Netcatty/netcatty');
const report = { candidate: pinned.sha, scenario, launcher: 'not_run', persistence: 'not_run', sshReconnect: 'not_run', sftpPauseResume: 'not_run', install: 'not_covered: extracted official deb; postinst never executed', sandbox: 'stock application configuration; no disabling switches or security changes' };
const logs = [];
const screenshots = new Map();
let child, cdp, mainCdp, fixture;
const profile = path.join(root, `profile-${scenario}`);
let watchdog;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = (ms) => Date.now() + ms;
function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, ms);
    child.once('exit', onExit);
  });
}
async function until(label, check, ms = 15000) {
  const end = deadline(ms);
  let last;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { last = error; }
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

class Devtools {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    });
  }
  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  close() { this.ws.close(); }
}

async function clickPoint(cdp, { x, y }, button = 'left') {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
}
async function clickElement(cdp, selector, index = 0, button = 'left') {
  const point = await cdp.eval(`(() => {const items=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.x>=0&&r.y>=0});const e=items[${index}];if(!e)throw new Error('Missing visible element: '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await clickPoint(cdp, point, button);
}
async function clickText(cdp, label, selector = 'button') {
  const point = await cdp.eval(`(() => {const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.textContent.trim()===${JSON.stringify(label)}&&x.getBoundingClientRect().x>=0);if(!e)throw new Error('Missing button: '+${JSON.stringify(label)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await clickPoint(cdp, point);
}
async function insertText(mainCdp, value) {
  await mainCdp.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('app://netcatty/index.html')).webContents.insertText(${JSON.stringify(value)})`);
}
async function key(mainCdp, code, type = 'keyDown') {
  await mainCdp.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('app://netcatty/index.html')).webContents.sendInputEvent({type:${JSON.stringify(type)},keyCode:${JSON.stringify(code)}})`);
}
async function typeLine(mainCdp, value) {
  for (const letter of value) await key(mainCdp, letter, 'char');
  await key(mainCdp, 'Enter');
  await key(mainCdp, 'Enter', 'keyUp');
}
async function terminalLine(cdp, mainCdp, value) {
  await mainCdp.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('app://netcatty/index.html')).focus()`);
  await until('connected terminal without overlay', () => cdp.eval(`!![...document.querySelectorAll('.xterm-helper-textarea')].find(e => e.closest('.xterm')?.getBoundingClientRect().width > 0) && !document.querySelector('[data-terminal-disconnected-dialog="true"]')`));
  const focus = await cdp.eval(`(() => { const e = [...document.querySelectorAll('.xterm-helper-textarea')].find(e => e.closest('.xterm')?.getBoundingClientRect().width > 0); e.focus(); return {focused: document.activeElement === e, tag: document.activeElement.tagName, className: document.activeElement.className}; })()`);
  assert.equal(focus.focused, true, 'Harness must focus actual xterm input');
  report.inputFocus = focus;
  await pause(350);
  await cdp.send('Input.insertText', {text: value});
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r'});
  await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13});
}
function startSshFixture() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const sessions = [];
  const clients = new Set();
  const payload = Buffer.alloc(32 * 1024 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  const sftpStats = { reads: 0, bytesSent: 0, activeReads: 0 };
  let nextReadAt = 0;
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    const session = { receivedHex: '', sent: [], commands: [], prompts: 0, answers: [], pending: false, ready: false };
    sessions.push(session);
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === loginPassword) ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const channel = accept();
        channel.on('pty', (acceptPty) => acceptPty && acceptPty());
        channel.on('sftp', acceptSftp => {
          const remote = acceptSftp();
          remote.on('error', () => {});
          const attrs = { size: payload.length, mode: 0o100644, uid: 1, gid: 1, atime: 1700000000, mtime: 1700000000 };
          remote.on('REALPATH', id => remote.name(id, [{ filename: '/', longname: '/', attrs: {...attrs, mode: 0o40755} }]));
          for (const operation of ['STAT', 'LSTAT', 'FSTAT']) remote.on(operation, id => remote.attrs(id, attrs));
          remote.on('OPEN', id => remote.handle(id, Buffer.from('qa-source')));
          remote.on('CLOSE', id => remote.status(id, 0));
          remote.on('READ', (id, _handle, position, length) => {
            sftpStats.reads++; sftpStats.activeReads++;
            const due = Math.max(Date.now(), nextReadAt); nextReadAt = due + 20;
            setTimeout(() => {
              sftpStats.activeReads--;
              if (remote.destroyed) return;
              if (position >= payload.length) remote.status(id, 1);
              else { const bytes = payload.subarray(position, Math.min(payload.length, position + length)); remote.data(id, bytes); sftpStats.bytesSent += bytes.length; }
            }, due - Date.now());
          });
        });
        channel.on('shell', (acceptShell) => {
          const stream = acceptShell();
          session.ready = true;
          stream.on('error', () => {});
          let line = '';
          stream.write('fixture$ ');
          stream.on('data', (buffer) => {
            session.receivedHex = (session.receivedHex + buffer.toString('hex')).slice(-8192);
            for (const char of buffer.toString('utf8')) {
              if (char === '\r' || char === '\n') {
                if (!line && char === '\n') continue;
                const submitted = line;
                line = '';
                if (session.pending) {
                  session.answers.push(submitted);
                  session.pending = false;
                  stream.write('\r\naccepted\r\nfixture$ ');
                } else if (submitted === 'ask') {
                  session.commands.push(submitted);
                  session.prompts += 1;
                  session.pending = true;
                  stream.write('\r\nPassword:');
                } else if (submitted) {
                  session.commands.push(submitted);
                  session.sent.push(`ran: ${submitted}`);
                  stream.write(`\r\nran: ${submitted}\r\nfixture$ `);
                }
              } else if (char === '\x7f') line = line.slice(0, -1);
              else line += char;
            }
          });
        });
      });
    });
  });
  return { server, sessions, clients, sftpStats, payload };
}

async function launch() {
  const debugPort = await freePort();
  const inspectPort = await freePort();
  // Build an allowlist environment. No GitHub/Actions tokens, provider credentials,
  // development server, NODE_OPTIONS, preload overrides or no-sandbox escape hatch.
  const env = { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY, LANG: 'en_US.UTF-8',
    HOME: path.join(root, scenario, 'home'), XDG_CONFIG_HOME: path.join(root, scenario, 'config'),
    XDG_CACHE_HOME: path.join(root, scenario, 'cache'), XDG_DATA_HOME: path.join(root, scenario, 'data'),
    XDG_RUNTIME_DIR: path.join(root, scenario, 'runtime'), TMPDIR: path.join(root, scenario, 'tmp') };
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR']) fs.mkdirSync(env[key], { recursive: true, mode: 0o700 });
  child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`, `--inspect=127.0.0.1:${inspectPort}`], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => logs.push(`launcher: ${error.message}\n`));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    logs.push(bytes.toString());
    if (logs.reduce((n, item) => n + item.length, 0) > 2_000_000) child.kill('SIGTERM');
  });
  const target = await until('official packaged renderer (stock sandbox required)', async () => {
    assert.equal(child.exitCode, null, `Official Electron exited ${child.exitCode}; inspect stderr`);
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    return targets.find(item => item.type === 'page' && /index\.html/.test(item.url));
  }, 30000);
  const rendererUrl = new URL(target.url);
  assert.equal(rendererUrl.protocol, 'app:', 'Official production renderer protocol');
  assert.equal(rendererUrl.host, 'netcatty');
  assert.equal(rendererUrl.pathname, '/index.html');
  cdp = new Devtools(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.bringToFront');
  const inspector = await until('official Electron main inspector', async () => (await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json())[0]);
  mainCdp = new Devtools(inspector.webSocketDebuggerUrl);
  await mainCdp.connect();
  report.rendererTarget = { id: target.id, url: target.url };
  await until('production renderer DOM loaded', () => cdp.eval(`Boolean(document.querySelector('input[placeholder^="Find a host"]'))`));
  report.nativeWindows = await mainCdp.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().map(w => ({id: w.id, url: w.webContents.getURL()}))`);
  await until('native production window URL committed', () => mainCdp.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().some(w => w.webContents.getURL().startsWith('app://netcatty/index.html'))`));
  const runtime = await mainCdp.eval(`(() => { const { app, BrowserWindow } = process.mainModule.require('electron'); const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('app://netcatty/index.html')); win.focus(); return { packaged: app.isPackaged, appPath: app.getAppPath(), profile: app.getPath('userData'), argv: process.argv, uid: process.getuid(), electron: process.versions.electron, rendererPreferences: { sandbox: win.webContents.getLastWebPreferences().sandbox, contextIsolation: win.webContents.getLastWebPreferences().contextIsolation, nodeIntegration: win.webContents.getLastWebPreferences().nodeIntegration } }; })()`);
  assert.equal(runtime.packaged, true);
  assert(runtime.appPath.endsWith('/resources/app.asar'));
  assert.equal(runtime.profile, profile);
  assert.notEqual(runtime.uid, 0);
  assert(!runtime.argv.some(arg => /no-sandbox|disable.*sandbox/.test(arg)));
  assert.equal(runtime.rendererPreferences.contextIsolation, true);
  assert.equal(runtime.rendererPreferences.nodeIntegration, false);
  // Report the stock app's sandbox:false renderer preference honestly. Do not
  // rewrite its preferences or call this a full renderer-sandbox verification.
  report.runtime = runtime;
  report.launcher = 'pass';
  await until('real vault UI', () => cdp.eval(`Boolean(document.querySelector('input[placeholder^="Find a host"]'))`));
}
async function capture(name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const bytes = Buffer.from(result.data, 'base64');
  assert(bytes.length > 10000, 'Screenshot must contain a real application window');
  screenshots.set(name, bytes);
}
async function assertEcho(expected) {
  // xterm renders to canvas. Read its actual selection through the production
  // Select All / Copy menu and native clipboard, not document.body.innerText.
  async function menu(label) {
    await clickElement(cdp, '.xterm', 0, 'right');
    const point = await until(`terminal menu ${label}`, () => cdp.eval(`(() => { const e = [...document.querySelectorAll('[role="menuitem"]')].find(e => e.textContent.trim().startsWith(${JSON.stringify(label)})); if (!e) return null; const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`));
    await clickPoint(cdp, point);
  }
  await pause(500);
  await menu('Select All');
  await menu('Copy');
  const text = await mainCdp.eval(`process.mainModule.require('electron').clipboard.readText()`);
  assert(text.includes(expected), 'Expected server echo absent from real xterm buffer');
  await key(mainCdp, 'Escape'); await key(mainCdp, 'Escape', 'keyUp');
}
async function quit() {
  if (mainCdp) await mainCdp.eval(`process.mainModule.require('electron').app.quit()`).catch(() => {});
  if (child && !await waitForExit(child, 5000)) {
    child.kill('SIGTERM');
    if (!await waitForExit(child, 3000)) { child.kill('SIGKILL'); await waitForExit(child, 2000); }
  }
  cdp?.close(); mainCdp?.close(); cdp = mainCdp = undefined;
}
async function verifySftp() {
  report.sftpPauseResume = 'incomplete';
  const sessionId = await cdp.eval(`document.querySelector('[data-tab-type="session"]').getAttribute('data-tab-id')`);
  const sftpId = await cdp.eval(`window.netcatty.openSftpForSession(${JSON.stringify(sessionId)}, {reuseExactSessionOnly: true})`);
  assert(sftpId, 'Real packaged app must open SFTP on the SSH transport');
  const transferId = `qa-${crypto.randomUUID()}`;
  const targetPath = path.join(root, `download-${scenario}.bin`);
  const expectedSha256 = crypto.createHash('sha256').update(fixture.payload).digest('hex');
  const options = { transferId, sourcePath: '/qa-payload.bin', targetPath, sourceType: 'sftp', targetType: 'local', sourceSftpId: sftpId, totalBytes: fixture.payload.length, resumable: true };
  await cdp.eval(`(() => { window.__qaTransfer = {events: [], done: false}; window.netcatty.onGlobalSftpTransferEvent(e => { if (e.transferId === ${JSON.stringify(transferId)}) window.__qaTransfer.events.push(e); }); window.netcatty.startStreamTransfer(${JSON.stringify(options)}).then(result => { window.__qaTransfer.result = result; window.__qaTransfer.done = true; }, error => { window.__qaTransfer.error = String(error); window.__qaTransfer.done = true; }); return true; })()`);
  const progress = () => cdp.eval(`Math.max(0, ...window.__qaTransfer.events.map(e => e.transferred || 0))`);
  await until('real SFTP bytes and native progress', async () => fixture.sftpStats.bytesSent > 262144 && await progress() > 131072, 30000);
  await clickElement(cdp, 'button[aria-label="File Transfers"]');
  await pause(200);
  await capture('03-sftp-transferring.png');
  const paused = await cdp.eval(`window.netcatty.pauseTransfer(${JSON.stringify(transferId)})`);
  assert.equal(paused.success, true, paused.reason);
  await until('native paused lifecycle event', () => cdp.eval(`window.__qaTransfer.events.some(e => e.type === 'paused')`));
  await until('server outstanding reads drained', () => fixture.sftpStats.activeReads === 0, 10000);
  const samples = [];
  for (let i = 0; i < 5; i++) {
    samples.push({ at: Date.now(), serverBytes: fixture.sftpStats.bytesSent, progressBytes: await progress() });
    await pause(500);
  }
  assert(samples[0].serverBytes > 0 && samples[0].serverBytes < fixture.payload.length, 'Pause must happen mid-transfer');
  assert(samples.every(s => s.serverBytes === samples[0].serverBytes), 'Actual SFTP server bytes changed while paused');
  assert(samples.every(s => s.progressBytes === samples[0].progressBytes), 'Native progress changed while paused');
  await capture('04-sftp-paused.png');
  const resumed = await cdp.eval(`window.netcatty.resumeTransfer(${JSON.stringify(transferId)})`);
  assert.equal(resumed.success, true, resumed.reason);
  await until('server and progress resume', async () => fixture.sftpStats.bytesSent > samples[0].serverBytes && await progress() > samples[0].progressBytes, 15000);
  await capture('05-sftp-resumed.png');
  await until('native transfer completes', () => cdp.eval(`window.__qaTransfer.done`), 90000);
  const result = await cdp.eval(`window.__qaTransfer.result`);
  assert(result && !result.error && !result.cancelled, JSON.stringify(result));
  const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
  assert.equal(fs.statSync(targetPath).size, fixture.payload.length);
  assert.equal(actualSha256, expectedSha256);
  report.sftpPauseResume = 'pass';
  report.sftp = { invocation: 'production preload API -> packaged native transfer runtime, actual loopback SSH2 SFTP; no substituted bridge', transferId, bytes: fixture.payload.length, paused, resumed, pauseSamples: samples, finalServer: fixture.sftpStats, expectedSha256, actualSha256, events: await cdp.eval(`window.__qaTransfer.events`) };
  await capture('06-sftp-completed.png');
}
async function run() {
  assert.notEqual(process.getuid(), 0, 'QA must run as a non-root user');
  assert(fs.existsSync(executable), `Official executable missing: ${executable}`);
  fs.mkdirSync(evidence, { recursive: true });
  assert(!fs.existsSync(profile), 'QA profile must start clean');
  watchdog = setTimeout(() => { child?.kill('SIGKILL'); process.exit(1); }, 180000);
  try {
    await launch();
    await capture('01-official-launch.png');
    if (scenario === 'persistence') {
    const seed = { id: 'qa-persisted-host', label: 'QA persisted loopback host', hostname: '127.0.0.1', username: 'fixture', port: 22222, protocol: 'ssh', tags: ['qa-only'], os: 'linux' };
    // Seed synthetic pre-existing data through real Chromium storage. The
    // acceptance check is a full process restart and visible real vault data.
    await cdp.eval(`localStorage.setItem('netcatty_hosts_v1', ${JSON.stringify(JSON.stringify([seed]))})`);
    await cdp.send('Page.reload');
    await until('seeded host visible before quit', () => cdp.eval(`document.body.innerText.includes('QA persisted loopback host')`));
    await capture('02-seeded-data.png');
    await quit();
    await launch();
    await until('same profile data visible after restart', () => cdp.eval(`document.body.innerText.includes('QA persisted loopback host')`));
    assert.equal(await cdp.eval(`JSON.parse(localStorage.getItem('netcatty_hosts_v1'))[0].id`), seed.id);
    report.persistence = 'pass: synthetic saved host visible before and after graceful quit/relaunch of same isolated profile';
    await capture('03-persisted-after-restart.png');

    return;
    }
    if (scenario === 'host-filter') { await verifyHostFilters(); return; }
    fixture = startSshFixture();
    await new Promise((resolve, reject) => { fixture.server.once('error', reject); fixture.server.listen(0, '127.0.0.1', resolve); });
    const sshPort = fixture.server.address().port;
    await clickElement(cdp, 'input[placeholder^="Find a host"]');
    await insertText(mainCdp, `ssh -p ${sshPort} fixture@127.0.0.1`);
    await clickText(cdp, 'Connect');
    await until('protocol wizard', () => cdp.eval(`document.body.innerText.includes('Choose protocol')`));
    await clickText(cdp, 'Continue');
    await until('username wizard', () => cdp.eval(`Boolean(document.querySelector('input[placeholder="root"]'))`));
    await clickText(cdp, 'Continue');
    await until('password wizard', () => cdp.eval(`Boolean(document.querySelector('input[placeholder="Enter password"]'))`));
    await clickElement(cdp, 'input[placeholder="Enter password"]');
    await insertText(mainCdp, loginPassword);
    await clickText(cdp, 'Continue');
    await until('real host-key confirmation', () => cdp.eval(`document.body.innerText.includes('Confirm this host key')`));
    await clickText(cdp, 'Add and continue');
    await until('first real SSH shell', () => fixture.sessions.filter(s => s.ready).length === 1);
    await pause(700);
    await capture('02-connected-shell.png');
    if (scenario === 'sftp') { await verifySftp(); return; }
    report.sshReconnect = 'incomplete';
    await terminalLine(cdp, mainCdp, 'QA_BEFORE_DISCONNECT');
    await until('first server received command', () => fixture.sessions.some(s => s.commands.includes('QA_BEFORE_DISCONNECT')));
    await assertEcho('ran: QA_BEFORE_DISCONNECT');
    const originalTabs = await cdp.eval(`[...document.querySelectorAll('[data-tab-type="session"]')].map(e => e.getAttribute('data-tab-id'))`);
    assert.equal(originalTabs.length, 1);
    assert(originalTabs[0], 'Stable original tab ID required');
    for (const client of fixture.clients) client.destroy();
    await until('disconnect overlay', () => cdp.eval(`Boolean(document.querySelector('[data-terminal-disconnected-dialog="true"]'))`));
    await capture('04-real-ssh-disconnected.png');
    await key(mainCdp, 'Enter'); await key(mainCdp, 'Enter', 'keyUp');
    await until('second real SSH shell', () => fixture.sessions.filter(s => s.ready).length === 2, 20000);
    await terminalLine(cdp, mainCdp, 'QA_AFTER_RECONNECT');
    await until('second server received command', () => fixture.sessions.filter(s => s.ready)[1].commands.includes('QA_AFTER_RECONNECT'));
    await assertEcho('ran: QA_AFTER_RECONNECT');
    assert.deepEqual(await cdp.eval(`[...document.querySelectorAll('[data-tab-type="session"]')].map(e => e.getAttribute('data-tab-id'))`), originalTabs);
    report.sshReconnect = 'pass';
    report.ssh = { transport: 'SSH2 over loopback TCP; server destroys connection before UI Enter reconnect', shellConnections: fixture.sessions.filter(s => s.ready).length, originalTabs, commands: fixture.sessions.filter(s => s.ready).map(s => s.commands.filter(command => command.startsWith('QA_'))) };
    await capture('05-real-ssh-reconnected.png');
  } catch (error) {
    report.failure = error.message;
    report.failureCategory = 'Unresolved assertion; use focus and server receive diagnostics before assigning a product regression';
    if (fixture) report.sshDiagnostics = fixture.sessions.map(({ready, receivedHex, commands, sent}) => ({ready, receivedHex, commands, sent}));
    if (report.launcher === 'not_run') report.launcher = 'fail';
    await capture('failure-real-application.png').catch(() => {});
    process.exitCode = 1;
  } finally {
    await quit();
    if (fixture) {
      for (const client of fixture.clients) client.destroy();
      await new Promise(resolve => fixture.server.close(resolve));
    }
    clearTimeout(watchdog);
    const output = logs.join('');
    const publicText = output + JSON.stringify(report);
    const sensitive = publicText.includes(loginPassword) || /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+)|Authorization:\s*Bearer\s+\S+/i.test(publicText);
    report.stderrReview = sensitive ? 'blocked: sensitive output; logs and screenshots withheld' : 'pass: ephemeral password, private key, GitHub credential and bearer-token checks';
    if (sensitive) { process.exitCode = 1; delete report.failure; delete report.sshDiagnostics; }
    else {
      fs.writeFileSync(path.join(evidence, 'electron-output.log'), output);
      console.log('Reviewed official Electron stdout/stderr:\n' + output);
      for (const [name, bytes] of screenshots) fs.writeFileSync(path.join(evidence, name), bytes);
    }
    report.coverage = 'Independent scenario: only this report and candidate SHA count; other scenario reports must be evaluated separately';
    fs.writeFileSync(path.join(evidence, 'assertions.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
