import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createTerminalDirectoryIO } from './terminalDirectory';
import { createTerminalDirectoryController } from '../../application/state/terminalDirectoryController';
import {
  observeTerminalDirectory, registerTerminalDirectory, scheduleObservedTerminalDirectoryRefresh,
} from '../../application/state/terminalDirectoryRegistry';

const require = createRequire(import.meta.url);

test('manual SSH cd refreshes through the real session cwd probe with no OSC or trusted prompt', {
  skip: process.platform === 'win32', timeout: 20000,
}, async t => {
  const { Client, Server } = require('ssh2') as typeof import('ssh2');
  const pty = require('node-pty') as typeof import('node-pty');
  const tempDirBridge = require('../../electron/bridges/tempDirBridge.cjs');
  const { createSessionOpsApi } = require('../../electron/bridges/sshBridge/sessionOps.cjs');
  tempDirBridge.ensureTempDir();
  const fixture = fs.mkdtempSync(tempDirBridge.getTempFilePath('ssh-directory-cd-'));
  const first = path.join(fixture, 'first'); const second = path.join(fixture, 'second');
  fs.mkdirSync(first); fs.mkdirSync(second);
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const client = new Client();
  const connections = new Set<import('ssh2').Connection>();
  const children = new Set<ReturnType<typeof spawn>>();
  let shell: import('node-pty').IPty | null = null;
  let execs = 0;
  const server = new Server({ hostKeys: [key] }, connection => {
    connections.add(connection);
    connection.on('error', () => {});
    connection.on('close', () => connections.delete(connection));
    connection.on('authentication', auth => {
      if (auth.method === 'password' && auth.username === 'fixture' && auth.password === 'fixture-only') auth.accept();
      else auth.reject();
    });
    connection.on('ready', () => connection.on('session', accept => {
      const session = accept();
      session.on('pty', acceptPty => acceptPty?.());
      session.on('shell', acceptShell => {
        const channel = acceptShell();
        shell = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-i'], {
          cwd: fixture, env: { ...process.env, PS1: 'custom remote input: ', PROMPT_COMMAND: '' }, cols: 100, rows: 24,
        });
        const running = shell;
        running.onData(data => channel.write(data));
        channel.on('data', data => running.write(data.toString()));
        channel.on('close', () => { try { running.kill(); } catch { /* already exited */ } });
      });
      session.on('exec', (acceptExec, _reject, info) => {
        execs++;
        const channel = acceptExec();
        // Execute the production getSessionPwd script on the fixture server;
        // its own cwd stays at fixture, distinct from the interactive PTY cwd.
        const child = spawn('/bin/sh', ['-c', info.command], { cwd: fixture, env: process.env });
        children.add(child);
        child.stdout.on('data', data => channel.write(data));
        child.stderr.on('data', data => channel.stderr.write(data));
        child.on('close', code => { children.delete(child); channel.exit(code ?? 1); channel.end(); });
      });
    }));
  });
  let unregister = () => {};
  let stopObserving = () => {};
  t.after(async () => {
    stopObserving(); unregister(); client.destroy();
    for (const child of children) child.kill();
    try { shell?.kill(); } catch { /* already exited */ }
    for (const connection of connections) connection.end();
    if (server.address()) await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => {
    client.once('ready', resolve); client.once('error', reject);
    client.connect({ host: '127.0.0.1', port: address.port, username: 'fixture', password: 'fixture-only' });
  });
  const channel = await new Promise<import('ssh2').ClientChannel>((resolve, reject) => {
    client.shell({ term: 'xterm-256color', cols: 100, rows: 24 }, (error, stream) => error ? reject(error) : resolve(stream));
  });
  const id = 'ssh-cd-fixture';
  let output = ''; let published = '';
  channel.on('data', data => { output += data.toString(); scheduleObservedTerminalDirectoryRefresh(id); });
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 6000;
    while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(condition(), 'actual SSH shell cwd reached the observer');
  };
  await waitFor(() => !!shell && output.includes('custom remote input: '));
  const sessions = new Map([[id, { protocol: 'ssh', conn: client, stream: channel,
    shellPid: String(shell!.pid), remoteSshVersion: 'OpenSSH_9.6' }]]);
  const api = createSessionOpsApi({ sessions, setTimeout, clearTimeout,
    quoteShellArg: (value: string) => "'" + value.replace(/'/g, "'\\''") + "'", log() {} });
  const io = createTerminalDirectoryIO({
    getSessionRemoteInfo: sessionId => api.getSessionRemoteInfo(null, { sessionId }),
    getSessionPwd: (sessionId, options) => api.getSessionPwd(null, { sessionId, ...options }),
  } as unknown as NetcattyBridge, id, { local: false, hostname: '127.0.0.1', username: 'fixture', port: address.port });
  const controller = createTerminalDirectoryController({ sessionId: id, io,
    isCurrent: () => true, isReady: () => false, publish: cwd => { published = cwd; } });
  unregister = registerTerminalDirectory(id, controller);
  stopObserving = observeTerminalDirectory(id);
  channel.write(`cd -- '${first}'\r`);
  await waitFor(() => published === fs.realpathSync(first));
  channel.write(`sleep 0.6; cd -- '${second}'\r`);
  await waitFor(() => published === fs.realpathSync(second));
  assert.ok(execs >= 2, 'production strict cwd queries used SSH exec channels');
});
