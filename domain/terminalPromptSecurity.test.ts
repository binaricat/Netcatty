import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendTerminalPromptSecurityTail,
  isConfirmedTerminalShellPrompt,
  isSensitiveTerminalChallenge,
  isUntrustedTerminalInputPrompt,
  shouldUsePluginTerminalCompletionProvider,
} from './terminalPromptSecurity.ts';

const require = createRequire(import.meta.url);
const sharedPromptSecurity = require('./terminalPromptSecurity.shared.cjs') as {
  isUntrustedTerminalInputPrompt: typeof isUntrustedTerminalInputPrompt;
};

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

test('vim ex command-line is not an untrusted input prompt (#3422)', () => {
  assert.equal(isUntrustedTerminalInputPrompt(':', { alternateScreen: true }), false);
  assert.equal(isUntrustedTerminalInputPrompt(': ', { alternateScreen: true }), false);
  // Primary screen: `sudo -p ':'` stays fail-closed.
  assert.equal(isUntrustedTerminalInputPrompt(':'), true);
  assert.equal(isUntrustedTerminalInputPrompt(':', { alternateScreen: false }), true);
  assert.equal(isUntrustedTerminalInputPrompt('Password:'), true);
  assert.equal(isUntrustedTerminalInputPrompt('Token: '), true);
});

test('renderer and main-process prompt classifiers stay aligned', () => {
  const cases: Array<[
    string,
    { allowHostStyleGreaterThan?: boolean } | undefined,
    boolean,
  ]> = [
    ['Custom authentication> ', undefined, true],
    ['Please authenticate: ', undefined, true],
    [':', { alternateScreen: true }, false],
    [':', undefined, true],
    ['alice@host:~$ ', undefined, false],
    ['user@host:~$ lsof -i:', undefined, false],
    ['Challenge # 1:', undefined, true],
    ['router> show ip:', { allowHostStyleGreaterThan: true }, false],
    ['router> show ip:', undefined, true],
  ];

  for (const [prompt, options, expected] of cases) {
    assert.equal(isUntrustedTerminalInputPrompt(prompt, options), expected, prompt);
    assert.equal(sharedPromptSecurity.isUntrustedTerminalInputPrompt(prompt, options), expected, prompt);
  }
});

test('Vim row-start cursor positioning separates the alternate-screen colon prompt', () => {
  // Captured from two real vim.tiny sessions in the native app: Vim moves to
  // column one of its command row instead of printing a newline before ':'.
  const renderedBody = '\u001b[?1049h-- INSERT --\u001b[1;1HCLEAN_VIM_MARKER';
  let tail = appendTerminalPromptSecurityTail('', renderedBody);
  tail = appendTerminalPromptSecurityTail(tail, '\u001b[51;');
  tail = appendTerminalPromptSecurityTail(tail, '1H:\u001b[?25h');
  for (const classify of [isUntrustedTerminalInputPrompt, sharedPromptSecurity.isUntrustedTerminalInputPrompt]) {
    assert.equal(classify(tail, { alternateScreen: true }), false);
    assert.equal(classify(tail, { alternateScreen: false }), true);
    for (const prompt of ['Password:', 'Token: ', 'Custom authentication> ']) {
      assert.equal(classify(`${renderedBody}\u001b[51;1H${prompt}`, { alternateScreen: true }), true, prompt);
    }
    // Moving within a label must not turn a real challenge into a bare colon.
    assert.equal(classify('Password\u001b[51;9H:', { alternateScreen: true }), true);
  }
});

test('alternate-screen row changes do not discard sensitive prompts in the same output chunk', () => {
  for (const classify of [isUntrustedTerminalInputPrompt, sharedPromptSecurity.isUntrustedTerminalInputPrompt]) {
    assert.equal(classify('\u001b[5;1HPassword:\u001b[24;1HReady', { alternateScreen: true }), true);
    assert.equal(classify('\u001b[5;1HToken:\u001b[24;1HReady', { alternateScreen: true }), true);
    for (const label of ['Password:', 'Token: ']) {
      for (const status of ['Ready', ':', 'alice@host:~$ ']) {
        const chunk = `\u001b[?1049h\u001b[5;1H${label}\u001b[24;1H${status}`;
        assert.equal(classify(chunk, { alternateScreen: true }), true, `${label} / ${status}`);
        assert.equal(classify(chunk, { alternateScreen: false }), true, `${label} / ${status}`);
      }
    }
    // Non-bare-colon classifications retain the original logical line.
    assert.equal(classify('Custom authentication>\u001b[24;1HReady', { alternateScreen: true }), false);
    assert.equal(classify('user@host:~$ lsof -i:\u001b[24;1Hmore:', { alternateScreen: true }), false);
  }
});
