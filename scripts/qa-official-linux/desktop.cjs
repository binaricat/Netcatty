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
const evidence = path.join(root, 'evidence');
const executable = path.join(root, 'package/opt/Netcatty/netcatty');
const report = { candidate: 'a23868ee88603d0182c5370fca851cb9d05d7f8f', launcher: 'not_run', persistence: 'not_run', sshReconnect: 'not_run', sftpPauseResume: 'not_covered', install: 'not_covered: extracted official deb; postinst never executed', sandbox: 'stock application configuration; no disabling switches or security changes' };
const logs = [];
const screenshots = new Map();
let child, cdp, mainCdp, fixture;
const profile = path.join(root, 'profile');
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
  const point = await cdp.eval(`(() => {const e=[...document.querySelectorAll('.xterm')].find(x=>x.getBoundingClientRect().x>=0);if(!e)throw new Error('No visible terminal');const r=e.getBoundingClientRect();return {x:r.x+100,y:r.y+100}})()`);
  await clickPoint(cdp, point);
  await typeLine(mainCdp, value);
}
async function composeLine(cdp, mainCdp, value) {
  await clickElement(cdp, 'textarea[placeholder^="Type command here"]');
  await typeLine(mainCdp, value);
}
const visibleComposeTextarea = `[...document.querySelectorAll('textarea[placeholder^="Type command here"]')].find(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.x>=0})`;
function startSshFixture() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const sessions = [];
  const clients = new Set();
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    const session = { commands: [], prompts: 0, answers: [], pending: false, ready: false };
    sessions.push(session);
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === loginPassword) ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const channel = accept();
        channel.on('pty', (acceptPty) => acceptPty && acceptPty());
        channel.on('shell', (acceptShell) => {
          const stream = acceptShell();
          session.ready = true;
          let line = '';
          stream.write('fixture$ ');
          stream.on('data', (buffer) => {
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
  return { server, sessions, clients };
}

async function launch() {
  const debugPort = await freePort();
  const inspectPort = await freePort();
  // Build an allowlist environment. No GitHub/Actions tokens, provider credentials,
  // development server, NODE_OPTIONS, preload overrides or no-sandbox escape hatch.
  const env = { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY, LANG: 'en_US.UTF-8',
    HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_RUNTIME_DIR: path.join(root, 'runtime'), TMPDIR: path.join(root, 'tmp') };
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
async function run() {
  assert.notEqual(process.getuid(), 0, 'QA must run as a non-root user');
  assert(fs.existsSync(executable), `Official executable missing: ${executable}`);
  fs.mkdirSync(evidence, { recursive: true });
  assert(!fs.existsSync(profile), 'QA profile must start clean');
  watchdog = setTimeout(() => { child?.kill('SIGKILL'); process.exit(1); }, 180000);
  try {
    await launch();
    await capture('01-official-launch.png');
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
    const sensitive = output.includes(loginPassword) || /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+)|Authorization:\s*Bearer\s+\S+/i.test(output);
    report.stderrReview = sensitive ? 'blocked: sensitive output; logs and screenshots withheld' : 'pass: ephemeral password, private key, GitHub credential and bearer-token checks';
    if (sensitive) process.exitCode = 1;
    else {
      fs.writeFileSync(path.join(evidence, 'electron-output.log'), output);
      console.log('Reviewed official Electron stdout/stderr:\n' + output);
      for (const [name, bytes] of screenshots) fs.writeFileSync(path.join(evidence, name), bytes);
    }
    report.coverage = 'Incremental probe: SFTP pause/progress/resume/SHA-256 remains uncovered; green means only explicitly passed assertions';
    fs.writeFileSync(path.join(evidence, 'assertions.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
