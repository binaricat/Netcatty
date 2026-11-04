import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getBaseFallbackLocale,
  getLoadedLocaleMessages,
  getLocaleMessagesVersion,
  loadLocaleMessages,
  subscribeLocaleMessages,
} from '../messages';

test('only English is loaded until another locale is requested', () => {
  assert.ok(getLoadedLocaleMessages('en'));
  assert.equal(getLoadedLocaleMessages('ru'), undefined);
});

test('zh-TW resolves through zh-CN, matching the old static lookup order', () => {
  assert.equal(getBaseFallbackLocale('zh-TW'), 'zh-CN');
  assert.equal(getBaseFallbackLocale('zh-CN'), 'zh-CN');
  assert.equal(getBaseFallbackLocale('es'), 'es');
  assert.equal(getBaseFallbackLocale('fr'), undefined);
});

test('loading a locale also loads its fallback and notifies subscribers once each', async () => {
  const before = getLocaleMessagesVersion();
  let notified = 0;
  const unsubscribe = subscribeLocaleMessages(() => { notified += 1; });
  await Promise.all([loadLocaleMessages('zh-TW'), loadLocaleMessages('zh-TW')]);
  unsubscribe();
  assert.ok(getLoadedLocaleMessages('zh-TW'));
  assert.ok(getLoadedLocaleMessages('zh-CN'), 'base fallback is loaded with zh-TW');
  assert.equal(notified, 2, 'one notification per newly loaded dictionary');
  assert.equal(getLocaleMessagesVersion(), before + 2);
  await loadLocaleMessages('zh-TW');
  assert.equal(getLocaleMessagesVersion(), before + 2, 'already loaded locales are not reloaded');
});
