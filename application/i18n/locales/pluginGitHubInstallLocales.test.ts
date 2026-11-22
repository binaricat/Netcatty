import assert from 'node:assert/strict';
import test from 'node:test';
import { SUPPORTED_UI_LOCALES } from '../../../infrastructure/config/i18n';
import { getLoadedLocaleMessages, loadLocaleMessages } from '../messages';
import en from './en';
import { describePluginGitHubInstallError } from '../../../domain/pluginGitHubInstallError';

test('GitHub install copy and error interpolation are complete in every supported UI locale', async () => {
  const keys = Object.keys(en).filter(key => key.startsWith('settings.plugins.github.'));
  assert.ok(keys.length > 30);
  for (const { id } of SUPPORTED_UI_LOCALES) {
    await loadLocaleMessages(id);
    const messages = getLoadedLocaleMessages(id)!;
    for (const key of keys) {
      assert.ok(messages[key]?.trim(), `${id}: ${key}`);
      assert.deepEqual(messages[key].match(/\{\w+\}/g) ?? [], en[key].match(/\{\w+\}/g) ?? [], `${id}: ${key}`);
    }
  }
});

test('GitHub error presentation handles Electron wrappers, HTTP status and diagnostic fallback', () => {
  const expired = describePluginGitHubInstallError("Error invoking remote method 'plugins:github:install': Error: GitHub package preview expired. Download and review it again");
  assert.equal(expired.key, 'settings.plugins.github.error.expired');
  assert.equal(expired.details, null);
  assert.deepEqual(describePluginGitHubInstallError('GitHub download failed (HTTP 503)').values, { status: '503' });
  const validator = 'manifest version must be a semantic version';
  assert.equal(describePluginGitHubInstallError(validator).details, validator);
  assert.equal(describePluginGitHubInstallError(validator).key, 'settings.plugins.github.error.failed');
  assert.equal(describePluginGitHubInstallError('Plugin is incompatible: engine version').key, 'settings.plugins.github.error.incompatible');
});
