import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '../../../application/i18n/I18nProvider';
import { PluginSettingField } from '../../plugins/PluginSettingsForm';

test('plugin setting cards retain localized descriptions alongside structured controls', () => {
  const setting = {
    id: 'com.example.timeout',
    label: 'Connection timeout',
    description: 'Maximum time to wait before cancelling the connection.',
    control: 'number',
    scope: 'application',
    scopeId: 'application',
    visible: true,
    value: 30,
  } as NetcattyPluginSettingContribution;
  const html = renderToStaticMarkup(
    <I18nProvider locale="en">
      <PluginSettingField
        pluginId="com.example"
        setting={setting}
        updateSetting={async () => ({ restartRequired: false })}
        resetSetting={async () => ({ restartRequired: false })}
        selectSettingPath={async () => null}
        availableFonts={[]}
      />
    </I18nProvider>,
  );

  assert.match(html, /Maximum time to wait before cancelling the connection\./u);
  assert.match(html, /aria-label="Connection timeout"/u);
});
