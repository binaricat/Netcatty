import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inferCodingCliProviderFromTitleSignals,
  normalizeCodingCliDynamicTitleForStorage,
  normalizeCodingCliTitle,
  resolveCodingCliActivityPhase,
  shouldClearCodingCliProviderForTitle,
  titleHasBrailleSpinner,
  titleIncludesPhrase,
} from './codingCliTitleParse';

test('inferCodingCliProviderFromTitleSignals detects Claude and Codex titles', () => {
  assert.equal(inferCodingCliProviderFromTitleSignals('✳ Claude Code · refactor auth'), 'claude');
  assert.equal(inferCodingCliProviderFromTitleSignals('⠋ codex · my-project'), 'codex');
  assert.equal(inferCodingCliProviderFromTitleSignals('⠋ Working · netcatty'), 'codex');
});

test('inferCodingCliProviderFromTitleSignals detects Droid and Factory titles', () => {
  assert.equal(inferCodingCliProviderFromTitleSignals('Factory Droid · auth flow'), 'droid');
  assert.equal(inferCodingCliProviderFromTitleSignals('droid · session'), 'droid');
});

test('inferCodingCliProviderFromTitleSignals ignores provider names inside longer words', () => {
  assert.equal(inferCodingCliProviderFromTitleSignals('android@pixel:~'), undefined);
  assert.equal(inferCodingCliProviderFromTitleSignals('myopencodetooling'), undefined);
});

test('resolveCodingCliActivityPhase treats spinner titles as busy', () => {
  assert.equal(
    resolveCodingCliActivityPhase('⠋ netcatty', 'codex'),
    'busy',
  );
  assert.equal(
    resolveCodingCliActivityPhase('netcatty', 'codex'),
    'idle',
  );
});

test('resolveCodingCliActivityPhase detects waiting states', () => {
  assert.equal(
    resolveCodingCliActivityPhase('Claude Code · waiting for approval', 'claude'),
    'waiting',
  );
});

test('normalizeCodingCliTitle strips action-required and dot prefixes', () => {
  assert.equal(normalizeCodingCliTitle('[ ! ] Action Required · deploy'), 'deploy');
  assert.equal(normalizeCodingCliTitle('··· my task'), 'my task');
  assert.equal(normalizeCodingCliTitle('∴ hello'), '∴ hello');
});

test('normalizeCodingCliDynamicTitleForStorage stabilizes spinner-only title changes', () => {
  assert.equal(normalizeCodingCliDynamicTitleForStorage('⠋ Droid'), 'Droid');
  assert.equal(normalizeCodingCliDynamicTitleForStorage('⠙ Droid'), 'Droid');
  assert.equal(normalizeCodingCliDynamicTitleForStorage('[ ! ] Action Required · deploy'), '[ ! ] Action Required · deploy');
});

test('titleIncludesPhrase requires phrase boundaries', () => {
  assert.equal(titleIncludesPhrase('Factory Droid · auth flow', 'droid'), true);
  assert.equal(titleIncludesPhrase('android@pixel:~', 'droid'), false);
});

test('shouldClearCodingCliProviderForTitle clears on shell titles only', () => {
  assert.equal(shouldClearCodingCliProviderForTitle('zsh', 'codex'), true);
  assert.equal(shouldClearCodingCliProviderForTitle('user@host:~/repo', 'codex'), true);
  assert.equal(shouldClearCodingCliProviderForTitle('user@host:/var/log', 'codex'), true);
  assert.equal(shouldClearCodingCliProviderForTitle('host:~/repo', 'codex'), true);
  assert.equal(shouldClearCodingCliProviderForTitle('/Users/alice/project', 'codex'), true);
  assert.equal(shouldClearCodingCliProviderForTitle('C:\\Users\\alice\\project', 'codex'), true);
  assert.equal(shouldClearCodingCliProviderForTitle('netcatty', 'codex'), false);
  assert.equal(shouldClearCodingCliProviderForTitle('netcatty: refactor', 'codex'), false);
  assert.equal(shouldClearCodingCliProviderForTitle('⠋ Working · netcatty', 'codex'), false);
  assert.equal(shouldClearCodingCliProviderForTitle('', 'codex'), true);
});

test('titleHasBrailleSpinner recognizes Codex frames', () => {
  assert.equal(titleHasBrailleSpinner('⠇ my-app'), true);
  assert.equal(titleHasBrailleSpinner('my-app'), false);
});
