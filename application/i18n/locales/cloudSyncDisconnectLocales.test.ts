import test from 'node:test';
import assert from 'node:assert/strict';

import en from '../locales/en.ts';
import ru from '../locales/ru.ts';
import es from '../locales/es.ts';
import zhCN from '../locales/zh-CN.ts';
import zhTW from '../locales/zh-TW.ts';

const keys = [
  'cloudSync.provider.disconnect',
  'cloudSync.provider.disconnect.confirmTitle',
  'cloudSync.provider.disconnect.confirmMessage',
  'cloudSync.provider.disconnect.confirmAction',
  'cloudSync.provider.disconnect.toastTitle',
  'cloudSync.provider.disconnect.cloudRemains',
  'cloudSync.provider.disconnect.failed',
] as const;

test('disconnect copy exists in every bundled locale', () => {
  for (const [locale, messages] of Object.entries({ en, ru, es, zhCN, zhTW })) {
    for (const key of keys) {
      assert.equal(typeof messages[key], 'string', `${locale} is missing ${key}`);
      assert.notEqual(messages[key], '', `${locale} has empty ${key}`);
    }
  }
});

test('disconnect confirm copy states that saved provider credentials are removed', () => {
  // The confirm dialog must explain the data consequence of disconnecting:
  // locally saved endpoint + credentials removal, not just "stops syncing".
  const expected = [
    [en, 'will be removed'],
    [es, 'eliminarán'],
    [ru, 'будут удалены'],
    [zhCN, '删除'],
    [zhTW, '刪除'],
  ] as const;
  for (const [messages, fragment] of expected) {
    assert.ok(
      (messages['cloudSync.provider.disconnect.confirmMessage'] as string).includes(fragment),
      `confirmMessage should mention credential removal: ${fragment}`,
    );
  }
});

test('disconnect toast copy explains the cloud copy is retained', () => {
  for (const [locale, messages] of Object.entries({ en, ru, es, zhCN, zhTW })) {
    assert.ok(
      (messages['cloudSync.provider.disconnect.cloudRemains'] as string).includes(
        '{name}',
      ),
      `${locale} cloudRemains hint should reference the provider name`,
    );
  }
});

test('disconnect copy distinguishes login cleanup from retained local data', () => {
  assert.match(en['cloudSync.provider.disconnect.confirmMessage'], /backup history and sync encryption password stay here/);
  assert.doesNotMatch(en['cloudSync.provider.disconnect.cloudRemains'], /change.*password/);
  for (const messages of [en, ru, es, zhCN, zhTW]) {
    assert.ok(messages['cloudSync.provider.disconnect.failed'].includes('{name}'));
  }
});
