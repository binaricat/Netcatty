import assert from 'node:assert/strict';
import test from 'node:test';

import en from './en.ts';
import ru from './ru.ts';
import es from './es.ts';
import zhCN from './zh-CN.ts';
import zhTW from './zh-TW.ts';

const UNDO_KEYS = [
  'ai.chat.undoLastTurn',
  'ai.chat.undoLastTurnNotice',
] as const;

test('Undo-last-turn UI is localized in every supported locale', () => {
  for (const [name, messages] of Object.entries({ en, es, 'zh-CN': zhCN, 'zh-TW': zhTW, ru })) {
    const missing = UNDO_KEYS.filter(key => !messages[key]);
    assert.deepEqual(missing, [], `${name} is missing undo-last-turn labels`);
  }
});
