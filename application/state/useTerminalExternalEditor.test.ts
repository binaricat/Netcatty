import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXTERNAL_EDITOR_AUTO_SETUP_SHELL_PREFIX,
  EXTERNAL_EDITOR_AUTO_SETUP_UPDATED_MARKER,
} from '../../domain/externalEditor';
import { createExternalEditorSessionProvisioner } from './useTerminalExternalEditor';

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('provisions initial editor helpers and activates PATH once, then installs newly selected editor without re-injecting PATH', async () => {
  const execCalls: { sessionId: string; command: string }[] = [];
  const writeCalls: { sessionId: string; data: string; opts?: { automated?: boolean } }[] = [];
  const configuredLabels: string[] = [];

  const provisioner = createExternalEditorSessionProvisioner({
    setupExec: async (sessionId, command) => {
      execCalls.push({ sessionId, command });
      return {
        success: true,
        stdout: `${EXTERNAL_EDITOR_AUTO_SETUP_SHELL_PREFIX}posix\n${EXTERNAL_EDITOR_AUTO_SETUP_UPDATED_MARKER}\n`,
      };
    },
    writeToSession: (sessionId, data, opts) => {
      writeCalls.push({ sessionId, data, opts });
    },
    getCurrentSessionId: () => 'sess-1',
    isReadyForCommandInjection: () => true,
    onConfigured: (label) => configuredLabels.push(label),
  });

  // 1. Initial connection with Zed
  const cancelZed = provisioner.sync({ sessionId: 'sess-1', defaultEditor: 'zed' });
  await flushMicrotasks();

  assert.equal(execCalls.length, 1);
  assert.match(execCalls[0].command, /write_bin '\\''zed'\\''/);
  assert.doesNotMatch(execCalls[0].command, /write_bin '\\''code'\\''/);
  assert.equal(writeCalls.length, 1);
  assert.match(writeCalls[0].data, /export PATH="\$HOME\/\.netcatty\/bin:\$PATH" NETCATTY_EXTERNAL_EDITOR=1/);
  assert.deepEqual(writeCalls[0].opts, { automated: true });
  assert.deepEqual(configuredLabels, ['Zed']);

  // 2. Switching preferred editor to VS Code in the same live session installs `code`
  //    without injecting a duplicate PATH activation command into the terminal.
  cancelZed();
  const cancelVscode = provisioner.sync({ sessionId: 'sess-1', defaultEditor: 'vscode' });
  await flushMicrotasks();

  assert.equal(execCalls.length, 2);
  assert.match(execCalls[1].command, /write_bin '\\''code'\\''/);
  assert.equal(writeCalls.length, 1);
  assert.deepEqual(configuredLabels, ['Zed', 'VS Code']);

  // 3. Switching back to Zed in the same session is a no-op (already provisioned + activated).
  cancelVscode();
  const cancelZedAgain = provisioner.sync({ sessionId: 'sess-1', defaultEditor: 'zed' });
  await flushMicrotasks();

  assert.equal(execCalls.length, 2);
  assert.equal(writeCalls.length, 1);
  cancelZedAgain();
});

test('polls until terminal prompt is ready and cancels cleanly if editor changes before prompt settles', async () => {
  const execCalls: string[] = [];
  const writeCalls: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimerId = 1;
  let ready = false;

  const provisioner = createExternalEditorSessionProvisioner({
    setupExec: async (_sessionId, command) => {
      execCalls.push(command);
      return {
        success: true,
        stdout: `${EXTERNAL_EDITOR_AUTO_SETUP_SHELL_PREFIX}fish\n${EXTERNAL_EDITOR_AUTO_SETUP_UPDATED_MARKER}\n`,
      };
    },
    writeToSession: (_sessionId, data) => {
      writeCalls.push(data);
    },
    getCurrentSessionId: () => 'sess-2',
    isReadyForCommandInjection: () => ready,
    scheduleTimer: (fn) => {
      const id = nextTimerId++;
      timers.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle) => {
      timers.delete(handle as unknown as number);
    },
  });

  // Start with Zed while prompt is still busy with MOTD.
  const cancelZed = provisioner.sync({ sessionId: 'sess-2', defaultEditor: 'zed' });
  await flushMicrotasks();

  assert.equal(execCalls.length, 1);
  assert.equal(writeCalls.length, 0);
  assert.equal(timers.size, 1);

  // Switch to Cursor before prompt becomes ready: old poll is cancelled, Cursor is provisioned.
  cancelZed();
  assert.equal(timers.size, 0);

  const cancelCursor = provisioner.sync({ sessionId: 'sess-2', defaultEditor: 'cursor' });
  await flushMicrotasks();

  assert.equal(execCalls.length, 2);
  assert.match(execCalls[1], /write_bin '\\''cursor'\\''/);
  assert.equal(writeCalls.length, 0);
  assert.equal(timers.size, 1);

  // Prompt becomes ready -> fish PATH activation executes once.
  ready = true;
  const scheduled = [...timers.values()];
  timers.clear();
  scheduled.forEach((fn) => fn());

  assert.equal(writeCalls.length, 1);
  assert.match(writeCalls[0], /set -gx PATH "\$HOME\/\.netcatty\/bin" \$PATH/);
  cancelCursor();
});

test('resets per-session tracking on disconnect so reconnect re-activates PATH', async () => {
  let activeSessionId = 'sess-3';
  const execCalls: string[] = [];
  const writeCalls: string[] = [];

  const provisioner = createExternalEditorSessionProvisioner({
    setupExec: async (sessionId) => {
      execCalls.push(sessionId);
      return {
        success: true,
        stdout: `${EXTERNAL_EDITOR_AUTO_SETUP_SHELL_PREFIX}posix\n`,
      };
    },
    writeToSession: (sessionId) => {
      writeCalls.push(sessionId);
    },
    getCurrentSessionId: () => activeSessionId,
    isReadyForCommandInjection: () => true,
  });

  const cancelFirst = provisioner.sync({ sessionId: 'sess-3', defaultEditor: 'zed' });
  await flushMicrotasks();
  assert.equal(execCalls.length, 1);
  assert.equal(writeCalls.length, 1);
  cancelFirst();

  // Disconnect resets session state even if the same sessionId reconnects.
  provisioner.reset();
  const cancelSecond = provisioner.sync({ sessionId: 'sess-3', defaultEditor: 'zed' });
  await flushMicrotasks();
  assert.equal(execCalls.length, 2);
  assert.equal(writeCalls.length, 2);
  cancelSecond();

  // New backend sessionId also provisions and activates fresh.
  activeSessionId = 'sess-4';
  const cancelThird = provisioner.sync({ sessionId: 'sess-4', defaultEditor: 'zed' });
  await flushMicrotasks();
  assert.equal(execCalls.length, 3);
  assert.equal(writeCalls.length, 3);
  cancelThird();
});
