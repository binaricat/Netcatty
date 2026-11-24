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

test('prompt host controller ignores host-like text embedded in copied output', () => {
  const { changes, controller } = createHarness();
  controller.handleTerminalOutput('ssh-1', '[root@jump.example.com ~]# ');
  controller.handleTerminalOutput('ssh-1', 'see [root@prod] logs\n# ');
  controller.handleTerminalOutput('ssh-1', '[root@prod] copied output\n# ');
  controller.handleTerminalOutput('ssh-1', 'root@prod output\n# ');
  controller.handleTerminalOutput('ssh-1', '[root@prod] version = 1.2\n# ');
  assert.deepEqual(changes, []);
});

test('prompt host controller publishes common zsh, Alpine, and macOS root prompt hosts', () => {
  for (const [prompt, hostname] of [
    ['alice@target-a ~ % ', 'target-a'],
    ['alice@target-b ~ # ', 'target-b'],
    ['target-c:~# ', 'target-c'],
    ['target-d:~ root# ', 'target-d'],
  ]) {
    const { changes, controller } = createHarness();
    controller.handleTerminalOutput('ssh-1', prompt);
    assert.deepEqual(changes, [['ssh-1', hostname]]);
  }
});

test('prompt host controller clears live target host when JumpServer returns to its menu', () => {
  for (const menuPrompt of ['Opt> ', '[Host]> ', '\x1b[32mOpt> \x1b[0m']) {
    const { changes, controller } = createHarness();
    // Initial menu before jumping emits nothing.
    controller.handleTerminalOutput('ssh-1', `Welcome to JumpServer\r\n${menuPrompt}`);
    // Jump into target host (including repeated CR+EL redraws).
    controller.handleTerminalOutput(
      'ssh-1',
      '11\r\nLast login: Mon Nov 23 16:01:46 2026\r\n[root@k8s-10-1-64-1 ~] br0 = 10.1.64.1\r\r\n# \r\x1b[K# ',
    );
    // Exiting back to JumpServer menu clears the published target hostname.
    controller.handleTerminalOutput('ssh-1', `exit\r\nlogout\r\nConnection closed.\r\n${menuPrompt}`);
    // Repeating menu prompt does not emit duplicate null updates.
    controller.handleTerminalOutput('ssh-1', `\r\n${menuPrompt}`);
    // Jumping to a second target publishes the new host.
    controller.handleTerminalOutput('ssh-1', '12\r\n[root@app-prod-02 ~]# ');

    assert.deepEqual(
      changes,
      [
        ['ssh-1', 'k8s-10-1-64-1'],
        ['ssh-1', null],
        ['ssh-1', 'app-prod-02'],
      ],
      JSON.stringify(menuPrompt),
    );
  }
});

test('prompt host controller forgets closed sessions when pruned', () => {
  const { changes, controller } = createHarness();
  controller.handleTerminalOutput('ssh-1', '[root@app-prod-01 ~]# ');
  controller.forgetSession('ssh-1');
  controller.handleTerminalOutput('ssh-1', '[root@app-prod-01 ~]# ');
  assert.deepEqual(changes, [
    ['ssh-1', 'app-prod-01'],
    ['ssh-1', 'app-prod-01'],
  ]);
});
