// Real, verified installed app GUI + real loopback SSH2; no component fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const vm = require('node:vm');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const { Server } = require('ssh2');
const pinned = require('./candidate.json');
const arch = process.env.QA_ARCH, root = path.resolve(process.env.QA_ROOT);
const evidence = path.join(root, 'evidence'), profile = path.join(root, 'profile');
const executable = path.join(root, 'Applications/Netcatty.app/Contents/MacOS/Netcatty');
const loginPassword = crypto.randomBytes(24).toString('hex');
const token = `QA_MAC_${arch}_${crypto.randomUUID().replaceAll('-', '')}`;
const commandText = `printf ${token}`;
const acknowledgement = `QA_MAC_ACK:${token}`;
const report = { candidate: pinned.sha, arch, qaHead: process.env.QA_HEAD_SHA, runner: process.env.QA_RUNNER, firstLaunch: 'not_run', ssh: 'not_run', screenshots: [], fixtureEvents: [], scope: 'First real native GUI launch of the copied official signed/notarized APP, then actual SSH2 loopback shell roundtrip. Not Finder quarantine, LAN, updater, personal-device or final-merged-revision coverage.', security: 'Stock Electron and OS protections. No sandbox/Gatekeeper/quarantine/SIP or privacy-permission changes.' };
const logs = [], images = new Map(), clients = new Set();
let app, browser, page, inspector, server, watchdog, finishing;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function stage(name) { report.stage = name; console.log(`QA_MAC_STAGE ${name}`); }
async function until(label, check, timeout = 20000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (error) { if (error instanceof SyntaxError) throw error; last = error; }
    await sleep(150);
  }
  throw new Error(`Timed out: ${label}${last ? `: ${last.message}` : ''}`);
}
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
function environment() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', '__CF_USER_TEXT_ENCODING', 'XPC_FLAGS', 'XPC_SERVICE_NAME', 'COMMAND_MODE']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' });
  // Preserve the ephemeral VM's normal OS home/bootstrap and temporary paths.
  // Only app userData is isolated; never substitute/disable the OS keychain.
  report.environment = { home: env.HOME, tmpdir: env.TMPDIR, isolatedAppProfile: profile, inheritedKeys: Object.keys(env) };
  return env;
}
class Inspector {
  constructor(url) {
    this.ws = new WebSocket(url); this.next = 0; this.pending = new Map();
    this.ws.addEventListener('message', event => { const m = JSON.parse(event.data), item = this.pending.get(m.id); if (!item) return; this.pending.delete(m.id); m.error ? item.reject(new Error(m.error.message)) : item.resolve(m.result); });
  }
  async connect() { await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }); }); }
  async eval(expression) {
    if (typeof expression === 'function') expression = `(${expression.toString()})()`;
    new vm.Script(expression);
    const id = ++this.next;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Native inspector timeout')); }, 12000);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  close() { this.ws.close(); }
}
function keepImage(name, bytes) {
  assert(bytes.length > 10000, 'Capture must contain an actual rendered application');
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  images.set(name, bytes);
  report.screenshots.push({ name, bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), source: 'Actual installed native renderer capture' });
}
async function capture(name) {
  if (page && !page.isClosed()) keepImage(`${arch}-${name}.png`, await page.screenshot({ timeout: 10000 }));
  else if (inspector) {
    const encoded = await inspector.eval(async () => {
      const e = process.mainModule.require('electron');
      const w = e.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('app://netcatty/index.html'));
      return w ? (await w.webContents.capturePage()).toPNG().toString('base64') : null;
    });
    if (encoded) keepImage(`${arch}-${name}.png`, Buffer.from(encoded, 'base64'));
  }
}
function event(kind, detail = {}) { report.fixtureEvents.push({ at: new Date().toISOString(), kind, ...detail }); }
async function startSsh() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  server = new Server({ hostKeys: [privateKey] }, client => {
    clients.add(client); const connection = report.fixtureEvents.filter(e => e.kind === 'tcp').length + 1;
    event('tcp', { connection, remoteAddress: client._sock?.remoteAddress });
    client.on('error', error => event('transport_error', { connection, message: error.message }));
    client.on('close', () => { clients.delete(client); event('closed', { connection }); });
    client.on('authentication', ctx => { if (ctx.method === 'password' && ctx.username === 'fixture' && ctx.password === loginPassword) { event('authentication_accepted', { connection, method: ctx.method }); ctx.accept(); } else ctx.reject(['password']); });
    client.on('ready', () => {
      event('ready', { connection });
      client.on('session', accept => {
        const session = accept();
        session.on('pty', acceptPty => { event('pty', { connection }); acceptPty?.(); });
        session.on('window-change', acceptChange => acceptChange?.());
        session.on('shell', acceptShell => {
          const stream = acceptShell(); let line = '';
          event('shell', { connection }); stream.write('Synthetic Netcatty QA loopback SSH\r\nfixture$ ');
          stream.on('data', data => {
            for (const char of data.toString()) {
              if (char === '\r' || char === '\n') {
                const submitted = line; line = '';
                if (!submitted) continue;
                event('command_received', { connection, command: submitted });
                if (submitted === commandText) { stream.write(`\r\n${acknowledgement}\r\nfixture$ `); event('acknowledgement_sent', { connection, text: acknowledgement }); }
              } else if (char === '\x7f') line = line.slice(0, -1);
              else line += char;
            }
          });
        });
      });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  report.service = { implementation: 'ssh2 real encrypted loopback server with a controlled synthetic shell', address: server.address(), command: commandText, acknowledgement, generatedCredential: 'ephemeral random password, never logged or uploaded' };
  assert.equal(server.address().address, '127.0.0.1');
  return server.address().port;
}
async function launch() {
  stage('launch verified installed app executable');
  const debugPort = await freePort(), inspectPort = await freePort();
  app = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`, `--inspect=127.0.0.1:${inspectPort}`], { cwd: path.dirname(executable), env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
  app.on('error', error => logs.push(error.stack));
  for (const name of ['stdout', 'stderr']) app[name].on('data', b => logs.push(`[${name}] ${b}`));
  const target = await until('stock signed app native debugger', async () => {
    assert.equal(app.exitCode, null, 'Actual app exited; read real stderr');
    return (await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`, { signal: AbortSignal.timeout(1000) })).json())[0];
  }, 45000);
  inspector = new Inspector(target.webSocketDebuggerUrl); await inspector.connect();
  report.nativeInspectorPreflight = await inspector.eval('({pid:process.pid, platform:process.platform, arch:process.arch})');
  stage('native inspector connected; await real GUI');
  await until('actual native renderer DOM ready', () => inspector.eval(async () => {
    const e = process.mainModule.require('electron'), w = e.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('app://netcatty/index.html'));
    return !!w && !w.webContents.isLoadingMainFrame() && await w.webContents.executeJavaScript("!!document.querySelector('input[placeholder^=\"Find a host\"]')");
  }), 45000);
  report.native = await inspector.eval(() => {
    const e = process.mainModule.require('electron'), w = e.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('app://netcatty/index.html'));
    w.setSize(1440, 1000); w.show(); w.focus();
    return { pid: process.pid, platform: process.platform, arch: process.arch, uid: process.getuid(), version: e.app.getVersion(), packaged: e.app.isPackaged, appPath: e.app.getAppPath(), executable: process.execPath, profile: e.app.getPath('userData'), origin: w.webContents.getURL(), electron: process.versions.electron, argv: process.argv, preferences: w.webContents.getLastWebPreferences(), noSandbox: e.app.commandLine.hasSwitch('no-sandbox'), disableSetuidSandbox: e.app.commandLine.hasSwitch('disable-setuid-sandbox') };
  });
  const n = report.native;
  assert.equal(n.arch, arch); assert.equal(n.platform, 'darwin'); assert.notEqual(n.uid, 0); assert.equal(n.version, pinned.version); assert.equal(n.packaged, true);
  assert.equal(n.executable, executable); assert.equal(n.profile, profile); assert(n.appPath.endsWith('/Netcatty.app/Contents/Resources/app.asar'));
  assert.equal(n.noSandbox, false); assert.equal(n.disableSetuidSandbox, false); assert.equal(n.preferences.contextIsolation, true); assert.equal(n.preferences.nodeIntegration, false); assert.equal(n.preferences.webSecurity, true);
  report.sandboxScope = `Unmodified stock renderer sandbox:${n.preferences.sandbox}; this is not full renderer-sandbox certification`;
  await capture('00-native-launch');
  stage('native GUI identity and initial capture verified');
  for (const port of [debugPort, inspectPort]) {
    const output = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 10000 });
    assert(!/\*:|0\.0\.0\.0:|\[::\]:/.test(output), 'Debugger must not listen publicly'); assert(/127\.0\.0\.1:|\[::1\]:/.test(output));
    (report.debuggerListeners ||= []).push({ port, output });
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 30000 }); browser.contexts()[0].setDefaultTimeout(12000);
  page = await until('actual installed app page', () => browser.contexts()[0].pages().find(p => p.url().startsWith('app://netcatty/index.html') && !p.url().includes('settings')));
  await page.getByPlaceholder(/^Find a host/).waitFor();
  report.firstLaunch = 'passed: actual installed official native GUI, fresh synthetic profile, stock protections';
  await capture('01-first-launch');
  stage('first GUI launch passed');
}
async function ssh(port) {
  stage('normal GUI quick-connect to owned loopback SSH');
  report.ssh = 'incomplete';
  await page.getByPlaceholder(/^Find a host/).fill(`ssh -p ${port} fixture@127.0.0.1`);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByText('Choose protocol', { exact: false }).first().waitFor();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('root', { exact: true }).fill('fixture');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Enter password', { exact: true }).fill(loginPassword);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByText('Confirm this host key', { exact: false }).first().waitFor();
  await page.getByRole('button', { name: 'Add and continue', exact: true }).click();
  await until('actual authenticated SSH shell', () => report.fixtureEvents.some(e => e.kind === 'shell'));
  stage('real authenticated SSH shell accepted by fixture');
  await until('actual xterm input mounted', () => page.evaluate(() => [...document.querySelectorAll('.xterm-helper-textarea')].some(e => e.closest('.xterm')?.getBoundingClientRect().width > 0)));
  await capture('02-real-ssh-connected');
  report.inputFocus = await page.evaluate(() => { const e = [...document.querySelectorAll('.xterm-helper-textarea')].find(e => e.closest('.xterm')?.getBoundingClientRect().width > 0); e.focus(); return { focused: document.activeElement === e, tag: document.activeElement.tagName }; });
  assert.equal(report.inputFocus.focused, true);
  await page.keyboard.insertText(commandText); await page.keyboard.press('Enter');
  await until('server received unique harmless command', () => report.fixtureEvents.some(e => e.kind === 'command_received' && e.command === commandText));
  assert(report.fixtureEvents.some(e => e.kind === 'acknowledgement_sent' && e.text === acknowledgement));
  const tabId = await page.locator('[data-tab-type="session"]').first().getAttribute('data-tab-id'); assert(tabId);
  const params = { sessionId: tabId, scopedSessionIds: [tabId], range: 'tail', maxLines: 80 };
  await until('server acknowledgement in actual production terminal reader', async () => {
    const result = await inspector.eval(`process.mainModule.require(process.mainModule.require('electron').app.getAppPath() + '/electron/bridges/mcpServerBridge.cjs').dispatchBuiltinRpc('netcatty/readContext', ${JSON.stringify(params)})`);
    report.terminalRead = result;
    return result.ok === true && result.content.includes(acknowledgement);
  });
  report.ssh = 'passed: encrypted SSH authentication + PTY/shell, server unique-command receipt, explicit server acknowledgement in production live terminal buffer';
  report.tabId = tabId; await sleep(150); await capture('03-real-ssh-roundtrip');
  stage('real SSH roundtrip passed');
}
async function quit() {
  if (inspector) {
    try { if (app?.exitCode === null && app?.signalCode === null) await inspector.eval("setImmediate(() => process.mainModule.require('electron').app.quit()); true"); }
    finally { inspector.close(); inspector = null; }
  }
  if (!app || app.exitCode !== null || app.signalCode !== null) return;
  const exited = await new Promise(resolve => { const timer = setTimeout(() => resolve(false), 10000); app.once('exit', () => { clearTimeout(timer); resolve(true); }); });
  if (!exited && app.exitCode === null && app.signalCode === null) {
    report.cleanupWarning = 'Normal quit exceeded 10 seconds; terminate only the owned ephemeral QA app'; app.kill('SIGTERM'); await sleep(1500);
    if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL');
  }
}
function save() {
  const output = logs.join('');
  const publicText = output + JSON.stringify(report);
  const sensitive = publicText.includes(loginPassword) || /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:gh[opsur]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})|Authorization:\s*Bearer\s+\S+/i.test(publicText);
  report.stderrReview = sensitive ? 'blocked: sensitive data; logs and images withheld' : 'passed: ephemeral password, private key, GitHub credential and bearer-header checks';
  if (sensitive) { process.exitCode = 1; report.error = 'Sensitive-data review failed'; }
  else { fs.writeFileSync(path.join(evidence, 'application-output.log'), output); for (const [name, bytes] of images) fs.writeFileSync(path.join(evidence, name), bytes); }
  fs.writeFileSync(path.join(evidence, 'assertions.json'), JSON.stringify(report, null, 2));
}
async function finish() {
  if (finishing) return finishing;
  finishing = (async () => {
    clearTimeout(watchdog);
    if (report.error) { try { await capture('failure-native-application'); } catch {} if (page) try { report.failureVisibleUI = await page.locator('body').innerText({ timeout: 3000 }); } catch {} }
    save(); // Preserve actual assertions before cleanup.
    for (const client of clients) client.end();
    if (server) { server.close(); await sleep(200); }
    try { await quit(); } catch (error) { report.cleanupWarning = error.message; app?.kill('SIGTERM'); }
    for (const client of clients) client._sock?.destroy(); // Owned fixture teardown only, after SSH assertions.
    if (browser) await Promise.race([browser.close().catch(() => {}), sleep(2000)]);
    report.applicationExit = app && { pid: app.pid, code: app.exitCode, signal: app.signalCode };
    save();
    if (report.stderrReview.startsWith('passed')) console.log('Reviewed actual application output:\n' + logs.join(''));
    await new Promise(resolve => process.stdout.write(JSON.stringify(report, null, 2) + '\n', resolve));
  })();
  return finishing;
}
async function main() {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, arch); assert.notEqual(process.getuid(), 0); assert(!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN);
  assert.equal(JSON.parse(fs.readFileSync(path.join(evidence, 'verification.json'))).status, 'passed', 'No launch around a failed OS assessment');
  assert(!fs.existsSync(profile), 'First launch must use a fresh QA profile'); fs.mkdirSync(evidence, { recursive: true });
  watchdog = setTimeout(() => { report.error = 'Native scenario exceeded 240 seconds'; process.exitCode = 1; finish().finally(() => process.exit(1)); }, 240000);
  const port = await startSsh(); await launch(); await ssh(port);
}
main().catch(error => { report.error = error.stack; process.exitCode = 1; }).then(async () => {
  await finish(); process.exit(process.exitCode || 0); // Do not let stale automation transports keep a finished QA step alive.
}).catch(error => { console.error(error.stack); process.exit(1); });
