import assert from 'node:assert/strict';
import test from 'node:test';

import en from './en';
import ru from './ru';
import zhCN from './zh-CN';
import zhTW from './zh-TW';

const keys = [
  'terminal.layer.hostTree.newHost',
  'terminal.layer.hostTree.newHostInGroup',
  'terminal.layer.hostTree.editHost',
  'terminal.layer.hostTree.hostSavedNextConnection',
] as const;

test('terminal host management strings exist in every shipped locale', () => {
  for (const [locale, messages] of Object.entries({ en, 'zh-CN': zhCN, 'zh-TW': zhTW, ru })) {
    for (const key of keys) {
      assert.equal(typeof messages[key], 'string', `${locale} is missing ${key}`);
      assert.notEqual(messages[key], '', `${locale} has an empty ${key}`);
    }
  }
});
