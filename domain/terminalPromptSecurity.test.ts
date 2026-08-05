import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendTerminalPromptSecurityTail,
  isConfirmedTerminalShellPrompt,
  isSensitiveTerminalChallenge,
  isUntrustedTerminalInputPrompt,
  shouldUsePluginTerminalCompletionProvider,
} from './terminalPromptSecurity.ts';

test('terminal prompt security recognizes password, MFA, OTP, PIN, and CJK challenges', () => {
  const challenges = [
    'Password: ',
    'Enter passphrase> ',
    'OTP> 123456',
    'One-time password: 123456',
    'Verification code> 123456',
    'Duo passcode: 123456',
    'MFA token: 123456',
    'Authentication code: 123456',
    'Security PIN: 123456',
    '验证码> 123456',
    '动态口令：123456',
    '二次认证密码：123456',
  ];
  for (const challenge of challenges) {
    assert.equal(isSensitiveTerminalChallenge(challenge), true, challenge);
  }
  assert.equal(isSensitiveTerminalChallenge('password authentication succeeded'), false);
  assert.equal(isSensitiveTerminalChallenge('echo OTP'), false);
});

test('terminal prompt security combines split output chunks within a bounded logical line', () => {
  let tail = appendTerminalPromptSecurityTail('', '\u001b[33mVerifi');
  tail = appendTerminalPromptSecurityTail(tail, 'cation code\u001b[0m> ');
  assert.equal(isSensitiveTerminalChallenge(tail), true);
  tail = appendTerminalPromptSecurityTail(tail, '\r\nuser@host:~$ ');
  assert.equal(isSensitiveTerminalChallenge(tail), false);
  assert.ok(tail.length <= 2_048);
});

test('terminal prompt security positively confirms shell prompts and fails closed on ambiguous prompts', () => {
  const confirmed = [
    '$ ',
    'root# ',
    'user@host:~/repo$ ',
    '➜  ~/repo ',
    '\uE0B0 ',
    'PS C:\\Users\\alice> ',
    'C:\\Users\\alice> ',
    'user@host> ',
  ];
  for (const prompt of confirmed) {
    assert.equal(isConfirmedTerminalShellPrompt(prompt), true, prompt);
  }
  assert.equal(isConfirmedTerminalShellPrompt('OTP> '), false);
  assert.equal(isConfirmedTerminalShellPrompt('custom> '), false);
  assert.equal(isConfirmedTerminalShellPrompt('router> ', { allowHostStyleGreaterThan: true }), true);
});

test('plugin terminal completion policy requires a non-sensitive confirmed shell prompt', () => {
  assert.equal(shouldUsePluginTerminalCompletionProvider({
    sensitiveInputActive: false,
    promptText: 'user@host:~$ ',
  }), true);
  assert.equal(shouldUsePluginTerminalCompletionProvider({
    sensitiveInputActive: true,
    promptText: 'user@host:~$ ',
  }), false);
  assert.equal(shouldUsePluginTerminalCompletionProvider({
    sensitiveInputActive: false,
    promptText: 'OTP> ',
  }), false);
  assert.equal(shouldUsePluginTerminalCompletionProvider({
    sensitiveInputActive: false,
    promptText: 'custom> ',
  }), false);
});

test('unknown prompt-shaped authentication boundaries fail closed', () => {
  assert.equal(isUntrustedTerminalInputPrompt('Custom authentication> '), true);
  assert.equal(isUntrustedTerminalInputPrompt('Please authenticate: '), true);
  assert.equal(isUntrustedTerminalInputPrompt('alice@host:~$ '), false);
  assert.equal(isUntrustedTerminalInputPrompt('router> ', { allowHostStyleGreaterThan: true }), false);
  assert.equal(isUntrustedTerminalInputPrompt('router> '), true);
});

test('ordinary shell commands ending with a colon are not untrusted input prompts (#2709)', () => {
  // Broadcast pauses while passwordPromptActive is sticky. Typing `lsof -i:`
  // must not trip the fail-closed colon heuristic, or peers miss the rest.
  const commandLines = [
    'user@host:~$ lsof -i:',
    'bash-5.2$ lsof -i:',
    'root# lsof -i:',
    'PS C:\\Users\\alice> lsof -i:',
    'C:\\Users\\alice> lsof -i:',
  ];
  for (const line of commandLines) {
    assert.equal(isUntrustedTerminalInputPrompt(line), false, line);
  }
  assert.equal(
    isUntrustedTerminalInputPrompt('router> show ip:', { allowHostStyleGreaterThan: true }),
    false,
  );
  // Bare host-style prompts stay fail-closed unless explicitly allowed.
  assert.equal(isUntrustedTerminalInputPrompt('router> show ip:'), true);
  // Mid-label `#` is not a prompt boundary (no whitespace after `#`).
  assert.equal(isUntrustedTerminalInputPrompt('Challenge #1:'), true);
  // Markers inside English challenge labels must not look like a shell PS1.
  assert.equal(isUntrustedTerminalInputPrompt('Challenge # 1:'), true);
  assert.equal(isUntrustedTerminalInputPrompt('Account $ code:'), true);
  // Standalone auth-shaped lines without a confirmed shell prompt still fail closed.
  assert.equal(isUntrustedTerminalInputPrompt('Please authenticate: '), true);
  assert.equal(isUntrustedTerminalInputPrompt('Token: '), true);
  assert.equal(isUntrustedTerminalInputPrompt('Password: '), true);
});
