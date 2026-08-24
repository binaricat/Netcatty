import test from 'node:test';
import assert from 'node:assert/strict';

import en from '../locales/en.ts';
import ru from '../locales/ru.ts';
import es from '../locales/es.ts';
import zhCN from '../locales/zh-CN.ts';
import zhTW from '../locales/zh-TW.ts';

const keys = [
  'cloudSync.convergent.title',
  'cloudSync.convergent.experimental',
  'cloudSync.convergent.desc',
  'cloudSync.convergent.active',
  'cloudSync.convergent.paused',
  'cloudSync.convergent.enabled',
  'cloudSync.convergent.preview.title',
  'cloudSync.convergent.preview.entities',
  'cloudSync.convergent.preview.providers',
  'cloudSync.convergent.preview.conflicts',
  'cloudSync.convergent.preview.compatibility',
  'cloudSync.convergent.preview.confirm',
  'cloudSync.convergent.preview.status.ready',
  'cloudSync.convergent.preview.status.empty',
  'cloudSync.convergent.preview.status.unavailable',
  'cloudSync.convergent.preview.status.blocked',
  'cloudSync.convergent.preview.schema',
  'cloudSync.convergent.field.presence',
  'cloudSync.convergent.field.position',
  'cloudSync.convergent.conflicts.title',
  'cloudSync.convergent.conflict.empty',
  'cloudSync.convergent.conflict.secretSet',
  'cloudSync.convergent.conflict.current',
  'cloudSync.convergent.conflict.choose',
  'cloudSync.convergent.conflict.resolved',
  'cloudSync.convergent.downgrade.desc',
  'cloudSync.convergent.downgrade.button',
  'cloudSync.convergent.downgrade.confirm',
  'cloudSync.convergent.downgrade.done',
] as const;

test('convergent sync copy exists in every bundled locale', () => {
  for (const [locale, messages] of Object.entries({ en, ru, es, zhCN, zhTW })) {
    for (const key of keys) {
      assert.equal(typeof messages[key], 'string', `${locale} is missing ${key}`);
      assert.notEqual(messages[key], '', `${locale} has empty ${key}`);
    }
  }
});
