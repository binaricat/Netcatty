import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminalDirectoryIO } from './terminalDirectory';

test('remote reads use only the exact terminal connection and always close their channel', async () => {
  const calls: unknown[] = [];
  const bridge = {
    getSessionRemoteInfo: async () => ({ success: true, remoteSshVersion: 'OpenSSH_9.6' }),
    openSftpForSession: async (id: string, opts: NetcattySSHOptions) => { calls.push([id, opts]); return 'owned-channel'; },
    listSftp: async () => { throw new Error('denied'); },
    closeSftp: async (id: string) => { calls.push(['close', id]); },
  } as unknown as NetcattyBridge;
  const io = createTerminalDirectoryIO(bridge, 'terminal-a', { local: false, hostname: 'remote', username: 'me', port: 2222 });
  await assert.rejects(io.list('/project'), /denied/);
  assert.deepEqual(calls, [['terminal-a', { hostname: 'remote', username: 'me', port: 2222, requireExactSourceSession: true, reuseExactSessionOnly: true, fileProtocol: 'sftp' }], ['close', 'owned-channel']]);
});

test('cwd probes forbid home/login-shell fallbacks, and writes are addressed to one session', async () => {
  const calls: unknown[] = [];
  const bridge = {
    getSessionPwd: async (id: string, opts: unknown) => { calls.push([id, opts]); return { success: true, cwd: '/actual' }; },
    writeToSession: (...args: unknown[]) => { calls.push(args); },
  } as unknown as NetcattyBridge;
  const io = createTerminalDirectoryIO(bridge, 'terminal-a', { local: true, hostname: '', username: '' });
  assert.equal(await io.cwd(), '/actual');
  io.write("cd -- '/actual'\r");
  assert.deepEqual(calls, [
    ['terminal-a', { allowHomeFallback: false, allowLoginShellFallback: false, timeoutMs: 2000 }],
    ['terminal-a', "cd -- '/actual'\r", { automated: true }],
  ]);
});

test('network-device SSH banners refuse probes before opening exec or SFTP', async () => {
  let probes = 0;
  const io = createTerminalDirectoryIO({
    getSessionRemoteInfo: async () => ({ success: true, remoteSshVersion: '-' }),
    getSessionPwd: async () => { probes++; return { success: true, cwd: '/wrong' }; },
  } as unknown as NetcattyBridge, 'router', { local: false, hostname: 'router', username: 'me' });
  await assert.rejects(io.cwd(), { code: 'unavailable' });
  assert.equal(probes, 0);
});

test('single-channel sessions never invoke dedicated-login SFTP fallback', async () => {
  let opened = false;
  const io = createTerminalDirectoryIO({
    getSessionRemoteInfo: async () => ({ success: true, singleChannelSsh: true, remoteSshVersion: 'OpenSSH_9.6' }),
    openSftpForSession: async () => { opened = true; return 'unexpected'; },
  } as unknown as NetcattyBridge, 'limited', { local: false, hostname: 'limited', username: 'me' });
  await assert.rejects(io.list('/project'), { code: 'unavailable' });
  assert.equal(opened, false);
});

test('a connection invalidated while metadata is loading does not open another channel', async () => {
  let finish!: (value: { success: boolean; remoteSshVersion: string }) => void;
  let current = true; let opened = false;
  const io = createTerminalDirectoryIO({
    getSessionRemoteInfo: () => new Promise(resolve => { finish = resolve; }),
    openSftpForSession: async () => { opened = true; return 'unexpected'; },
  } as unknown as NetcattyBridge, 'old', { local: false, hostname: 'remote', username: 'me' }, () => current);
  const read = io.list('/project'); current = false;
  finish({ success: true, remoteSshVersion: 'OpenSSH_9.6' });
  await assert.rejects(read, { code: 'unavailable' });
  assert.equal(opened, false);
});

test('closing a picker during channel open closes the handle without listing', async () => {
  let finish!: (id: string) => void;
  let listed = false; let closed = false;
  const io = createTerminalDirectoryIO({
    getSessionRemoteInfo: async () => ({ success: true, remoteSshVersion: 'OpenSSH_9.6' }),
    openSftpForSession: () => new Promise(resolve => { finish = resolve; }),
    listSftp: async () => { listed = true; return []; },
    closeSftp: async () => { closed = true; },
  } as unknown as NetcattyBridge, 'remote', { local: false, hostname: 'remote', username: 'me' });
  const cancel = new AbortController();
  const task = io.list('/project', cancel.signal);
  await Promise.resolve(); await Promise.resolve();
  cancel.abort(); finish('temporary-channel');
  await assert.rejects(task, { code: 'unavailable' });
  assert.equal(listed, false); assert.equal(closed, true);
});
