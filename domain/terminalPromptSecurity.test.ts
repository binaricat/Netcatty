import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendTerminalPromptSecurityTail,
  foldTerminalPromptSecurityOutput,
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

const vimChrome = '\x1b[?1049h~\x1b[2;1H~\x1b[24;1Hsmoke4107-broadcast\b';
const vimColon = '\x1b[?25l\x1b[24;1H\x1b[K\x1b[24;1H:\x1b[?25h';

test('prompt security folds real vim CUP/EL colon redraws without retaining chrome (#4107)', () => {
  // Try every transport boundary, including inside CUP and EL sequences.
  for (let split = 0; split <= vimColon.length; split++) {
    let state = foldTerminalPromptSecurityOutput({ origin: '', current: '' }, vimChrome);
    state = foldTerminalPromptSecurityOutput(state, vimColon.slice(0, split));
    state = foldTerminalPromptSecurityOutput(state, vimColon.slice(split));
    assert.equal(state.promptText, ':', `split at ${split}`);
    assert.equal(isUntrustedTerminalInputPrompt(state.promptText, { alternateScreen: true }), false);
    assert.equal(isUntrustedTerminalInputPrompt(state.promptText), true, 'primary colon stays protected');
  }
});

test('prompt security recognizes CUP/HVP column-one defaults and EL across chunks', () => {
  for (const position of ['H', 'f', '24H', '24f', '24;H', '24;f', '24;1H', '24;1f', ';1H', '24;0H']) {
    for (const erase of ['K', '1K', '2K']) {
      let state = foldTerminalPromptSecurityOutput({ origin: '', current: '' }, vimChrome);
      for (const chunk of ['\x1b[', position, '\x1b[', erase, ':']) {
        state = foldTerminalPromptSecurityOutput(state, chunk);
      }
      assert.equal(state.promptText, ':', `${position} + ${erase}`);
    }
  }
  const state = foldTerminalPromptSecurityOutput({ origin: '', current: 'Challenge' }, '\x1b[24;2H:');
  assert.equal(state.promptText, 'Challenge:', 'other columns must not discard a challenge label');
  assert.equal(isUntrustedTerminalInputPrompt(state.promptText, { alternateScreen: true }), true);
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

test('bash PS2 is trusted only while a heredoc continuation is open (#3796)', () => {
  // CentOS-7-style bash has no bracketed paste, so a heredoc paste echoes the
  // default PS2 "> " after each line. That must keep broadcast on.
  const heredocEcho = '[root@h ~]# cat >> f << EOF\r\n> ';
  assert.equal(isConfirmedTerminalShellPrompt(heredocEcho), true);
  assert.equal(isUntrustedTerminalInputPrompt(heredocEcho), false);
  const heredocBody = '[root@h ~]# cat >> f << EOF\r\n> echo madvise > /sys/kernel/mm/transparent_hugepage/enabled\r\n> ';
  assert.equal(isConfirmedTerminalShellPrompt(heredocBody), true);
  assert.equal(isUntrustedTerminalInputPrompt(heredocBody), false);
  // No preceding command, or an echo-disabled prompt labelled ">", fails closed.
  assert.equal(isConfirmedTerminalShellPrompt('>'), false);
  assert.equal(isConfirmedTerminalShellPrompt('> '), false);
  assert.equal(isUntrustedTerminalInputPrompt('>'), true);
  assert.equal(isUntrustedTerminalInputPrompt('> '), true);
  const secretPrompt = "[root@h ~]# read -s -p '> ' secret\r\n> ";
  assert.equal(isConfirmedTerminalShellPrompt(secretPrompt), false);
  assert.equal(isUntrustedTerminalInputPrompt(secretPrompt), true);
  // The echoed terminator line is ordinary output, not a prompt latch.
  assert.equal(isConfirmedTerminalShellPrompt('> EOF'), false);
  assert.equal(isUntrustedTerminalInputPrompt('> EOF'), false);
  // Labelled challenges stay fail-closed. zsh "heredoc>" is out of scope.
  assert.equal(isUntrustedTerminalInputPrompt('Custom>'), true);
  assert.equal(isUntrustedTerminalInputPrompt('Token>'), true);
  assert.equal(isUntrustedTerminalInputPrompt('Password:'), true);
  assert.equal(isConfirmedTerminalShellPrompt('Custom>'), false);
  assert.equal(isConfirmedTerminalShellPrompt('Token>'), false);
  assert.equal(isConfirmedTerminalShellPrompt('Password:'), false);
  assert.equal(isUntrustedTerminalInputPrompt('heredoc>'), true);
  assert.equal(isConfirmedTerminalShellPrompt('heredoc>'), false);
});

test('prompt observation keeps the heredoc opener and drops it after the shell returns (#3796)', () => {
  let state = { origin: '', current: '' };
  state = foldTerminalPromptSecurityOutput(state, '[root@h ~]# cat >> f << EOF\r\n');
  state = foldTerminalPromptSecurityOutput(state, '> echo madvise > /sys/kernel/mm/transparent_hugepage/enabled\r\n');
  state = foldTerminalPromptSecurityOutput(state, '> ');
  assert.equal(isConfirmedTerminalShellPrompt(state.promptText), true);
  assert.equal(isUntrustedTerminalInputPrompt(state.promptText), false);

  state = foldTerminalPromptSecurityOutput(state, "\r\n[root@h ~]# ");
  state = foldTerminalPromptSecurityOutput(state, '\r\n> ');
  assert.equal(isConfirmedTerminalShellPrompt(state.promptText), false);
  assert.equal(isUntrustedTerminalInputPrompt(state.promptText), true);

  state = { origin: '', current: '' };
  state = foldTerminalPromptSecurityOutput(state, "[root@h ~]# read -s -p '> ' secret\r\n");
  state = foldTerminalPromptSecurityOutput(state, '> ');
  assert.equal(isConfirmedTerminalShellPrompt(state.promptText), false);
  assert.equal(isUntrustedTerminalInputPrompt(state.promptText), true);

  state = foldTerminalPromptSecurityOutput({ origin: '', current: '' }, '> ');
  assert.equal(isUntrustedTerminalInputPrompt(state.promptText), true);
  assert.equal(isConfirmedTerminalShellPrompt(state.promptText), false);
});

test('prompt observation coalesces a CRLF split across chunks (#3796)', () => {
  let state = { origin: '', current: '' };
  state = foldTerminalPromptSecurityOutput(state, "[root@h ~]# cat >> f << EOF\r");
  state = foldTerminalPromptSecurityOutput(state, '\n> ');
  assert.equal(isConfirmedTerminalShellPrompt(state.promptText), true);
  assert.equal(isUntrustedTerminalInputPrompt(state.promptText), false);
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
    ['>', undefined, true],
    ['> ', undefined, true],
    ['[root@h ~]# cat >> f << EOF\r\n> ', undefined, false],
    ['[root@h ~]# cat >> f << EOF\r\n> echo madvise > /sys/kernel/mm/transparent_hugepage/enabled\r\n> ', undefined, false],
    ["[root@h ~]# read -s -p '> ' secret\r\n> ", undefined, true],
    ['Custom>', undefined, true],
    ['Token>', undefined, true],
    ['Password:', undefined, true],
  ];

  for (const [prompt, options, expected] of cases) {
    assert.equal(isUntrustedTerminalInputPrompt(prompt, options), expected, prompt);
    assert.equal(sharedPromptSecurity.isUntrustedTerminalInputPrompt(prompt, options), expected, prompt);
  }
});
