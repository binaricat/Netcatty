import assert from 'node:assert/strict';
import test from 'node:test';
import { enAiMessages } from './en/ai';
import { esAiMessages } from './es/ai';
import { ruAiMessages } from './ru/ai';
import { zhCNAiMessages } from './zh-CN/ai';
import { zhTWAiMessages } from './zh-TW/ai';

for (const [locale, messages] of Object.entries({
  en: enAiMessages, es: esAiMessages, ru: ruAiMessages,
  'zh-CN': zhCNAiMessages, 'zh-TW': zhTWAiMessages,
})) {
  test(`${locale} translates the Catty iteration limit notice and Continue action`, () => {
    assert.ok(messages['ai.chat.iterationLimitReached']);
    assert.match(messages['ai.chat.iterationLimitReached'], /\{limit\}/);
    assert.ok(messages['ai.chat.continue']);
  });
}
