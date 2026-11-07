import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createTerminalDirectoryIO } from './terminalDirectory';
import { createTerminalDirectoryController } from '../../application/state/terminalDirectoryController';
import { terminalCwdStore } from '../../application/state/terminalCwdStore';
import { directoryChangeCommand } from '../../domain/directoryPicker';
import { sameDirectoryPath } from '../../domain/directoryPath';

const require = createRequire(import.meta.url);
const quote = (value: string) => "'" + value.replace(/['\u2018\u2019\u201a\u201b]/g, quote => quote + quote) + "'";
// Real ConPTY is opt-in, like the existing PTY live fixtures. Use
// --test-force-exit because node-pty's Windows conout worker can retain a pipe
// after its process-exit event; every fixture still awaits shell exit/cleanup.
const enabled = process.platform === 'win32' && process.env.NETCATTY_DIRECTORY_WINDOWS_LIVE === '1';
const shells = enabled ? ['powershell.exe', process.env.NETCATTY_TEST_PWSH || 'pwsh.exe'] : [];

for (const executable of shells) {
  let shell: string | null = null;
  try { shell = fs.existsSync(executable) ? executable : execFileSync('where.exe', [executable], { encoding: 'utf8' }).split(/\r?\n/)[0].trim(); } catch { /* Optional PS7 install. */ }
  test(`native ConPTY Directory Picker: ${executable}`, { skip: !shell, timeout: 60000 }, async t => {
    const tempDir = require('../../electron/bridges/tempDirBridge.cjs');
    const { preparePowerShellDirectoryIntegration } = require('../../electron/bridges/powerShellDirectoryIntegration.cjs');
    const { readLocalSessionCwd } = require('../../electron/bridges/localSessionCwd.cjs');
    const pty = require('node-pty') as typeof import('node-pty');
    tempDir.ensureTempDir();
    const fixture = fs.realpathSync.native(fs.mkdtempSync(tempDir.getTempFilePath('native-powershell-directory-')));
    const name = "space ' [$]`;&!% \u2018\u2019\u201a\u201b 中文";
    const target = path.join(fixture, name);
    fs.mkdirSync(target);
    const plan = preparePowerShellDirectoryIntegration(shell, ['-NoLogo', '-NoProfile']);
    assert.ok(plan);
    // A controlled custom prompt in the managed fixture; no user profile edit.
    const script = plan.args.at(-1)!.slice(3, -1).replace(/''/g, "'");
    const source = fs.readFileSync(script, 'utf8').replace(/^\ufeff/, '');
    fs.writeFileSync(script, '\ufeff' + `function global:prompt { $global:PromptSuccess = $?; $global:PromptExit = $global:LASTEXITCODE; 'CUSTOM_READY> ' }\n` + source, 'utf8');
    const proc = pty.spawn(shell!, plan.args, {
      cwd: fixture, env: { ...process.env, ...plan.env }, cols: 160, rows: 40, useConptyDll: true,
    });
    const exited = new Promise<void>(resolve => { proc.onExit(() => resolve()); });
    plan.reader.setProcessId(proc.pid);
    let ready = false;
    let output = '';
    let lastRevision = 0;
    const subscription = proc.onData(data => {
      output += plan.reader.consume(data);
      const state = plan.reader.read().directoryState;
      if (state && state.revision > lastRevision) { lastRevision = state.revision; ready = true; }
    });
    const waitFor = async (condition: () => boolean, description: string) => {
      const deadline = Date.now() + 10000;
      while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      assert.ok(condition(), description + '\n' + output.slice(-2000));
    };
    const send = async (command: string) => {
      const revision = lastRevision;
      ready = false; plan.reader.invalidate(); proc.write(command + '\r');
      await waitFor(() => lastRevision > revision, 'original runspace reported its next prompt');
    };
    const id = 'conpty-' + executable;
    const writes: string[] = [];
    const io = createTerminalDirectoryIO({
      getSessionPwd: async () => readLocalSessionCwd({ pty: proc, directoryIntegration: plan.reader }),
      listLocalDir: async value => (await fs.promises.readdir(value, { withFileTypes: true })).map(entry => ({
        name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', size: '', lastModified: '',
      })),
      realpathLocal: async value => fs.promises.realpath(value),
      writeToSession: (sessionId, data) => {
        assert.equal(sessionId, id); writes.push(data); ready = false; plan.reader.invalidate(); proc.write(data);
      },
    } as unknown as NetcattyBridge, id, { local: true, hostname: '', username: '', pathFlavor: 'win32' });
    const controller = createTerminalDirectoryController({
      sessionId: id, io, target: { authority: 'local:' + proc.pid, pathFlavor: 'win32' },
      buildChangeCommand: value => directoryChangeCommand(value, 'powershell', 'win32'),
      isCurrent: () => true, isReady: () => ready,
      publish: cwd => terminalCwdStore.setCwd(id, cwd, 'backend-strict'),
    });
    t.after(async () => {
      controller.dispose(); subscription.dispose(); proc.kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer); plan.cleanup();
      await fs.promises.rm(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });
    await waitFor(() => ready, 'PowerShell integration loaded under the existing execution policy');
    assert.ok(output.includes('CUSTOM_READY>'), 'original prompt survived');
    assert.ok(!output.includes('NetcattyDirectory='), 'private report never enters visible output');
    assert.equal(await controller.refresh(), fixture);
    assert.deepEqual((await io.list(fixture)).entries.map(entry => entry.name), [name]);
    await controller.change(target, new AbortController().signal, () => {}, fixture);
    assert.equal(await io.cwd(), target);
    assert.equal(writes.length, 1);
    await send(`Set-Location -LiteralPath ${quote(fixture)}`);
    assert.equal(await controller.refresh(), fixture, 'manual cd uses the same runspace');
    await send(`Start-Sleep -Milliseconds 350; Set-Location -LiteralPath ${quote(target)}`);
    assert.equal(await controller.refresh(), target, 'delayed cd follows the next prompt');
    await send('Set-Location HKLM:\\SOFTWARE');
    await assert.rejects(controller.refresh(), { code: 'nonFilesystem' });
    assert.equal(terminalCwdStore.getCwd(id), null, 'provider change clears the previous filesystem cwd');
    await assert.rejects(controller.list(fixture, new AbortController().signal), { code: 'nonFilesystem' });
    await send(`Set-Location -LiteralPath ${quote(fixture)}`);
    assert.equal(await controller.refresh(), fixture);
    await send('cmd.exe /c exit 7');
    await send('Write-Output ("PROMPT_STATUS:" + $global:PromptSuccess + ":" + $global:PromptExit)');
    assert.ok(output.includes('PROMPT_STATUS:False:7'), 'original prompt sees command status and LASTEXITCODE');
    await send('Set-Location -LiteralPath "C:\\netcatty-nonexistent-directory-98235"');
    assert.equal(await controller.refresh(), fixture, 'failed manual cd never reports the requested directory');
    await send(`New-PSDrive -Name NetcattyTest -PSProvider FileSystem -Root ${quote(fixture)} | Out-Null; Set-Location NetcattyTest:\\`);
    assert.ok(sameDirectoryPath(await controller.refresh(), fixture, 'win32'), 'PSDrive paths report the underlying native ProviderPath');
    if (process.env.NETCATTY_TEST_UNC) {
      await send(`Set-Location -LiteralPath ${quote(process.env.NETCATTY_TEST_UNC)}`);
      assert.equal(await controller.refresh(), process.env.NETCATTY_TEST_UNC, 'UNC remains a native filesystem authority');
      await io.list(process.env.NETCATTY_TEST_UNC);
    }
    await send('Set-Location Env:');
    await assert.rejects(controller.refresh(), { code: 'nonFilesystem' });
    await send(`Set-Location -LiteralPath ${quote(fixture)}`);
    ready = false; plan.reader.invalidate();
    proc.write('function global:prompt { "REPLACED_PROMPT> " }\r');
    await waitFor(() => output.includes('REPLACED_PROMPT>'), 'user prompt replacement remains usable');
    assert.equal(plan.reader.read().success, false, 'replaced integration cannot keep the old report alive');
  });

  test(`execution policy blocks directory integration without bypass: ${executable}`, {
    skip: !shell, timeout: 20000,
  }, async t => {
    const tempDir = require('../../electron/bridges/tempDirBridge.cjs');
    const { preparePowerShellDirectoryIntegration } = require('../../electron/bridges/powerShellDirectoryIntegration.cjs');
    const pty = require('node-pty') as typeof import('node-pty');
    tempDir.ensureTempDir();
    const fixture = fs.realpathSync.native(fs.mkdtempSync(tempDir.getTempFilePath('restricted-powershell-directory-')));
    const plan = preparePowerShellDirectoryIntegration(shell, ['-NoLogo', '-NoProfile']);
    // Apply Restricted to this test child; product startup honors user policy.
    const proc = pty.spawn(shell!, ['-ExecutionPolicy', 'Restricted', ...plan.args], {
      cwd: fixture, env: { ...process.env, ...plan.env }, cols: 160, rows: 40, useConptyDll: true,
    });
    plan.reader.setProcessId(proc.pid);
    const exited = new Promise<void>(resolve => { proc.onExit(() => resolve()); });
    let output = '';
    const subscription = proc.onData(data => { output += plan.reader.consume(data); });
    t.after(async () => {
      subscription.dispose(); proc.kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer); plan.cleanup();
      await fs.promises.rm(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });
    proc.write("[Console]::WriteLine('__NETCATTY_POLICY_ALIVE__'); foreach ($record in $Error) { [Console]::WriteLine($record.Exception.GetType().FullName) }\r");
    const deadline = Date.now() + 10000;
    const policyBlocked = () => output.includes('PSSecurityException')
      || output.includes('Do you want to run software from this untrusted publisher?');
    while (!policyBlocked() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    // PS7 may first ask whether its signed PSReadLine format file is trusted.
    // Preserve the native trust decision for the user.
    assert.ok(policyBlocked(), output.slice(-2000));
    assert.equal(plan.reader.read().success, false, 'blocked script cannot claim native directory support');
  });
}

test('real Windows terminal bridge strips reports and invalidates runspace cwd on submitted input', {
  skip: !enabled, timeout: 30000,
}, async t => {
  const bridge = require('../../electron/bridges/terminalBridge.cjs');
  const tempDir = require('../../electron/bridges/tempDirBridge.cjs');
  const { readLocalSessionCwd } = require('../../electron/bridges/localSessionCwd.cjs');
  tempDir.ensureTempDir();
  const fixture = fs.realpathSync.native(fs.mkdtempSync(tempDir.getTempFilePath('bridge-powershell-directory-')));
  const sessions = new Map();
  let output = '';
  const sender = Object.assign(new EventEmitter(), { id: 112, isDestroyed: () => false,
    send(channel: string, payload: { data?: string }) { if (channel === 'netcatty:data') output += payload.data ?? ''; } });
  bridge.init({ sessions, electronModule: { webContents: { fromId: () => sender } } });
  await bridge.startLocalSession({ sender }, { sessionId: 'bridge-native-ps', shell:
    path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    shellArgs: ['-NoLogo'], cwd: fixture });
  const session = sessions.get('bridge-native-ps');
  assert.ok(session.directoryIntegration);
  const exited = new Promise<void>(resolve => { session.proc.onExit(() => resolve()); });
  t.after(async () => {
    session.proc.kill();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
    await fs.promises.rm(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 8000;
    while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(condition(), output.slice(-2000));
  };
  await waitFor(() => session.directoryIntegration.read().success);
  assert.equal((await readLocalSessionCwd(session)).cwd, fixture);
  bridge.writeToSession({}, { sessionId: 'bridge-native-ps', data: 'Start-Sleep -Milliseconds 500; Set-Location Env:\r' });
  assert.equal((await readLocalSessionCwd(session)).success, false, 'accepted input invalidates the old prompt report immediately');
  await waitFor(() => session.directoryIntegration.read().directoryState?.provider === 'Environment');
  assert.equal((await readLocalSessionCwd(session)).success, false);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(output.includes('NetcattyDirectory='), false);
  assert.equal(String(session.lastIdlePrompt).includes('NetcattyDirectory='), false);
  session.proc.write(`Set-Location -LiteralPath ${quote(fixture)}\r`);
  assert.equal(session.directoryIntegration.read().success, false, 'direct AI/snippet PTY writes invalidate reports too');
  await waitFor(() => session.directoryIntegration.read().success);
});
