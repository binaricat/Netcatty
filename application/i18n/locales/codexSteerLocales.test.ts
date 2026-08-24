import assert from 'node:assert/strict';
import test from 'node:test';

import en from './en.ts';
import ru from './ru.ts';
import es from './es.ts';
import zhCN from './zh-CN.ts';
import zhTW from './zh-TW.ts';

const STEER_KEYS = [
  'ai.codex.steer.addInstruction',
  'ai.codex.steer.sending',
  'ai.codex.steer.placeholder',
  'ai.codex.steer.notSteerableReview',
  'ai.codex.steer.notSteerableCompact',
  'ai.codex.steer.busy',
  'ai.codex.steer.inactive',
  'ai.codex.steer.unsupported',
  'ai.codex.steer.failed',
] as const;

test('Codex steering UI is localized in every supported locale', () => {
  for (const [name, messages] of Object.entries({ en, es, 'zh-CN': zhCN, 'zh-TW': zhTW, ru })) {
    const missing = STEER_KEYS.filter(key => !messages[key]);
    assert.deepEqual(missing, [], `${name} is missing Codex steering labels`);
  }
});
