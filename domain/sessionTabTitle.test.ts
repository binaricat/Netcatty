import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getSessionConnectionLabel,
  resolveCodingCliProviderIconUpdate,
  resolveSessionTabTitle,
  shouldUpdateCodingCliTabIcon,
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

test('coding CLI icon updates stop without clearing the current icon when dynamic titles are off', () => {
  assert.equal(shouldUpdateCodingCliTabIcon('off'), false);
  assert.equal(shouldUpdateCodingCliTabIcon('agent'), true);
  assert.equal(shouldUpdateCodingCliTabIcon('all'), true);

  assert.equal(resolveCodingCliProviderIconUpdate({
    dynamicTabTitleMode: 'off',
    currentProviderId: 'claude',
    nextProviderId: null,
  }), undefined);
  assert.equal(resolveCodingCliProviderIconUpdate({
    dynamicTabTitleMode: 'off',
    currentProviderId: 'claude',
    nextProviderId: 'opencode',
  }), undefined);
  assert.equal(resolveCodingCliProviderIconUpdate({
    dynamicTabTitleMode: 'agent',
    currentProviderId: 'claude',
    nextProviderId: null,
  }), null);
});
