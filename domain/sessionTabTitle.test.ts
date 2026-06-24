import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getSessionConnectionLabel,
  isDynamicTabTitleDisabled,
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

test('resolveSessionTabTitle uses dynamic title by default', () => {
  assert.equal(
    resolveSessionTabTitle(
      { hostLabel: 'web-01', dynamicTitle: 'claude: refactor auth' },
      undefined,
    ),
    'claude: refactor auth',
  );
});

test('resolveSessionTabTitle falls back to connection label when dynamic title is empty', () => {
  assert.equal(
    resolveSessionTabTitle({ hostLabel: 'web-01', dynamicTitle: '   ' }, undefined),
    'web-01',
  );
});

test('resolveSessionTabTitle prefers user customName over dynamic title', () => {
  assert.equal(
    resolveSessionTabTitle(
      { customName: 'Prod deploy', hostLabel: 'web-01', dynamicTitle: 'claude: refactor auth' },
      undefined,
    ),
    'Prod deploy',
  );
});

test('resolveSessionTabTitle honors disableDynamicTabTitle host setting', () => {
  assert.equal(
    resolveSessionTabTitle(
      { hostLabel: 'web-01', dynamicTitle: 'user@host:/var/log' },
      { disableDynamicTabTitle: true },
    ),
    'web-01',
  );
});

test('resolveSessionTabTitle strips agent spinner prefixes from dynamic titles', () => {
  assert.equal(
    resolveSessionTabTitle(
      { hostLabel: 'web-01', dynamicTitle: '⠋ Droid' },
      undefined,
    ),
    'Droid',
  );
});

test('isDynamicTabTitleDisabled is false unless explicitly enabled', () => {
  assert.equal(isDynamicTabTitleDisabled(undefined), false);
  assert.equal(isDynamicTabTitleDisabled({}), false);
  assert.equal(isDynamicTabTitleDisabled({ disableDynamicTabTitle: true }), true);
});
