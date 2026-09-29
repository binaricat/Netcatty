/* Real desktop/SSH exercise for the Windows GitHub runner. Run after `npm run build`. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Server } = require('ssh2');
const electron = require('electron');
const { applyElectronLaunchEnv } = require('../electron/launchEnv.cjs');
const { getTempFilePath } = require('../electron/bridges/tempDirBridge.cjs');

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
      this.pending.set(id, { resolve, reject });
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
  await mainCdp.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.insertText(${JSON.stringify(value)})`);
}
async function key(mainCdp, code, type = 'keyDown') {
  await mainCdp.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({type:${JSON.stringify(type)},keyCode:${JSON.stringify(code)}})`);
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
async function activeTab(cdp, index) {
  await clickElement(cdp, '[data-tab-type="session"]', index);
  await pause(250);
}
async function broadcast(cdp, enabled) {
  await clickElement(cdp, `button[aria-label="${enabled ? 'Enable' : 'Disable'} Broadcast Mode"]`);
  await pause(150);
}

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
    client.on('close', () => clients.delete(client));
    const session = { commands: [], prompts: 0, answers: [], pending: false, ready: false };
    sessions.push(session);
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === 'fixture-login') ctx.accept();
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

async function main() {
  assert(fs.existsSync(path.join(__dirname, '..', 'dist', 'index.html')), 'Build the app first');
  const fixture = startSshFixture();
  await new Promise((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
  const sshPort = fixture.server.address().port;
  const debugPort = await freePort();
  const inspectPort = await freePort();
  const testDir = fs.mkdtempSync(`${getTempFilePath('broadcast-ssh-test')}-`);
  const output = [];
  const args = [
    '.', `--user-data-dir=${testDir}`, `--remote-debugging-port=${debugPort}`, `--inspect=${inspectPort}`,
  ];
  const app = spawn(electron, args, {
    cwd: path.join(__dirname, '..'), env: applyElectronLaunchEnv({ ...process.env, VITE_DEV_SERVER_URL: '' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [app.stdout, app.stderr]) {
    stream.on('data', (data) => { output.push(data.toString()); if (output.length > 200) output.shift(); });
  }
  let cdp;
  let mainCdp;
  const guard = setTimeout(async () => {
    console.error('Desktop SSH test exceeded its 120-second limit');
    app.kill();
    for (const client of fixture.clients) client.destroy();
    try { fixture.server.close(); } catch {}
    if (!await waitForExit(app, 2000)) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F']);
      else app.kill('SIGKILL');
      await waitForExit(app, 2000);
    }
    try { fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    process.exit(1);
  }, 120000);
  try {
    const target = await until('Electron renderer', async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      return targets.find((item) => item.type === 'page' && /index\.html/.test(item.url));
    }, 30000);
    cdp = new Devtools(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.bringToFront');
    const inspectTarget = await until('Electron main inspector', async () => {
      const response = await fetch(`http://127.0.0.1:${inspectPort}/json/list`);
      return (await response.json())[0];
    }, 15000);
    mainCdp = new Devtools(inspectTarget.webSocketDebuggerUrl);
    await mainCdp.connect();
    await mainCdp.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].focus()`);
    await until('host search field', () => cdp.eval(`Boolean(document.querySelector('input[placeholder^="Find a host"]'))`), 15000);
    await clickElement(cdp, 'input[placeholder^="Find a host"]');
    await insertText(mainCdp, `ssh -p ${sshPort} fixture@127.0.0.1`);
    await until('quick-connect address', () => cdp.eval(`document.querySelector('input[placeholder^="Find a host"]')?.value.includes('fixture@127.0.0.1')`));
    await clickText(cdp, 'Connect');
    await until('protocol step', () => cdp.eval(`document.body.innerText.includes('Choose protocol')`));
    await clickText(cdp, 'Continue');
    await until('username step', () => cdp.eval(`Boolean(document.querySelector('input[placeholder="root"]'))`));
    await clickText(cdp, 'Continue');
    await until('password step', () => cdp.eval(`Boolean(document.querySelector('input[placeholder="Enter password"]'))`));
    await clickElement(cdp, 'input[placeholder="Enter password"]');
    await insertText(mainCdp, 'fixture-login');
    await clickText(cdp, 'Continue');
    await until('host-key confirmation', () => cdp.eval(`document.body.innerText.includes('Confirm this host key')`));
    await clickText(cdp, 'Add and continue');
    await until('first connected terminal', async () => fixture.sessions.length === 1 && cdp.eval(`document.querySelectorAll('.xterm').length === 1`), 20000);
    await clickElement(cdp, '[data-tab-type="session"]', 0, 'right');
    await until('duplicate menu', () => cdp.eval(`Boolean([...document.querySelectorAll('[role="menuitem"]')].find(x=>x.textContent.trim()==='Duplicate Session'))`));
    await clickText(cdp, 'Duplicate Session', '[role="menuitem"]');
    await until('second connected terminal', async () => fixture.sessions.length === 2 && fixture.sessions.every(x => x.ready) && cdp.eval(`document.querySelectorAll('.xterm').length === 2`), 20000);
    await pause(300);
    await terminalLine(cdp, mainCdp, 'ask');
    await until('second SSH prompt', () => fixture.sessions[1].pending, 5000);
    await activeTab(cdp, 0);
    await terminalLine(cdp, mainCdp, 'ask');
    await until('both SSH prompts', () => fixture.sessions.every(x => x.pending), 5000);
    await pause(350);
    await activeTab(cdp, 1);
    await broadcast(cdp, true);
    assert.notEqual(await cdp.eval(`localStorage.getItem('netcatty_terminal_broadcast_password_bypass_v1')`), 'true');
    await terminalLine(cdp, mainCdp, 'OFFKEY');
    await until('protected keyboard answer', () => fixture.sessions[1].answers.length === 1, 5000);
    assert.deepEqual(fixture.sessions.map(x => x.answers), [[], ['OFFKEY']]);
    assert(fixture.sessions[0].pending);
    await broadcast(cdp, false);
    await terminalLine(cdp, mainCdp, 'ask');
    await until('second prompt again', () => fixture.sessions[1].pending, 5000);
    await pause(350);
    await broadcast(cdp, true);
    await clickElement(cdp, 'button[aria-label="Compose Bar"]');
    await until('compose bar', () => cdp.eval(`Boolean([...document.querySelectorAll('textarea[placeholder^="Type command here"]')].find(x=>x.getBoundingClientRect().x>=0))`));
    await composeLine(cdp, mainCdp, 'OFFCOMP');
    await until('protected compose answer', () => fixture.sessions[1].answers.length === 2, 5000);
    assert.deepEqual(fixture.sessions.map(x => x.answers), [[], ['OFFKEY', 'OFFCOMP']]);
    assert(fixture.sessions[0].pending);
    await broadcast(cdp, false);
    await terminalLine(cdp, mainCdp, 'ask');
    await until('second prompt for opt-in', () => fixture.sessions[1].pending, 5000);
    await pause(350);
    await broadcast(cdp, true);
    await clickElement(cdp, 'textarea[placeholder^="Type command here"]', 0, 'right');
    await until('password bypass menu', () => cdp.eval(`document.querySelector('[data-compose-broadcast-menu]')?.innerText.includes('Broadcast without password protection')`));
    assert(await cdp.eval(`document.querySelector('[data-compose-broadcast-menu]')?.innerText.includes('Paste')`));
    await clickElement(cdp, '[data-compose-broadcast-toggle]');
    await until('password bypass enabled', () => cdp.eval(`localStorage.getItem('netcatty_terminal_broadcast_password_bypass_v1') === 'true'`));
    await terminalLine(cdp, mainCdp, 'ONKEY');
    await until('both opt-in keyboard answers', () => fixture.sessions.every(x => x.answers.includes('ONKEY')), 5000);
    assert.deepEqual(fixture.sessions.map(x => x.answers), [['ONKEY'], ['OFFKEY', 'OFFCOMP', 'ONKEY']]);
    await broadcast(cdp, false);
    await activeTab(cdp, 0);
    await terminalLine(cdp, mainCdp, 'ask');
    await activeTab(cdp, 1);
    await composeLine(cdp, mainCdp, 'ask');
    await until('both prompts for compose opt-in', () => fixture.sessions.every(x => x.pending), 5000);
    await pause(350);
    await broadcast(cdp, true);
    await composeLine(cdp, mainCdp, 'ONCOMP');
    await until('both opt-in compose answers', () => fixture.sessions.every(x => x.answers.includes('ONCOMP')), 5000);
    assert.deepEqual(fixture.sessions.map(x => x.answers), [['ONKEY', 'ONCOMP'], ['OFFKEY', 'OFFCOMP', 'ONKEY', 'ONCOMP']]);
    assert(fixture.sessions.every(x => !x.pending && x.commands.every(command => command === 'ask')));
    await key(mainCdp, 'Up');
    await key(mainCdp, 'Up', 'keyUp');
    await until('safe compose history', () => cdp.eval(`([...document.querySelectorAll('textarea[placeholder^="Type command here"]')].find(x=>x.getBoundingClientRect().x>=0)||{}).value === 'ask'`), 5000);
    await clickElement(cdp, 'textarea[placeholder^="Type command here"]');
    await cdp.eval(`(() => {const e=${visibleComposeTextarea};e.value='';e.dispatchEvent(new Event('input',{bubbles:true}));return e.value})()`);
    await typeLine(mainCdp, 'AFTERCOMP');
    await until('ordinary compose command reaches both sessions', () => fixture.sessions.every(x => x.commands.includes('AFTERCOMP')), 5000);
    await terminalLine(cdp, mainCdp, 'AFTERKEY');
    await until('ordinary keyboard command reaches both sessions', () => fixture.sessions.every(x => x.commands.includes('AFTERKEY')), 5000);
    assert(fixture.sessions.every(x => x.commands.filter(command => command === 'AFTERCOMP').length === 1));
    assert(fixture.sessions.every(x => x.commands.filter(command => command === 'AFTERKEY').length === 1));
    await mainCdp.eval(`process.mainModule.require('electron').clipboard.writeText('CLIPCHECK')`);
    await clickElement(cdp, 'textarea[placeholder^="Type command here"]', 0, 'right');
    await until('compose text menu', () => cdp.eval(`Boolean(document.querySelector('[data-compose-broadcast-menu]'))`));
    await clickText(cdp, 'Paste', '[data-compose-broadcast-menu] button');
    await until('compose clipboard paste', () => cdp.eval(`(${visibleComposeTextarea})?.value === 'CLIPCHECK'`));
    await cdp.eval(`(${visibleComposeTextarea}).select()`);
    await clickElement(cdp, 'textarea[placeholder^="Type command here"]', 0, 'right');
    await until('compose cut menu', () => cdp.eval(`Boolean(document.querySelector('[data-compose-broadcast-menu]'))`));
    await clickText(cdp, 'Cut', '[data-compose-broadcast-menu] button');
    await until('compose clipboard cut', () => cdp.eval(`(${visibleComposeTextarea})?.value === ''`));
    assert.equal(await mainCdp.eval(`process.mainModule.require('electron').clipboard.readText()`), 'CLIPCHECK');
    console.log('PASS: two real SSH sessions, password prompts, ordinary commands, safe history, and compose clipboard menu');
  } catch (error) {
    console.error(`SSH fixture state before failure: ${JSON.stringify(fixture.sessions)}`);
    if (cdp) {
      console.error(`Compose input before failure: ${JSON.stringify(await cdp.eval(`(${visibleComposeTextarea})?.value`).catch(() => null))}`);
    }
    console.error(`Electron output before failure:\n${output.join('').slice(-4000)}`);
    throw error;
  } finally {
    clearTimeout(guard);
    cdp?.close();
    mainCdp?.close();
    if (app.exitCode === null && app.signalCode === null) {
      app.kill();
      if (!await waitForExit(app, 4000)) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F']);
        else app.kill('SIGKILL');
        await waitForExit(app, 4000);
      }
    }
    const appExited = app.exitCode !== null || app.signalCode !== null;
    for (const client of fixture.clients) client.destroy();
    const fixtureClosed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 4000);
      fixture.server.close(() => { clearTimeout(timer); resolve(true); });
    });
    fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    assert(appExited, 'Electron did not exit');
    assert(fixtureClosed, 'SSH fixture did not exit');
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
