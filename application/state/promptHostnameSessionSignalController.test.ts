import assert from 'node:assert/strict';
import test from 'node:test';

import { createPromptHostnameSessionSignalController } from './promptHostnameSessionSignalController.ts';
import { extractTerminalPromptHostname } from '../../domain/terminalPromptSecurity';

type Change = readonly [sessionId: string, hostname: string | null];

const getSession = (sessionId: string) => (
  sessionId === 'ssh-1'
    ? { protocol: 'ssh' as const, hostname: 'jump.example.com' }
    : { protocol: 'local' as const, hostname: 'localhost' }
);

function createHarness() {
  const changes: Change[] = [];
  const nested: boolean[] = [];
  const controller = createPromptHostnameSessionSignalController({
    getSession,
    onChange: (sessionId, hostname, options) => {
      changes.push([sessionId, hostname]);
      nested.push(options?.fromJumpServer === true);
    },
  });
  return { changes, controller, nested };
}

test('prompt observations are independent of IP, alias, and matching connection addresses', () => {
  const prompt = '[root@vm-prod ~]# ';
  const observedHost = extractTerminalPromptHostname(prompt)!;
  for (const hostname of ['203.0.113.10', 'alias.example.test', observedHost]) {
    const changes: Change[] = [];
    const controller = createPromptHostnameSessionSignalController({
      getSession: () => ({ protocol: 'ssh', hostname }),
      onChange: (sessionId, host) => changes.push([sessionId, host]),
    });
    controller.handleTerminalOutput('ssh-1', prompt);
    assert.deepEqual(changes, [['ssh-1', observedHost]], hostname);
  }
});

test('forgetting a session permits the first matching-host prompt to publish again', () => {
  const { changes, controller } = createHarness();
  const prompt = '[root@jump.example.com ~]# ';
  const observedHost = extractTerminalPromptHostname(prompt)!;
  controller.handleTerminalOutput('ssh-1', prompt);
  controller.forgetSession('ssh-1');
  controller.handleTerminalOutput('ssh-1', prompt);
  assert.deepEqual(changes, [['ssh-1', observedHost], ['ssh-1', observedHost]]);
});

test('prompt host controller observes the initial jumpserver prompt', () => {
  const { changes, controller } = createHarness();
  controller.handleTerminalOutput('ssh-1', 'Last login\r\n[root@jump.example.com ~]# ');
  assert.deepEqual(changes, [['ssh-1', getSession('ssh-1').hostname]]);
});

test('prompt host controller publishes a nested target and de-duplicates it', () => {
  const { changes, controller, nested } = createHarness();
  controller.handleTerminalOutput('ssh-1', 'Welcome\r\nOpt> ');
  controller.handleTerminalOutput('ssh-1', 'ssh root@10.1.64.1\r\n[root@10.1.64.1 ~]# ');
  controller.handleTerminalOutput('ssh-1', '\r\n[root@10.1.64.1 ~]# ');
  assert.deepEqual(changes, [['ssh-1', '10.1.64.1']]);
  assert.deepEqual(nested, [true]);
});

test('prompt host controller marks ordinary direct prompts as non-jump hosts', () => {
  const { changes, controller, nested } = createHarness();
  controller.handleTerminalOutput('ssh-1', 'Last login\r\n[root@vm-prod ~]# ');
  assert.deepEqual(changes, [['ssh-1', 'vm-prod']]);
  assert.deepEqual(nested, [false]);
});

test('prompt host controller tracks a JumpServer menu split across chunks', () => {
  const { changes, controller, nested } = createHarness();
  controller.handleTerminalOutput('ssh-1', 'Welcome\r\nO');
  controller.handleTerminalOutput('ssh-1', 'pt> ');
  controller.handleTerminalOutput('ssh-1', '10.1.64.1\r\n[root@k8s-10-1-64-1 ~]# ');
  assert.deepEqual(changes, [['ssh-1', 'k8s-10-1-64-1']]);
  assert.deepEqual(nested, [true]);
});

test('prompt host controller detects ANSI-styled JumpServer menus and upgrades matching hostnames', () => {
  const { changes, controller, nested } = createHarness();
  controller.handleTerminalOutput('ssh-1', '[root@app-01 ~]# ');
  controller.handleTerminalOutput('ssh-1', 'ssh jump\r\n\x1b[32mOpt\x1b[0m> \r\n[root@app-01 ~]# ');
  assert.deepEqual(changes, [['ssh-1', 'app-01'], ['ssh-1', 'app-01']]);
  assert.deepEqual(nested, [false, true]);
});

test('prompt host controller detects consumed JumpServer prompts in coalesced output', () => {
  for (const coalesced of [
    'Welcome\r\nOpt> 42\r\n[root@target-01 ~]# ',
    'Welcome\r\n[Host]> 10.1.64.1\r\n[root@target-01 ~]# ',
    'Welcome\r\n\x1b[32mOpt> \x1b[0m42\r\n[root@target-01 ~]# ',
  ]) {
    const { changes, controller, nested } = createHarness();
    controller.handleTerminalOutput('ssh-1', coalesced);
    assert.deepEqual(changes, [['ssh-1', 'target-01']], JSON.stringify(coalesced));
    assert.deepEqual(nested, [true], JSON.stringify(coalesced));
  }

  // Also works when the consumed menu prompt is split across chunks.
  const { changes, controller, nested } = createHarness();
  controller.handleTerminalOutput('ssh-1', 'Welcome\r\nO');
  controller.handleTerminalOutput('ssh-1', 'pt> 42\r\n[root@target-02 ~]# ');
  assert.deepEqual(changes, [['ssh-1', 'target-02']]);
  assert.deepEqual(nested, [true]);
});

test('prompt host controller observes the original host when returning from a target', () => {
  const { changes, controller } = createHarness();
  controller.handleTerminalOutput('ssh-1', '[root@jump.example.com ~]# ');
  controller.handleTerminalOutput('ssh-1', '\r\n[root@10.1.64.1 ~]# ');
  controller.handleTerminalOutput('ssh-1', 'exit\r\n[root@jump.example.com ~]# ');
  assert.deepEqual(changes, [
    ['ssh-1', getSession('ssh-1').hostname],
    ['ssh-1', '10.1.64.1'],
    ['ssh-1', getSession('ssh-1').hostname],
  ]);
});

test('prompt host controller detects an identity split across output chunks', () => {
  const { changes, controller } = createHarness();
  controller.handleTerminalOutput('ssh-1', '[root@jump.example.com ~]# ');
  controller.handleTerminalOutput('ssh-1', 'ssh target\r\n[root@10.1.');
  controller.handleTerminalOutput('ssh-1', '64.1 ~]# ');
  assert.deepEqual(changes, [['ssh-1', getSession('ssh-1').hostname], ['ssh-1', '10.1.64.1']]);
});

test('prompt host controller ignores ambiguous, sensitive, and local output', () => {
  const { changes, controller } = createHarness();
  controller.handleTerminalOutput('ssh-1', '[root@jump.example.com ~]# ');
  const initialChanges = changes.slice();
  controller.handleTerminalOutput('ssh-1', 'Password:\n# ');
  controller.handleTerminalOutput('ssh-1', 'copied output\n# ');
  controller.handleTerminalOutput('local-1', '[root@10.1.64.1 ~]# ');
  assert.deepEqual(changes, initialChanges);
});

test('prompt host controller ignores host-like text embedded in copied output', () => {
  const { changes, controller } = createHarness();
  controller.handleTerminalOutput('ssh-1', '[root@jump.example.com ~]# ');
  const initialChanges = changes.slice();
  controller.handleTerminalOutput('ssh-1', 'see [root@prod] logs\n# ');
  controller.handleTerminalOutput('ssh-1', '[root@prod] copied output\n# ');
  controller.handleTerminalOutput('ssh-1', 'root@prod output\n# ');
  controller.handleTerminalOutput('ssh-1', '[root@prod] version = 1.2\n# ');
  assert.deepEqual(changes, initialChanges);
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
