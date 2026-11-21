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
assert(['persistence', 'ssh', 'sftp', 'host-filter', 'clipboard'].includes(scenario));
const pinned = require(path.resolve(__dirname, process.env.QA_CANDIDATE || 'candidate.json'));
const evidence = path.join(root, 'evidence', scenario);
const executable = path.join(root, 'package/opt/Netcatty/netcatty');
const report = { candidate: pinned.sha, scenario, launcher: 'not_run', persistence: 'not_run', sshReconnect: 'not_run', sftpPauseResume: 'not_run', install: 'not_covered: extracted official deb; postinst never executed', sandbox: 'stock application configuration; no disabling switches or security changes' };
const logs = [];
const screenshots = new Map();
let videoChild;
const videoPath = path.join(root, 'sftp-pause-resume.mp4');
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
  send(method, params = {}, timeoutMs = 10000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, timeoutMs = 10000) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
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
  const protocol = {channels: [], opens: [], reads: [], closes: []};
  let nextChannel = 0, nextHandle = 0, nextRead = 0;
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    const session = { receivedHex: '', sent: [], commands: [], prompts: 0, answers: [], pending: false, ready: false };
    sessions.push(session);
    client.on('close', () => { session.closedAt = Date.now(); });
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
          const channelId = ++nextChannel;
          protocol.channels.push({id: channelId, openedAt: Date.now()});
          const handles = new Map();
          remote.on('error', () => {});
          const attrs = { size: payload.length, mode: 0o100644, uid: 1, gid: 1, atime: 1700000000, mtime: 1700000000 };
          remote.on('REALPATH', id => remote.name(id, [{ filename: '/', longname: '/', attrs: {...attrs, mode: 0o40755} }]));
          for (const operation of ['STAT', 'LSTAT', 'FSTAT']) remote.on(operation, id => remote.attrs(id, attrs));
          remote.on('OPEN', (id, filePath, flags) => {
            const handle = `qa-handle-${++nextHandle}`;
            const info = {handle, channelId, path: String(filePath), flags, openedAt: Date.now()};
            handles.set(handle, info); protocol.opens.push(info);
            remote.handle(id, Buffer.from(handle));
          });
          remote.on('CLOSE', (id, handleBytes) => {
            const handle = handleBytes.toString();
            const info = handles.get(handle); if (info) info.closedAt = Date.now();
            protocol.closes.push({handle, channelId, at: Date.now()});
            remote.status(id, 0);
          });
          remote.on('READ', (id, handleBytes, position, length) => {
            const handle = handleBytes.toString();
            const request = {sequence: ++nextRead, channelId, handle, path: handles.get(handle)?.path, offset: position, length, logicalRangeStart: Math.floor(position / 32768) * 32768, receivedAt: Date.now()};
            protocol.reads.push(request);
            sftpStats.reads++; sftpStats.activeReads++;
            const due = Math.max(Date.now(), nextReadAt); nextReadAt = due + 20;
            setTimeout(() => {
              sftpStats.activeReads--;
              if (remote.destroyed) { request.droppedAt = Date.now(); return; }
              request.repliedAt = Date.now();
              if (position >= payload.length) { request.replyBytes = 0; remote.status(id, 1); }
              else { const bytes = payload.subarray(position, Math.min(payload.length, position + length)); request.replyBytes = bytes.length; remote.data(id, bytes); sftpStats.bytesSent += bytes.length; }
            }, due - Date.now());
          });
        });
        channel.on('shell', (acceptShell) => {
          const stream = acceptShell();
          session.ready = true; session.readyAt = Date.now();
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
  return { server, sessions, clients, sftpStats, payload, protocol };
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
  const sessionId = await cdp.eval(`document.querySelector('[data-tab-type="session"]').getAttribute('data-tab-id')`);
  const params = {sessionId, scopedSessionIds: [sessionId], range: 'tail', maxLines: 80};
  await until('server echo in production xterm reader', async () => {
    const result = await mainCdp.eval(`process.mainModule.require(process.mainModule.require('electron').app.getAppPath() + '/electron/bridges/mcpServerBridge.cjs').dispatchBuiltinRpc('netcatty/readContext', ${JSON.stringify(params)})`);
    report.terminalRead = result;
    return result.ok === true && result.content.includes(expected);
  }, 10000);
}
function disconnectFixtureClients(transportLoss = false) {
  for (const client of fixture?.clients || []) {
    // ssh2 Server.Connection exposes end(), not Client.destroy(). A socket
    // destruction here is an actual transport loss, not a renderer status edit.
    if (transportLoss) client._sock?.destroy();
    else client.end();
  }
}
async function quit() {
  if (mainCdp) await mainCdp.eval(`process.mainModule.require('electron').app.quit()`).catch(() => {});
  if (child && !await waitForExit(child, 5000)) {
    child.kill('SIGTERM');
    if (!await waitForExit(child, 3000)) { child.kill('SIGKILL'); await waitForExit(child, 2000); }
  }
  cdp?.close(); mainCdp?.close(); cdp = mainCdp = undefined;
}
function observeLocalStage(stagePath, checkpointBytes) {
  const stats = fs.statSync(stagePath);
  const actual = fs.readFileSync(stagePath);
  const prefix = actual.subarray(0, checkpointBytes);
  const committedPrefixSha256 = crypto.createHash('sha256').update(prefix).digest('hex');
  const expectedPrefix = crypto.createHash('sha256').update(fixture.payload.subarray(0, checkpointBytes)).digest('hex');
  return {logicalSize: stats.size, allocatedBytes: stats.blocks * 512, committedBytesRead: prefix.length, committedPrefixSha256, committedPrefixMatchesPayload: prefix.length === checkpointBytes && committedPrefixSha256 === expectedPrefix, fullStageSha256: crypto.createHash('sha256').update(actual).digest('hex')};
}
function startPauseRecording() {
  report.recording = {path: 'sftp-pause-resume.mp4', startedAt: Date.now(), source: 'actual isolated Xvfb display; 5 fps; no generated frames'};
  videoChild = spawn('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', '1440x1000', '-framerate', '5', '-i', process.env.DISPLAY, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-t', '120', videoPath], {env: {PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY}, stdio: ['ignore', 'ignore', 'pipe']});
  videoChild.on('error', error => { report.recording.error = error.message; });
  videoChild.stderr.on('data', bytes => logs.push('Recording: ' + bytes.toString()));
}
async function stopPauseRecording() {
  if (!videoChild) return;
  if (videoChild.exitCode === null && videoChild.signalCode === null) { videoChild.kill('SIGINT'); if (!await waitForExit(videoChild, 3000)) videoChild.kill('SIGKILL'); }
  report.recording.endedAt = Date.now();
  report.recording.exitCode = videoChild.exitCode;
  videoChild = undefined;
}
async function verifySftp() {
  report.sftpPauseResume = 'incomplete';
  const sessionId = await cdp.eval(`document.querySelector('[data-tab-type="session"]').getAttribute('data-tab-id')`);
  report.stage = 'SFTP open on existing production SSH session';
  const sftpId = await cdp.eval(`window.netcatty.openSftpForSession(${JSON.stringify(sessionId)}, {reuseExactSessionOnly: true})`);
  assert(sftpId, 'Real packaged app must open SFTP on the SSH transport');
  const transferId = `qa-${crypto.randomUUID()}`;
  const targetPath = path.join(root, `download-${scenario}.bin`);
  const expectedSha256 = crypto.createHash('sha256').update(fixture.payload).digest('hex');
  const stagePath = await mainCdp.eval(`process.mainModule.require(process.mainModule.require('electron').app.getAppPath() + '/electron/bridges/tempDirBridge.cjs').getTransferTempFilePath(${JSON.stringify(transferId)}, ${JSON.stringify(path.basename(targetPath))})`);
  report.sftpStagePath = stagePath;
  const options = { transferId, sourcePath: '/qa-payload.bin', targetPath, sourceType: 'sftp', targetType: 'local', sourceSftpId: sftpId, totalBytes: fixture.payload.length, resumable: true };
  await cdp.eval(`(() => { window.__qaTransfer = {events: [], done: false}; window.netcatty.onGlobalSftpTransferEvent(e => { if (e.transferId === ${JSON.stringify(transferId)}) window.__qaTransfer.events.push({...e, qaObservedAt: Date.now()}); }); window.netcatty.startStreamTransfer(${JSON.stringify(options)}).then(result => { window.__qaTransfer.result = result; window.__qaTransfer.done = true; }, error => { window.__qaTransfer.error = String(error); window.__qaTransfer.done = true; }); return true; })()`);
  const progress = () => cdp.eval(`window.__qaTransfer.events.filter(e => typeof e.transferred === 'number').at(-1)?.transferred || 0`);
  report.stage = 'SFTP bytes and native progress';
  await until('real SFTP bytes and native progress', async () => fixture.sftpStats.bytesSent > 262144 && await progress() > 131072, 30000);
  await clickElement(cdp, 'button[aria-label="File Transfers"]');
  await pause(200);
  await capture('03-sftp-transferring.png');
  const sharedChannel = fixture.protocol.channels[0].id;
  const isolated = fixture.protocol.opens.filter(open => open.channelId !== sharedChannel && !open.closedAt && open.path === '/qa-payload.bin');
  assert.equal(isolated.length, 1, 'Harness must identify one active isolated download handle');
  const transferHandle = isolated[0].handle;
  report.sftpHandleClassification = {sharedVerificationChannel: sharedChannel, isolatedDownload: {...isolated[0]}, basis: 'official concurrent-isolated download uses an isolated subsystem; fingerprint ranges use the shared browse subsystem; inspect sftp-protocol.json for every OPEN/READ/CLOSE'};
  report.stage = 'SFTP pause';
  const paused = await cdp.eval(`window.netcatty.pauseTransfer(${JSON.stringify(transferId)})`);
  const pauseAcknowledgedAt = Date.now();
  assert.equal(paused.success, true, paused.reason);
  await until('native paused lifecycle event', () => cdp.eval(`window.__qaTransfer.events.some(e => e.type === 'paused')`));
  report.sftpControl = {transferId, pauseAcknowledgedAt, paused};
  const allowedRanges = new Set(fixture.protocol.reads.filter(read => read.handle === transferHandle && read.receivedAt <= pauseAcknowledgedAt).map(read => read.logicalRangeStart));
  report.sftpControl.alreadyStartedDownloadRanges = [...allowedRanges].sort((a,b) => a-b);
  report.sftpControl.inFlightDownloadReadsAtAcknowledgement = fixture.protocol.reads.filter(read => read.handle === transferHandle && read.receivedAt <= pauseAcknowledgedAt && (!read.repliedAt || read.repliedAt > pauseAcknowledgedAt)).map(read => read.sequence);
  report.sftpPauseDrain = {startedAt: Date.now(), initial: {...fixture.sftpStats}, samples: []};
  // A transient zero in-flight count is not quiescence: the production runtime
  // may start checkpoint fingerprint reads asynchronously after acknowledging
  // pause. Keep the complete settling timeline and require sustained stability.
  let stable = [];
  await until('sustained actual SFTP bytes and native progress stop', async () => {
    const native = await cdp.eval(`({done: window.__qaTransfer.done, completed: window.__qaTransfer.events.some(e => e.type === 'completed'), checkpoint: window.__qaTransfer.events.filter(e => typeof e.checkpointBytes === 'number').at(-1)?.checkpointBytes})`);
    assert.equal(native.done, false, 'Transfer resolved before explicit resume');
    assert.equal(native.completed, false, 'Transfer completed before explicit resume');
    const checkpointBytes = native.checkpoint ?? paused.checkpointBytes ?? 0;
    const sample = {at: Date.now(), serverBytes: fixture.sftpStats.bytesSent, activeReads: fixture.sftpStats.activeReads, progressBytes: await progress(), checkpointBytes, done: native.done, local: observeLocalStage(stagePath, checkpointBytes)};
    report.sftpPauseDrain.samples.push(sample);
    const previous = stable.at(-1);
    if (previous && (previous.serverBytes !== sample.serverBytes || previous.progressBytes !== sample.progressBytes || previous.checkpointBytes !== sample.checkpointBytes || previous.local.fullStageSha256 !== sample.local.fullStageSha256 || sample.activeReads !== 0)) stable = [];
    stable.push(sample);
    if (stable.length < 6) { await pause(500); return false; }
    return sample.activeReads === 0 && sample.at - stable[0].at >= 2500;
  }, 60000);
  const samples = stable;
  report.sftpPauseDrain.endedAt = Date.now();
  report.sftpPauseDrain.final = {...fixture.sftpStats};
  report.sftpPauseSamples = samples;
  assert(samples[0].progressBytes > 0 && samples[0].progressBytes < fixture.payload.length, 'Pause must happen mid-transfer');
  assert(samples.every(s => s.serverBytes === samples[0].serverBytes), 'Actual SFTP server bytes changed in stable pause window');
  assert(samples.every(s => s.progressBytes === samples[0].progressBytes), 'Native progress changed in stable pause window');
  const unexpectedRangeStarts = fixture.protocol.reads.filter(read => read.handle === transferHandle && read.receivedAt > pauseAcknowledgedAt && !allowedRanges.has(read.logicalRangeStart));
  report.sftpRangePauseAssertions = {transferHandle, logicalChunkBytes: 32768, noNewLogicalDownloadRangeStarts: unexpectedRangeStarts.length === 0, unexpectedRangeStarts, noCompleteBeforeResume: true};
  assert.equal(unexpectedRangeStarts.length, 0, 'New logical download ranges started after pause acknowledgement');
  assert(samples.every(sample => sample.local.committedPrefixMatchesPayload), 'Committed checkpoint bytes do not match source payload');
  assert(samples.every(sample => sample.local.fullStageSha256 === samples[0].local.fullStageSha256), 'Local file contents changed during stable pause');
  assert(samples.every(sample => sample.checkpointBytes === samples[0].checkpointBytes), 'Committed checkpoint changed during stable pause');
  await capture('04-sftp-paused.png');
  startPauseRecording();
  await pause(2000);
  report.stage = 'SFTP resume';
  const finalPausedNative = await cdp.eval(`({done: window.__qaTransfer.done, completed: window.__qaTransfer.events.some(e => e.type === 'completed')})`);
  assert.equal(finalPausedNative.done, false, 'Transfer resolved before resume request');
  assert.equal(finalPausedNative.completed, false, 'Transfer completed before resume request');
  report.sftpControl.resumeRequestedAt = Date.now();
  const lateNewRanges = fixture.protocol.reads.filter(read => read.handle === transferHandle && read.receivedAt > pauseAcknowledgedAt && read.receivedAt < report.sftpControl.resumeRequestedAt && !allowedRanges.has(read.logicalRangeStart));
  const newIsolatedHandles = fixture.protocol.opens.filter(open => open.channelId !== sharedChannel && open.handle !== transferHandle && open.openedAt > pauseAcknowledgedAt && open.openedAt < report.sftpControl.resumeRequestedAt);
  report.sftpRangePauseAssertions.unexpectedRangeStarts = lateNewRanges;
  report.sftpRangePauseAssertions.unclassifiedNewIsolatedHandles = newIsolatedHandles;
  assert.equal(lateNewRanges.length, 0, 'New logical download range started before explicit resume');
  assert.equal(newIsolatedHandles.length, 0, 'Unclassified isolated file handle opened while paused');
  const resumed = await cdp.eval(`window.netcatty.resumeTransfer(${JSON.stringify(transferId)})`, 60000);
  report.sftpControl.resumed = resumed;
  assert.equal(resumed.success, true, resumed.reason);
  await until('server and progress resume', async () => fixture.sftpStats.bytesSent > samples[0].serverBytes && await progress() > samples[0].progressBytes, 15000);
  await capture('05-sftp-resumed.png');
  await pause(1500);
  await stopPauseRecording();
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
async function verifyHostFilters() {
  report.hostFilters = {status: 'incomplete', cases: []};
  const hosts = [
    {id: 'web', label: 'QA WEB', hostname: '127.0.0.1', username: 'deploy', group: 'prod/web', tags: ['Nginx'], os: 'linux'},
    {id: 'db', label: 'QA DB', hostname: '127.0.0.2', username: 'root', group: 'prod/db', tags: ['postgres'], os: 'linux'},
    {id: 'old', label: 'QA OLD', hostname: '127.0.0.3', username: 'root', group: 'production-old', tags: [], os: 'linux'},
    {id: 'prod-root', label: 'QA PROD ROOT', hostname: '127.0.0.4', username: 'ops', group: 'prod', tags: [], os: 'linux'},
    {id: 'ungrouped', label: 'QA UNGROUPED', hostname: '127.0.0.5', username: 'ops', tags: [], os: 'linux'},
  ];
  await cdp.eval(`localStorage.setItem('netcatty_hosts_v1', ${JSON.stringify(JSON.stringify(hosts))})`);
  await cdp.send('Page.reload');
  await until('synthetic filter host vault loaded', () => cdp.eval(`document.body.innerText.includes('QA UNGROUPED')`));
  await capture('02-host-filter-vault.png');
  const all = hosts.map(h => h.id).sort();
  const cases = [
    [{}, all],
    [{query: '  ', group: ''}, all],
    [{query: 123, group: null}, all],
    [{query: 'WEB nginx'}, ['web']],
    [{query: 'root DB'}, ['db']],
    [{query: 'production'}, []],
    [{group: 'prod'}, ['db', 'prod-root', 'web']],
    [{group: 'prod/web'}, ['web']],
    [{group: ' prod/ '}, ['db', 'prod-root', 'web']],
    [{group: 'PROD'}, []],
    [{group: 'prod', query: 'postgres'}, ['db']],
  ];
  for (const [params, expected] of cases) {
    const result = await mainCdp.eval(`process.mainModule.require(process.mainModule.require('electron').app.getAppPath() + '/electron/bridges/mcpServerBridge.cjs').dispatchBuiltinRpc('public/vault/hosts/list', ${JSON.stringify(params)})`);
    assert.equal(result.ok, true, JSON.stringify(result));
    const ids = result.hosts.map(h => h.id).sort();
    report.hostFilters.cases.push({params, ids, expected});
    assert.deepEqual(ids, expected);
    assert(result.hosts.every(h => !('password' in h) && !('privateKey' in h)));
  }
  report.hostFilters.status = 'pass';
  report.hostFilters.path = 'real packaged public/vault/hosts/list dispatcher -> production renderer vault bridge';
  await capture('03-host-filter-cases-completed.png');
}
function saveEvidence(print) {
  if (fixture && scenario === 'sftp') {
    const pauseAt = report.sftpControl?.pauseAcknowledgedAt;
    const resumeAt = report.sftpControl?.resumeRequestedAt || Infinity;
    report.sftpProtocolSummary = fixture.protocol.opens.map(open => {
      const reads = fixture.protocol.reads.filter(read => read.handle === open.handle);
      return {...open, role: open.handle === report.sftpHandleClassification?.isolatedDownload?.handle ? 'isolated payload download' : open.channelId === report.sftpHandleClassification?.sharedVerificationChannel ? 'shared browse / source verification' : 'unclassified', readCount: reads.length, repliedBytes: reads.reduce((n, read) => n + (read.replyBytes || 0), 0), readsReceivedWhilePaused: reads.filter(read => read.receivedAt > pauseAt && read.receivedAt < resumeAt).length, repliesWhilePaused: reads.filter(read => read.repliedAt > pauseAt && read.repliedAt < resumeAt).length};
    });
  }
  const output = logs.join('');
  const publicText = output + JSON.stringify(report) + (fixture ? JSON.stringify(fixture.protocol) : '');
  const sensitive = publicText.includes(loginPassword) || /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+)|Authorization:\s*Bearer\s+\S+/i.test(publicText);
  report.stderrReview = sensitive ? 'blocked: sensitive output; logs and screenshots withheld' : 'pass: ephemeral password, private key, GitHub credential and bearer-token checks';
  if (sensitive) {
    process.exitCode = 1; delete report.failure; delete report.sshDiagnostics;
    for (const name of ['electron-output.log', 'sftp-protocol.json', 'sftp-pause-resume.mp4', ...screenshots.keys()]) fs.rmSync(path.join(evidence, name), {force: true});
  } else {
    fs.writeFileSync(path.join(evidence, 'electron-output.log'), output);
    if (fixture && scenario === 'sftp') fs.writeFileSync(path.join(evidence, 'sftp-protocol.json'), JSON.stringify(fixture.protocol, null, 2));
    if (fs.existsSync(videoPath) && fs.statSync(videoPath).size > 1000) fs.copyFileSync(videoPath, path.join(evidence, 'sftp-pause-resume.mp4'));
    for (const [name, bytes] of screenshots) fs.writeFileSync(path.join(evidence, name), bytes);
    if (print) console.log('Reviewed official Electron stdout/stderr:\n' + output);
  }
  report.coverage = 'Independent scenario: only this report and candidate SHA count; other scenario reports must be evaluated separately';
  fs.writeFileSync(path.join(evidence, 'assertions.json'), JSON.stringify(report, null, 2));
  if (print) console.log(JSON.stringify(report, null, 2));
}
async function verifyClipboard() {
  report.clipboard = {status: 'incomplete'};
  await terminalLine(cdp, mainCdp, 'QA_CLIPBOARD_ONLY');
  await until('clipboard scenario server receive', () => fixture.sessions.some(s => s.commands.includes('QA_CLIPBOARD_ONLY')));
  await assertEcho('ran: QA_CLIPBOARD_ONLY');
  async function menu(label) {
    await clickElement(cdp, '.xterm', 0, 'right');
    const point = await until(`terminal menu ${label}`, () => cdp.eval(`(() => { const e = [...document.querySelectorAll('[role="menuitem"]')].find(e => e.textContent.trim().startsWith(${JSON.stringify(label)})); if (!e) return null; const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`));
    await clickPoint(cdp, point);
    await pause(200);
  }
  await menu('Select All'); await menu('Copy');
  await until('clipboard receives real terminal echo', async () => {
    const actual = await mainCdp.eval(`process.mainModule.require('electron').clipboard.readText()`);
    report.clipboard.observed = actual;
    return actual.includes('ran: QA_CLIPBOARD_ONLY');
  }, 5000);
  report.clipboard.status = 'pass';
  await capture('03-independent-clipboard.png');
}
async function run() {
  assert.notEqual(process.getuid(), 0, 'QA must run as a non-root user');
  assert(fs.existsSync(executable), `Official executable missing: ${executable}`);
  fs.mkdirSync(evidence, { recursive: true });
  assert(!fs.existsSync(profile), 'QA profile must start clean');
  watchdog = setTimeout(() => { fs.writeFileSync(path.join(evidence, 'watchdog.json'), JSON.stringify({candidate: pinned.sha, scenario, failure: 'Scenario exceeded 180 seconds', stage: report.stage || 'desktop'})); child?.kill('SIGKILL'); process.exit(1); }, 180000);
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
    if (scenario === 'clipboard') { await verifyClipboard(); return; }
    report.sshReconnect = 'incomplete';
    await terminalLine(cdp, mainCdp, 'QA_BEFORE_DISCONNECT');
    await until('first server received command', () => fixture.sessions.some(s => s.commands.includes('QA_BEFORE_DISCONNECT')));
    await assertEcho('ran: QA_BEFORE_DISCONNECT');
    const originalTabs = await cdp.eval(`[...document.querySelectorAll('[data-tab-type="session"]')].map(e => e.getAttribute('data-tab-id'))`);
    assert.equal(originalTabs.length, 1);
    assert(originalTabs[0], 'Stable original tab ID required');
    disconnectFixtureClients(true);
    await capture('03-real-ssh-transport-lost.png');
    await until('transport closed and reconnect path observable', async () => fixture.sessions[0].closedAt && (fixture.sessions.filter(s => s.ready).length >= 2 || await cdp.eval(`Boolean(document.querySelector('[data-terminal-disconnected-dialog="true"]'))`)));
    if (fixture.sessions.filter(s => s.ready).length < 2) {
      report.reconnectMode = 'UI Enter';
      await capture('04-real-ssh-disconnected.png');
      await key(mainCdp, 'Enter'); await key(mainCdp, 'Enter', 'keyUp');
    } else report.reconnectMode = 'production automatic reconnect after real transport loss';
    await until('second real SSH shell', () => fixture.sessions.filter(s => s.ready).length === 2, 20000);
    await pause(700);
    await terminalLine(cdp, mainCdp, 'QA_AFTER_RECONNECT');
    await until('second server received command', () => fixture.sessions.filter(s => s.ready)[1].commands.includes('QA_AFTER_RECONNECT'));
    await assertEcho('ran: QA_AFTER_RECONNECT');
    assert.deepEqual(await cdp.eval(`[...document.querySelectorAll('[data-tab-type="session"]')].map(e => e.getAttribute('data-tab-id'))`), originalTabs);
    report.sshReconnect = 'pass';
    report.ssh = { transport: 'SSH2 over loopback TCP; server destroys its socket, production app reconnects original tab', shellConnections: fixture.sessions.filter(s => s.ready).length, originalTabs, commands: fixture.sessions.filter(s => s.ready).map(s => s.commands.filter(command => command.startsWith('QA_'))), connections: fixture.sessions.filter(s => s.ready).map(({readyAt, closedAt}) => ({readyAt, closedAt})) };
    await capture('05-real-ssh-reconnected.png');
  } catch (error) {
    report.failure = error.message;
    report.failureCategory = 'Unresolved assertion; use focus and server receive diagnostics before assigning a product regression';
    if (fixture) report.sftpServerAtFailure = {...fixture.sftpStats};
    if (scenario === 'sftp' && cdp) report.sftpNativeAtFailure = await cdp.eval(`window.__qaTransfer`).catch(() => null);
    if (fixture) report.sshDiagnostics = fixture.sessions.map(({ready, receivedHex, commands, sent}) => ({ready, receivedHex, commands, sent}));
    if (report.launcher === 'not_run') report.launcher = 'fail';
    await capture('failure-real-application.png').catch(() => {});
    process.exitCode = 1;
  } finally {
    // Persist tested assertions and reviewed evidence before teardown. Cleanup
    // must not erase a functional result or mask the original failure.
    await stopPauseRecording();
    saveEvidence(false);
    try {
      await quit();
      if (fixture) {
        disconnectFixtureClients();
        await Promise.race([new Promise(resolve => fixture.server.close(resolve)), pause(5000)]);
      }
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (error) { report.cleanupWarning = error.code || error.message; }
    clearTimeout(watchdog);
    saveEvidence(true);
  }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
