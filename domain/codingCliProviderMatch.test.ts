import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getCodingCliCommandBasename,
  matchCodingCliProviderFromCommand,
  matchCodingCliProviderFromTitle,
  resolveSessionCodingCliProvider,
} from './codingCliProviderMatch';

test('getCodingCliCommandBasename extracts executable name from paths', () => {
  assert.equal(getCodingCliCommandBasename('/usr/local/bin/claude --resume abc'), 'claude');
  assert.equal(getCodingCliCommandBasename('codex.exe'), 'codex');
});

test('matchCodingCliProviderFromCommand resolves known CLIs', () => {
  assert.equal(matchCodingCliProviderFromCommand('opencode')?.id, 'opencode');
  assert.equal(matchCodingCliProviderFromCommand('droid')?.id, 'droid');
  assert.equal(matchCodingCliProviderFromCommand('factory')?.id, 'droid');
});

test('matchCodingCliProviderFromTitle detects Claude Code and Codex titles', () => {
  assert.equal(
    matchCodingCliProviderFromTitle('✳ Claude Code · refactor auth')?.id,
    'claude',
  );
  assert.equal(
    matchCodingCliProviderFromTitle('⠋ codex · my-project')?.id,
    'codex',
  );
  assert.equal(
    matchCodingCliProviderFromTitle('⠋ Working · netcatty')?.id,
    'codex',
  );
  assert.equal(
    matchCodingCliProviderFromTitle('Factory Droid · auth flow')?.id,
    'droid',
  );
  assert.equal(
    matchCodingCliProviderFromTitle('android@pixel:~'),
    undefined,
  );
});

test('resolveSessionCodingCliProvider detects providers from dynamic titles', () => {
  assert.equal(
    resolveSessionCodingCliProvider(
      { dynamicTitle: 'Claude Code' },
    )?.id,
    'claude',
  );
});

test('resolveSessionCodingCliProvider ignores dynamic title for renamed sessions', () => {
  assert.equal(
    resolveSessionCodingCliProvider({
      customName: 'Prod deploy',
      dynamicTitle: 'Claude Code',
    }),
    undefined,
  );
});

test('resolveSessionCodingCliProvider falls back to host startup command', () => {
  assert.equal(
    resolveSessionCodingCliProvider({}, { startupCommand: 'codex' })?.id,
    'codex',
  );
});

test('resolveSessionCodingCliProvider prefers sticky provider over launch command', () => {
  assert.equal(
    resolveSessionCodingCliProvider({
      codingCliProviderId: 'codex',
      startupCommand: 'droid',
    })?.id,
    'codex',
  );
});

test('resolveSessionCodingCliProvider keeps sticky provider when title is only a project name', () => {
  assert.equal(
    resolveSessionCodingCliProvider({
      codingCliProviderId: 'codex',
      dynamicTitle: 'netcatty',
    })?.id,
    'codex',
  );
});
