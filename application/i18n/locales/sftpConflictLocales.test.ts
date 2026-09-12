import test from 'node:test';
import assert from 'node:assert/strict';

import { enVaultMessages } from './en/vault.ts';
import { esVaultMessages } from './es/vault.ts';
import { ruVaultMessages } from './ru/vault.ts';
import { zhCNVaultMessages } from './zh-CN/vault.ts';
import { zhTWVaultMessages } from './zh-TW/vault.ts';

const FOLDER_CONFLICT_KEYS = [
  'sftp.conflict.folderTitle',
  'sftp.conflict.folderDesc',
  'sftp.conflict.folderFileDesc',
  'sftp.conflict.folderSymlinkDesc',
  'sftp.conflict.folderUnknownDesc',
  'sftp.conflict.folderMergeHint',
  'sftp.conflict.folderReplaceWarning',
] as const;

test('folder conflict safety copy exists in every supported locale', () => {
  const locales = {
    en: enVaultMessages,
    es: esVaultMessages,
    ru: ruVaultMessages,
    'zh-CN': zhCNVaultMessages,
    'zh-TW': zhTWVaultMessages,
  };

  for (const [locale, messages] of Object.entries(locales)) {
    for (const key of FOLDER_CONFLICT_KEYS) {
      assert.equal(typeof messages[key], 'string', `${locale} is missing ${key}`);
      assert.notEqual(messages[key]?.trim(), '', `${locale} has an empty ${key}`);
    }
  }
});
