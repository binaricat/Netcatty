// Operates the installed, unmodified Electron application through its real GUI.
// Storage and native debugger calls below observe state; all test data is seeded
// through normal controls and a deterministic model bound only to loopback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const pinned = require('./candidate.json');
const portable = process.env.QA_MODE === 'portable';
const root = path.resolve(process.env.QA_ROOT);
const evidence = path.join(root, 'evidence');
const staging = path.join(root, 'unreviewed');
const home = path.join(root, 'user');
const profile = path.join(root, 'profile');
const installDir = path.join(root, 'app');
let executable = path.join(installDir, 'Netcatty.exe');
const hostLabel = 'QA Windows Loopback';
const report = {
  candidate: pinned.sha, qaHead: process.env.QA_HEAD_SHA, mode: portable ? 'portable ZIP' : 'NSIS installed',
  baselineInstall: 'not_run', baselineGuiSeed: 'not_run', installerReplacement: 'not_run',
  candidateInstall: 'not_run', aiHistoryMigration: 'not_run', restartPersistence: 'not_run',
  scope: portable ? 'Independent official Windows ZIP extraction and real native Electron GUI migration; no installation, replacement or updater coverage. CDP PNGs are actual renderer captures. Synthetic data only.' : 'Real per-user NSIS and installed native Electron renderer on ephemeral windows-2022; CDP PNGs are actual renderer captures, not OS desktop captures. Synthetic data only.',
  updater: 'not_covered: CI candidate 0.0.0-sha version is not a released automatic updater test',
  security: 'Stock application sandbox settings; no disabling flags, privilege or system security changes',
  events: [], installers: [], launches: [],
};
const logs = [];
const replies = new Map([
  ['QA_ALPHA_USER_ONE', 'QA_ALPHA_REPLY_ONE'], ['QA_ALPHA_USER_TWO', 'QA_ALPHA_REPLY_TWO'],
  ['QA_BETA_USER_ONE', 'QA_BETA_REPLY_ONE'], ['QA_BETA_USER_TWO', 'QA_BETA_REPLY_TWO'],
  ['QA_BETA_AFTER_UPGRADE', 'QA_BETA_REPLY_AFTER_UPGRADE'],
]);
let app, browser, page, inspector, fixture, watchdog;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function event(label, detail) { report.events.push({ at: new Date().toISOString(), label, detail }); console.log(label); }
async function until(label, check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { if (error instanceof SyntaxError) throw error; last = error; }
    await sleep(200);
  }
  throw new Error(`Timed out: ${label}${last ? `: ${last.message}` : ''}`);
}
function childExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off('exit', finish); resolve(false); }, timeout);
    child.once('exit', finish);
  });
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function isolatedEnvironment(installer = false) {
  const allowed = ['PATH', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'ALLUSERSPROFILE', 'PUBLIC', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'USERNAME', 'USERDOMAIN', 'USERDNSDOMAIN', 'COMPUTERNAME', 'SESSIONNAME', 'PSModulePath', 'PSHOME'];
  const env = {};
  for (const key of allowed) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp') });
  for (const dir of [home, env.APPDATA, env.LOCALAPPDATA, env.TEMP]) fs.mkdirSync(dir, { recursive: true });
  // NSIS uses the real ephemeral Windows user's shell folders. Its explicit
  // installation directory remains QA-owned; only the application gets the
  // synthetic home/profile. Do not change Windows account or registry paths.
  if (installer) for (const key of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
function osCommand(script, timeout = 20000, extra = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...isolatedEnvironment(true), ...extra }, encoding: 'utf8', timeout });
}
function installerDiagnostic(label, pid) {
  const result = { executableExists: fs.existsSync(executable), installFiles: fs.existsSync(installDir) ? fs.readdirSync(installDir) : [] };
  try {
    result.process = osCommand(`Get-CimInstance Win32_Process -Filter "ProcessId=$env:QA_NSIS_PID" | Select-Object Name,ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json; Get-Process | Where-Object {$_.ProcessName -like '*Netcatty*'} | Select-Object ProcessName,Id,MainWindowTitle,Responding,SessionId | ConvertTo-Json`, 10000, { QA_NSIS_PID: String(pid) });
  } catch (error) { result.processError = error.message; }
  try {
    result.desktop = osCommand(`Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing
      $b = [Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bitmap = [Drawing.Bitmap]::new($b.Width,$b.Height); $g = [Drawing.Graphics]::FromImage($bitmap)
      $g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size)
      $bitmap.Save($env:QA_NATIVE_PNG,[Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bitmap.Dispose(); 'Actual OS desktop captured'`, 10000, { QA_NATIVE_PNG: path.join(staging, `installer-${label.replace(/[^a-z0-9]/gi, '-')}.png`) });
  } catch (error) { result.desktopError = error.message; }
  try {
    const source = `using System; using System.Text; using System.Runtime.InteropServices;
      public class QaWindows { public delegate bool Callback(IntPtr h, IntPtr p);
      [DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb, IntPtr p);
      [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, Callback cb, IntPtr p);
      [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder b, int n);
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }`;
    const script = `Add-Type -TypeDefinition $env:QA_NATIVE_SOURCE
      $items = [Collections.Generic.List[object]]::new()
      [QaWindows]::EnumWindows({param($h,$p)
        [uint32]$owner = 0; [void][QaWindows]::GetWindowThreadProcessId($h,[ref]$owner)
        $proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
        if ($proc.ProcessName -like '*Netcatty*') {
          $text = [Text.StringBuilder]::new(4096); [void][QaWindows]::GetWindowText($h,$text,4096)
          $items.Add(@{process=$proc.ProcessName;pid=$owner;text=$text.ToString()})
          [QaWindows]::EnumChildWindows($h,{param($child,$unused)
            $body = [Text.StringBuilder]::new(4096); [void][QaWindows]::GetWindowText($child,$body,4096)
            if ($body.Length) {$items.Add(@{childText=$body.ToString()})}; return $true
          },[IntPtr]::Zero) | Out-Null
        }; return $true
      },[IntPtr]::Zero) | Out-Null
      $items | ConvertTo-Json -Depth 5`;
    result.windows = osCommand(script, 10000, { QA_NATIVE_SOURCE: source });
  } catch (error) { result.windowError = error.message; }
  return result;
}
class Inspector {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map();
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
    });
  }
  async connect() {
    await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }); });
  }
  async eval(expression) {
    if (typeof expression === 'function') expression = `(${expression.toString()})()`;
    new vm.Script(expression); // Validate generated debugger code before sending.
    const id = ++this.id;
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
async function install(installer, label, uninstall = false) {
  assert(!app || app.exitCode !== null, 'Close app before official installer');
  const args = uninstall ? ['/S', '/currentuser'] : ['/S', '/currentuser', `/D=${installDir}`];
  const started = Date.now();
  const child = spawn(installer, args, { env: isolatedEnvironment(true), windowsHide: false, stdio: 'ignore' });
  let output = '';
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const completed = await childExit(child, 90000);
  const diagnostic = !completed ? installerDiagnostic(label, child.pid) : undefined;
  if (!completed) child.kill();
  const result = { label, installer: path.basename(installer), arguments: args, exitCode: child.exitCode, completed, durationMs: Date.now() - started, output, error: spawnError?.message, diagnostic };
  report.installers.push(result); event(`installer ${label}`, result);
  return completed && child.exitCode === 0 && !spawnError;
}
async function startModel() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-api-key');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: 'qa-history-fixture', object: 'model', owned_by: 'synthetic-loopback' }] })); return; }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let raw = '';
    for await (const part of req) { raw += part; if (raw.length > 4e6) { res.writeHead(413); res.end(); return; } }
    const body = JSON.parse(raw);
    const last = body.messages?.filter(m => m.role === 'user').at(-1)?.content;
    const content = typeof last === 'string' ? last : (last || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
    const matched = [...replies.keys()].find(text => content?.includes(text));
    calls.push({ at: new Date().toISOString(), prompt: matched || 'UNEXPECTED_SYNTHETIC_REQUEST', model: body.model, stream: body.stream });
    const reply = replies.get(matched) || 'QA_UNEXPECTED_PROMPT';
    if (!body.stream) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'qa', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] })); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'qa', object: 'chat.completion.chunk', created: 1700000000, model: 'qa-history-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.write(chunk({ role: 'assistant', content: reply }));
    await sleep(100);
    res.write(chunk({}, 'stop')); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, calls, port: server.address().port };
}
async function screenshot(name, target = page) {
  if (target && !target.isClosed()) {
    const png = await target.screenshot({ path: path.join(staging, `${name}.png`), timeout: 10000 });
    (report.screenshots ||= []).push({ name: `${name}.png`, bytes: png.length, width: png.readUInt32BE(16), height: png.readUInt32BE(20), sha256: crypto.createHash('sha256').update(png).digest('hex'), scope: 'Actual native application renderer' });
  }
}
async function launch(label, expectedVersion) {
  assert(fs.existsSync(executable), 'Official installer must create Netcatty.exe');
  const port = await freePort(), inspectPort = await freePort();
  app = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${inspectPort}`], {
    cwd: path.dirname(executable), env: isolatedEnvironment(), windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.on('error', error => logs.push(`${label}: ${error.message}`));
  for (const name of ['stdout', 'stderr']) app[name].on('data', part => logs.push(`[${label} ${name}] ${part}`));
  const info = await until(`${label} native debugger`, async () => {
    assert.equal(app.exitCode, null, 'Installed app exited before debugger');
    const response = await fetch(`http://127.0.0.1:${inspectPort}/json/list`, { signal: AbortSignal.timeout(1000) });
    return (await response.json())[0];
  }, 45000);
  inspector = new Inspector(info.webSocketDebuggerUrl); await inspector.connect();
  await until(`${label} Chromium debugger ready`, async () => {
    assert.equal(app.exitCode, null, 'Real app exited before Chromium debugger');
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return (await response.json()).webSocketDebuggerUrl;
  }, 45000);
  await until(`${label} actual native renderer ready`, () => inspector.eval(async () => {
    const e = process.mainModule.require('electron');
    const w = e.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('app://netcatty/index.html') && !w.webContents.getURL().includes('settings'));
    return !!w && !w.webContents.isLoadingMainFrame() && await w.webContents.executeJavaScript("!!document.querySelector('[data-section=\"top-tabs-toolbar-actions\"]')");
  }), 45000);
  const native = await inspector.eval(`(() => {
    const e = process.mainModule.require('electron');
    const w = e.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('app://netcatty/index.html') && !w.webContents.getURL().includes('settings'));
    w.setSize(1440, 1000); w.show(); w.focus();
    return { version:e.app.getVersion(), packaged:e.app.isPackaged, appPath:e.app.getAppPath(), profile:e.app.getPath('userData'), executable:process.execPath,
      origin:w.webContents.getURL(), argv:process.argv, preferences:w.webContents.getLastWebPreferences(),
      noSandbox:e.app.commandLine.hasSwitch('no-sandbox'), disableSetuidSandbox:e.app.commandLine.hasSwitch('disable-setuid-sandbox') };
  })()`);
  report.launches.push({ label, ...native });
  assert.equal(native.version, expectedVersion);
  assert.equal(native.packaged, true);
  assert.equal(path.resolve(native.profile).toLowerCase(), profile.toLowerCase());
  assert.equal(path.resolve(native.executable).toLowerCase(), executable.toLowerCase());
  assert(native.appPath.toLowerCase().startsWith(path.dirname(executable).toLowerCase()));
  assert.equal(native.noSandbox, false); assert.equal(native.disableSetuidSandbox, false);
  event(`launched ${label}`, { version: native.version, origin: native.origin });
  const nativePng = await inspector.eval(`(async () => {
    const e = process.mainModule.require('electron');
    const w = e.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('app://netcatty/index.html') && !w.webContents.getURL().includes('settings'));
    return (await w.webContents.capturePage()).toPNG().toString('base64');
  })()`);
  fs.writeFileSync(path.join(staging, `native-launch-${label}.png`), Buffer.from(nativePng, 'base64'));
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30000 });
  browser.contexts()[0].setDefaultTimeout(12000);
  page = await until(`${label} actual app page`, () => browser.contexts()[0].pages().find(p => p.url().startsWith('app://netcatty/index.html') && !p.url().includes('settings')));
  await page.locator('[data-section="top-tabs-toolbar-actions"]').waitFor({ timeout: 15000 });
  await screenshot(`launch-${label}`);
  return native.version;
}
async function quit() {
  if (!app) return;
  if (inspector) {
    try { await inspector.eval("setImmediate(() => process.mainModule.require('electron').app.quit()); true"); } catch {}
    inspector.close(); inspector = null;
  }
  // Node inspector must disconnect before Electron can exit normally.
  assert(await childExit(app, 20000), 'App did not complete normal quit; do not call persistence passed');
  browser = null; page = null;
}
async function snapshot() {
  return page.evaluate(async () => {
    const read = key => { const value = localStorage.getItem(key); return value ? JSON.parse(value) : null; };
    const result = { origin: location.origin, legacy: read('netcatty_ai_sessions_v1'), activeMap: read('netcatty_ai_active_session_map_v1'), hosts: read('netcatty_hosts_v1'), databases: await indexedDB.databases() };
    if (result.databases.some(db => db.name === 'netcatty_ai_sessions')) {
      result.idb = await new Promise((resolve, reject) => {
        const request = indexedDB.open('netcatty_ai_sessions');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction(['sessions', 'meta'], 'readonly');
          const sessions = tx.objectStore('sessions').getAll(), meta = tx.objectStore('meta').getAll();
          tx.oncomplete = () => { db.close(); resolve({ sessions: sessions.result, meta: meta.result }); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        };
      });
    }
    return result;
  });
}
function sessionWith(snapshot, marker) {
  return (snapshot.idb?.sessions || snapshot.legacy || []).find(s => s.messages.some(m => m.role === 'user' && m.content.includes(marker)));
}
function messages(session) { return session.messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ id: m.id, role: m.role, content: m.content, timestamp: m.timestamp })); }
async function configureProvider() {
  await page.locator('[data-section="top-tabs-toolbar-actions"] button:has(svg.lucide-settings)').click();
  const settings = await until('native settings window', () => browser.contexts()[0].pages().find(p => p.url().includes('settings')));
  await settings.getByRole('tab', { name: 'AI', exact: true }).click();
  await settings.getByRole('tab', { name: 'Providers', exact: true }).click();
  await settings.getByRole('button', { name: 'Add Provider', exact: true }).click();
  await settings.getByRole('button', { name: 'Custom', exact: true }).click();
  await settings.getByPlaceholder('e.g. My Provider').fill('QA Loopback');
  await settings.getByPlaceholder('Enter API key').fill('qa-local-only');
  await settings.getByPlaceholder('https://', { exact: true }).fill(`http://127.0.0.1:${fixture.port}/v1`);
  await settings.getByPlaceholder(/Search or type model ID|e\.g\. gpt-4o/).fill('qa-history-fixture');
  const chat = settings.getByRole('button', { name: 'Chat Completions', exact: true });
  if (await chat.count()) await chat.click();
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  const enable = settings.getByRole('switch', { checked: false }).first();
  await enable.click();
  await until('provider enabled', () => settings.getByRole('switch', { checked: true }).count());
  // Close via normal native-window control; settings is a real separate window.
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await page.bringToFront(); event('Configured normal loopback OpenAI provider');
}
async function saveHost() {
  await page.getByRole('button', { name: 'New Host', exact: true }).click();
  await page.getByPlaceholder('Label (e.g., Production Server)', { exact: true }).fill(hostLabel);
  await page.getByPlaceholder('IP or Hostname', { exact: true }).fill('127.0.0.1');
  await page.getByPlaceholder('Username', { exact: true }).fill('synthetic-qa');
  await page.locator('button[aria-label="Save"]').click();
  await until('GUI saved loopback host', async () => (await snapshot()).hosts?.some(h => h.label === hostLabel && (h.hostname === '127.0.0.1' || h.address === '127.0.0.1')));
  await page.getByText(hostLabel, { exact: true }).filter({ visible: true }).first().waitFor();
  event('Synthetic host saved through actual GUI');
}
async function aiPanel(restore = false) {
  if (!restore) {
    await page.keyboard.press('Control+t');
    await page.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached' });
  }
  let panel = page.locator('[data-section="ai-chat-panel"]:visible');
  if (!(await panel.count())) await page.locator('[data-section="top-tabs-toolbar-actions"] button:has(svg.lucide-sparkles)').click();
  await panel.waitFor({ state: 'visible' });
  return panel;
}
async function send(panel, prompt) {
  const input = panel.locator('textarea:visible').first();
  await input.fill(prompt); await input.press('Enter');
  await panel.getByText(replies.get(prompt), { exact: true }).waitFor({ timeout: 45000 });
  await until(`stored full reply ${prompt}`, async () => sessionWith(await snapshot(), prompt)?.messages.some(m => m.role === 'assistant' && m.content === replies.get(prompt)), 20000);
  event('Normal AI turn completed', { prompt, reply: replies.get(prompt) });
}
async function chooseChat(panel, marker) {
  await panel.locator('button:has(svg.lucide-history)').click();
  await panel.getByText(marker, { exact: true }).first().click();
  await panel.getByText(replies.get(marker), { exact: true }).waitFor();
}
async function assertChats(baseline, current, afterAppend = false) {
  const a = sessionWith(current, 'QA_ALPHA_USER_ONE'), b = sessionWith(current, 'QA_BETA_USER_ONE');
  assert(a && b, 'Both distinct chats must exist'); assert.notEqual(a.id, b.id);
  const oldA = sessionWith(baseline, 'QA_ALPHA_USER_ONE'), oldB = sessionWith(baseline, 'QA_BETA_USER_ONE');
  assert.equal(a.id, oldA.id); assert.equal(b.id, oldB.id);
  assert.deepEqual(messages(a), messages(oldA), 'Alpha complete turns and identities preserved');
  assert.deepEqual(messages(b).slice(0, 4), messages(oldB), 'Beta original full turns and identities preserved');
  assert.equal(messages(b).length, afterAppend ? 6 : 4);
  if (afterAppend) assert.deepEqual(messages(b).slice(-2).map(m => [m.role, m.content]), [['user', 'QA_BETA_AFTER_UPGRADE'], ['assistant', 'QA_BETA_REPLY_AFTER_UPGRADE']]);
  assert(current.hosts.some(h => h.id === baseline.hosts.find(h => h.label === hostLabel).id && h.label === hostLabel));
  assert(current.idb, 'Candidate must use the real AI IndexedDB');
  assert(current.idb.meta.some(m => m.key === 'migrationCompleted' && m.value?.migrationCompleted === true));
  const active = current.idb.meta.find(m => m.key === 'activeSessionMap')?.value;
  assert(active && typeof active === 'object', 'IndexedDB meta.activeSessionMap must exist directly; no legacy fallback');
  assert(Object.values(active || {}).includes(b.id), 'Active conversation Beta must persist');
  const activeKey = Object.keys(baseline.activeMap || {}).find(key => baseline.activeMap[key] === oldB.id);
  assert(activeKey, 'Baseline has an explicit active Beta pointer');
  assert.equal(active[activeKey], oldB.id, 'Exact original scope-to-session active pointer preserved');
  assert.equal(current.origin, baseline.origin, 'Actual app origin must stay identical');
  assert.deepEqual(a.scope, oldA.scope); assert.deepEqual(b.scope, oldB.scope);
  return { alpha: a.id, beta: b.id, activeMap: active, alphaMessages: messages(a).length, betaMessages: messages(b).length };
}
async function main() {
  assert.equal(process.platform, 'win32');
  assert(!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN, 'Application/test step must not receive GitHub token');
  fs.mkdirSync(evidence, { recursive: true }); fs.mkdirSync(staging, { recursive: true });
  assert(!fs.existsSync(profile), 'Only a fresh QA profile may be seeded');
  report.processPreflight = osCommand("'QA_WINDOWS_PROCESS_PREFLIGHT'; [Environment]::UserName; [Environment]::OSVersion.VersionString", 10000);
  event('Windows process preflight passed');
  watchdog = setTimeout(() => { report.error = 'Harness global timeout'; finish().finally(() => process.exit(1)); }, 11 * 60 * 1000);
  fixture = await startModel();
  if (portable) {
    executable = path.join(root, 'baseline-portable', 'Netcatty.exe');
    report.baselineInstall = 'not_covered: official ZIP extraction';
    report.installerReplacement = 'not_covered: separate portable migration job';
    report.candidateInstall = 'not_covered: official ZIP extraction';
  } else {
    assert(await install(path.join(root, pinned.baseline.installer), 'baseline v1.1.90'), 'Baseline NSIS failed'); report.baselineInstall = 'passed';
  }
  await launch('baseline', '1.1.90');
  await configureProvider(); await saveHost();
  let panel = await aiPanel();
  await send(panel, 'QA_ALPHA_USER_ONE'); await send(panel, 'QA_ALPHA_USER_TWO');
  await screenshot('01-baseline-alpha');
  await panel.locator('button:has(svg.lucide-plus)').first().click();
  await send(panel, 'QA_BETA_USER_ONE'); await send(panel, 'QA_BETA_USER_TWO');
  await screenshot('02-baseline-beta-active');
  const baseline = await snapshot();
  assert(!baseline.idb, 'Released baseline must exercise legacy-to-IDB migration');
  assert.equal(messages(sessionWith(baseline, 'QA_ALPHA_USER_ONE')).length, 4);
  assert.equal(messages(sessionWith(baseline, 'QA_BETA_USER_ONE')).length, 4);
  fs.writeFileSync(path.join(evidence, 'baseline-storage.json'), JSON.stringify(baseline, null, 2));
  report.baselineGuiSeed = 'passed'; await quit();
  if (portable) executable = path.join(root, 'candidate-portable', 'Netcatty.exe');
  else {
  const replaced = await install(path.join(root, pinned.installer), 'candidate replacement');
  if (!replaced) {
    report.installerReplacement = 'blocked_or_failed: see installer exit/output; CI version is older than 1.1.90';
    // Normal uninstall/reinstall is separately labelled. Never patch the package
    // or bypass an official installer version check; keep the custom profile.
    const uninstall = path.join(installDir, 'Uninstall Netcatty.exe');
    assert(fs.existsSync(uninstall), 'Normal uninstaller unavailable');
    assert(await install(uninstall, 'baseline normal uninstall (preserve explicit QA profile)', true));
    assert(await install(path.join(root, pinned.installer), 'candidate fresh install preserving QA profile'), 'Candidate fresh NSIS failed');
    report.candidateInstall = 'passed: fresh install after normal baseline uninstall; migration uses original profile';
  } else { report.installerReplacement = 'passed: normal per-user NSIS replacement'; report.candidateInstall = 'passed'; }
  }
  await launch('candidate-after-install', pinned.version);
  panel = await aiPanel(true);
  const migrated = await until('IDB migration completed', async () => {
    const value = await snapshot();
    return value.idb?.meta.some(m => m.key === 'migrationCompleted' && m.value?.migrationCompleted === true) && value;
  });
  fs.writeFileSync(path.join(evidence, 'candidate-migrated-storage.json'), JSON.stringify(migrated, null, 2));
  report.migratedChats = await assertChats(baseline, migrated);
  report.candidateInitialView = { automaticallyOpenedBeta: await panel.getByText('QA_BETA_REPLY_TWO', { exact: true }).isVisible(), visibleText: await panel.innerText(), policy: 'Stock panelViewByScope is memory-only; exact persisted active pointer checked before any chat selection' };
  await screenshot('candidate-initial-view-before-history-selection');
  if (!report.candidateInitialView.automaticallyOpenedBeta) await chooseChat(panel, 'QA_BETA_USER_ONE');
  await panel.getByText('QA_BETA_REPLY_TWO', { exact: true }).waitFor();
  await screenshot('03-candidate-beta-active');
  await chooseChat(panel, 'QA_ALPHA_USER_ONE'); await screenshot('04-candidate-alpha');
  await chooseChat(panel, 'QA_BETA_USER_ONE');
  report.aiHistoryMigration = 'passed';
  await send(panel, 'QA_BETA_AFTER_UPGRADE'); await screenshot('05-candidate-appended');
  await quit(); await launch('candidate-restarted', pinned.version);
  panel = await aiPanel(true);
  const restarted = await snapshot();
  fs.writeFileSync(path.join(evidence, 'candidate-restarted-storage.json'), JSON.stringify(restarted, null, 2));
  report.restartedChats = await assertChats(baseline, restarted, true);
  report.restartInitialView = { automaticallyOpenedBeta: await panel.getByText('QA_BETA_REPLY_AFTER_UPGRADE', { exact: true }).isVisible(), visibleText: await panel.innerText(), policy: 'Report automatic view restoration separately from unchanged IndexedDB active pointer and complete persisted turns' };
  await screenshot('restarted-initial-view-before-history-selection');
  if (!report.restartInitialView.automaticallyOpenedBeta) await chooseChat(panel, 'QA_BETA_USER_ONE');
  await panel.getByText('QA_BETA_REPLY_AFTER_UPGRADE', { exact: true }).waitFor();
  await screenshot('06-candidate-restarted');
  report.restartPersistence = 'passed';
  await quit(); event('Windows installed real GUI acceptance completed');
}
let finishing;
async function finish() {
  if (finishing) return finishing;
  finishing = (async () => {
    clearTimeout(watchdog);
    if (report.error && browser) {
      for (const [index, target] of browser.contexts()[0].pages().entries()) {
        try { await screenshot(`failure-${index}`, target); } catch {}
        try {
          const text = await target.locator('body').innerText({ timeout: 3000 });
          fs.writeFileSync(path.join(evidence, `failure-${index}-visible-ui.txt`), text);
          (report.failureVisibleUI ||= []).push({ page: index, text: text.slice(-14000) });
        } catch {}
      }
    }
    if (report.error && app && !browser) report.nativeFailureDiagnostic = installerDiagnostic('application-launch-failure', app.pid);
    try { await quit(); } catch (error) { report.cleanupError = error.message; app?.kill(); }
    if (fixture) { fixture.server.closeAllConnections(); fixture.server.close(); report.modelCalls = fixture.calls; }
    const stderr = logs.join('\n');
    // Only synthetic app data and no tokens/credentials may leave this runner.
    const secretPattern = /(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----|Bearer\s+(?!qa-local-only)[A-Za-z0-9_.-]{20,})/i;
    report.evidenceReview = secretPattern.test(stderr) ? 'failed: raw app logs and PNGs withheld' : 'passed: app logs checked for credential patterns; only known synthetic GUI data';
    if (!secretPattern.test(stderr)) {
      fs.writeFileSync(path.join(evidence, 'app-output.log'), stderr);
      console.log('Reviewed actual application output:\n' + stderr);
      for (const file of fs.readdirSync(staging)) fs.copyFileSync(path.join(staging, file), path.join(evidence, file));
    } else { report.error ||= 'Evidence sensitive-data review failed'; process.exitCode = 1; }
    fs.writeFileSync(path.join(evidence, 'assertions.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  })();
  return finishing;
}
main().catch(error => { report.error = error.stack; process.exitCode = 1; }).finally(finish);
