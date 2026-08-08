import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../../application/i18n/I18nProvider.tsx";
import { SettingsFocusProvider } from "./SettingsFocusContext.tsx";
import { SettingsSearchControl } from "./SettingsSearchControl.tsx";

test("SettingsSearchControl collapsed state shows search open button", () => {
  const html = renderToStaticMarkup(
    <I18nProvider locale="en">
      <SettingsFocusProvider>
        <SettingsSearchControl />
      </SettingsFocusProvider>
    </I18nProvider>,
  );
  assert.match(html, /id="settings-search-open"/);
  assert.match(html, /Search settings/);
});
