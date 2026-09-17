import assert from 'node:assert/strict';
import test from 'node:test';

import en from './en.ts';
import ru from './ru.ts';
import es from './es.ts';
import zhCN from './zh-CN.ts';
import zhTW from './zh-TW.ts';

const KEYS = [
  'vault.groups.deleteDialog.managedDesc',
  'vault.groups.deleteDialog.mixedDesc',
  'vault.groups.deleteDialog.managedWarning',
  'vault.groups.deleteDialog.managedFile',
] as const;

test('managed group delete warning copy exists in every locale', () => {
  for (const [locale, messages] of Object.entries({ en, ru, es, zhCN, zhTW })) {
    const missing = KEYS.filter((key) => !messages[key]);
    assert.deepEqual(missing, [], `${locale} is missing managed group delete copy`);
  }
});

test('managed group delete warning mentions data loss in every locale', () => {
  const MARKERS = ['备份', '備份', 'copia de seguridad', 'резервную копию', 'Back up'];
  for (const [locale, messages] of Object.entries({ en, ru, es, zhCN, zhTW })) {
    const text = messages['vault.groups.deleteDialog.managedWarning'];
    assert.match(
      text ?? '',
      /SSH/,
      `${locale} warning should reference the SSH config file`,
    );
    assert.ok(
      MARKERS.some((marker) => text?.includes(marker)),
      `${locale} warning should tell the user to back up the file`,
    );
  }
});

test('linked file line interpolates the file path', () => {
  for (const messages of [en, ru, es, zhCN, zhTW]) {
    assert.match(
      messages['vault.groups.deleteDialog.managedFile'] ?? '',
      /\{file\}/,
      'managedFile copy should include the {file} placeholder',
    );
  }
});
