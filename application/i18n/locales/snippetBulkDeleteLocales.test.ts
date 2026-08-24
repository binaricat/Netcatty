import assert from 'node:assert/strict';
import test from 'node:test';

import en from './en.ts';
import ru from './ru.ts';
import es from './es.ts';
import zhCN from './zh-CN.ts';
import zhTW from './zh-TW.ts';

const KEYS = [
  'snippets.selection.deleteSelected',
  'snippets.selection.deleteConfirmTitle',
  'snippets.selection.deleteConfirmDesc',
  'snippets.selection.deleteSuccess',
] as const;

test('snippet bulk-delete copy exists in every locale', () => {
  for (const [locale, messages] of Object.entries({ en, ru, es, zhCN, zhTW })) {
    const missing = KEYS.filter((key) => !messages[key]);
    assert.deepEqual(missing, [], `${locale} is missing snippet bulk-delete copy`);
  }
});

test('snippet shortkey system-conflict copy names the conflicting action', () => {
  for (const [locale, messages] of Object.entries({ en, ru, es, zhCN, zhTW })) {
    const text = messages['snippets.shortkey.error.systemConflict'];
    assert.match(
      text ?? '',
      /\{name\}/,
      `${locale} system-conflict copy should include {name}`,
    );
  }
});

test('English bulk-delete copy is entity-neutral and grammatical for one item', () => {
  assert.equal(
    en['snippets.selection.deleteConfirmTitle'].replace('{count}', '1'),
    'Delete selected items (1)?',
  );
  assert.equal(
    en['snippets.selection.deleteSuccess'].replace('{count}', '1'),
    'Deleted selected items: 1.',
  );
});
