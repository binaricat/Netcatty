import assert from 'node:assert/strict';
import test from 'node:test';

import { createPromptHostnameSessionSignalController } from './promptHostnameSessionSignalController.ts';

type Change = readonly [sessionId: string, hostname: string | null];

const getSession = (sessionId: string) => (
  sessionId === 'ssh-1'
    ? { protocol: 'ssh' as const, hostname: 'jump.example.com' }
    : { protocol: 'local' as const, hostname: 'localhost' }
);

function createHarness() {
  const changes: Change[] = [];
  const controller = createPromptHostnameSessionSignalController({
    getSession,
    onChange: (sessionId, hostname) => changes.push([sessionId, hostname]),
  });
  return { changes, controller };
}

test('prompt host controller ignores the initial jumpserver prompt', () => {
  const { changes, controller } = createHarness();
  controller.handleTerminalOutput('ssh-1', 'Last login\r\n[root@jump.example.com ~]# ');
  assert.deepEqual(changes, []);
});

test('prompt host controller publishes a nested target and de-duplicates it', () => {
  const { changes, controller } = createHarness();
  controller.handleTerminalOutput('ssh-1', '[root@jump.example.com ~]# ');
  controller.handleTerminalOutput('ssh-1', 'ssh root@10.1.64.1\r\n[root@10.1.64.1 ~]# ');
  controller.handleTerminalOutput('ssh-1', '\r\n[root@10.1.64.1 ~]# ');
  assert.deepEqual(changes, [['ssh-1', '10.1.64.1']]);
});

test('prompt host controller clears the override when returning to the jumpserver', () => {
  const { changes, controller } = createHarness();
  controller.handleTerminalOutput('ssh-1', '[root@jump.example.com ~]# ');
  controller.handleTerminalOutput('ssh-1', '\r\n[root@10.1.64.1 ~]# ');
  controller.handleTerminalOutput('ssh-1', 'exit\r\n[root@jump.example.com ~]# ');
  assert.deepEqual(changes, [
    ['ssh-1', '10.1.64.1'],
    ['ssh-1', null],
  ]);
});

test('prompt host controller detects an identity split across output chunks', () => {
  const { changes, controller } = createHarness();
  controller.handleTerminalOutput('ssh-1', '[root@jump.example.com ~]# ');
  controller.handleTerminalOutput('ssh-1', 'ssh target\r\n[root@10.1.');
  controller.handleTerminalOutput('ssh-1', '64.1 ~]# ');
  assert.deepEqual(changes, [['ssh-1', '10.1.64.1']]);
});

test('prompt host controller ignores ambiguous, sensitive, and local output', () => {
  const { changes, controller } = createHarness();
  controller.handleTerminalOutput('ssh-1', '[root@jump.example.com ~]# ');
  controller.handleTerminalOutput('ssh-1', 'Password:\n# ');
  controller.handleTerminalOutput('ssh-1', 'copied output\n# ');
  controller.handleTerminalOutput('local-1', '[root@10.1.64.1 ~]# ');
  assert.deepEqual(changes, []);
});
