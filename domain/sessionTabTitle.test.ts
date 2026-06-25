import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getSessionConnectionLabel,
  resolveSessionTabTitle,
} from './sessionTabTitle';

test('getSessionConnectionLabel prefers customName over hostLabel', () => {
  assert.equal(
    getSessionConnectionLabel({ customName: 'Prod', hostLabel: 'web-01' }),
    'Prod',
  );
  assert.equal(
    getSessionConnectionLabel({ hostLabel: 'web-01' }),
    'web-01',
  );
});

test('resolveSessionTabTitle ignores dynamic title for non-agent sessions', () => {
  assert.equal(
    resolveSessionTabTitle(
      { hostLabel: 'web-01', dynamicTitle: 'root@v2022:/var/log' },
    ),
    'web-01',
  );
});

test('resolveSessionTabTitle uses dynamic title for agent sessions', () => {
  assert.equal(
    resolveSessionTabTitle(
      { hostLabel: 'web-01', dynamicTitle: 'claude: refactor auth', codingCliProviderId: 'claude' },
    ),
    'claude: refactor auth',
  );
});

test('resolveSessionTabTitle uses dynamic title for all sessions in all mode', () => {
  assert.equal(
    resolveSessionTabTitle(
      { hostLabel: 'web-01', dynamicTitle: 'root@v2022:/var/log' },
      'all',
    ),
    'root@v2022:/var/log',
  );
});

test('resolveSessionTabTitle disables dynamic titles in off mode', () => {
  assert.equal(
    resolveSessionTabTitle(
      { hostLabel: 'web-01', dynamicTitle: 'claude: refactor auth', codingCliProviderId: 'claude' },
      'off',
    ),
    'web-01',
  );
});

test('resolveSessionTabTitle falls back to connection label when dynamic title is empty', () => {
  assert.equal(
    resolveSessionTabTitle({ hostLabel: 'web-01', dynamicTitle: '   ' }),
    'web-01',
  );
});

test('resolveSessionTabTitle prefers user customName over dynamic title', () => {
  assert.equal(
    resolveSessionTabTitle(
      { customName: 'Prod deploy', hostLabel: 'web-01', dynamicTitle: 'claude: refactor auth' },
    ),
    'Prod deploy',
  );
});

test('resolveSessionTabTitle strips agent spinner prefixes from dynamic titles', () => {
  assert.equal(
    resolveSessionTabTitle(
      { hostLabel: 'web-01', dynamicTitle: '⠋ Droid', codingCliProviderId: 'droid' },
    ),
    'Droid',
  );
});
