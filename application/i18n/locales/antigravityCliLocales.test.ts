import assert from 'node:assert/strict';
import test from 'node:test';

import { enAiMessages } from './en/ai';
import { ruAiMessages } from './ru/ai';
import { zhCNAiMessages } from './zh-CN/ai';
import { zhTWAiMessages } from './zh-TW/ai';

const AGY_KEYS = [
  'ai.antigravity.upgradeStatus',
  'ai.antigravity.upgradeRequired',
  'ai.antigravity.loginHint',
  'ai.antigravity.confirmHint',
  'ai.chat.permConfirmDesc',
  'ai.safety.permissionMode.description',
] as const;

test('Antigravity CLI guidance is localized in every supported locale', () => {
  for (const [name, messages] of Object.entries({
    en: enAiMessages,
    'zh-CN': zhCNAiMessages,
    'zh-TW': zhTWAiMessages,
    ru: ruAiMessages,
  })) {
    const missing = AGY_KEYS.filter((key) => !messages[key]);
    assert.deepEqual(missing, [], `${name} is missing Antigravity CLI guidance`);
  }
});
