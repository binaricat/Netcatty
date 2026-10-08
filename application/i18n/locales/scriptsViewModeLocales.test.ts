import assert from 'node:assert/strict';
import test from 'node:test';

import en from './en.ts';
import ru from './ru.ts';
import es from './es.ts';
import zhCN from './zh-CN.ts';
import zhTW from './zh-TW.ts';

test('scripts side panel view-toggle copy exists in every locale', () => {
  const KEYS = ['scripts.sidePanel.viewList', 'scripts.sidePanel.viewStacked'];
  for (const [locale, messages] of Object.entries({ en, ru, es, zhCN, zhTW })) {
    const missing = KEYS.filter((key) => !(messages as Record<string, string>)[key]);
    assert.deepEqual(missing, [], `${locale} is missing scripts view-toggle copy`);
  }
});