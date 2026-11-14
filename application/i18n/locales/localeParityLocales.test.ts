import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_KEY_BINDINGS } from "../../../domain/models/keyBindings.ts";
import en from "./en.ts";
import es from "./es.ts";
import ru from "./ru.ts";
import zhCN from "./zh-CN.ts";
import zhTW from "./zh-TW.ts";

// Locales that are not at full key parity with `en` yet. They are tracked here
// so the remaining debt stays visible instead of silently rendering in English
// through the `DEFAULT_UI_LOCALE` fallback in `I18nProvider.resolveMessage`.
// Move a locale out of this list once it covers every `en` key.
const LOCALES_PENDING_PARITY = ["ru"] as const;

const hasKey = (messages: Record<string, string>, key: string) =>
  Object.hasOwn(messages, key);

const interpolationTokens = (value: string) =>
  [...value.matchAll(/\{\{\s*[^}]+\s*\}\}|\{\s*\w+\s*\}/g)]
    .map((match) => match[0].replace(/[{}]/g, "").trim())
    .sort();

test("interpolationTokens reads the :default placeholder form", () => {
  assert.deepEqual(interpolationTokens("{{name}} or {{name:default}}"), [
    "name",
    "name:default",
  ]);
});

test("es defines every message key that en defines", () => {
  const missing = Object.keys(en).filter((key) => !hasKey(es, key));

  assert.deepEqual(
    missing,
    [],
    `es is missing ${missing.length} message keys`,
  );
});

test("es defines no message keys that en does not define", () => {
  const extra = Object.keys(es).filter((key) => !hasKey(en, key));

  assert.deepEqual(
    extra,
    [],
    `es defines ${extra.length} keys that no longer exist in en`,
  );
});

test("every translated locale keeps the same interpolation placeholders as en", () => {
  const locales = [
    { name: "es", messages: es },
    { name: "ru", messages: ru },
    { name: "zh-CN", messages: zhCN },
    { name: "zh-TW", messages: zhTW },
  ];

  for (const locale of locales) {
    const mismatched: string[] = [];

    for (const key of Object.keys(locale.messages)) {
      if (!hasKey(en, key)) continue;

      const expected = interpolationTokens(en[key] ?? "").join(",");
      const actual = interpolationTokens(locale.messages[key] ?? "").join(",");
      if (expected !== actual) mismatched.push(key);
    }

    assert.deepEqual(
      mismatched,
      [],
      `${locale.name} changes interpolation placeholders for ${mismatched.length} keys`,
    );
  }
});

test("every default shortcut has a label in en and es", () => {
  const locales = [
    { name: "en", messages: en },
    { name: "es", messages: es },
  ];

  for (const locale of locales) {
    const missing = DEFAULT_KEY_BINDINGS.map(
      (binding) => `settings.shortcuts.binding.${binding.id}`,
    ).filter((key) => !hasKey(locale.messages, key));

    assert.deepEqual(
      missing,
      [],
      `${locale.name} is missing ${missing.length} shortcut labels`,
    );
  }
});

test("en shortcut labels stay identical to DEFAULT_KEY_BINDINGS", () => {
  // SettingsShortcutsTab falls back to `binding.label` only while the locale
  // resolves the key to itself. Once `en` defines the key, the locale becomes
  // the rendered source, so the two must not drift apart.
  for (const binding of DEFAULT_KEY_BINDINGS) {
    const key = `settings.shortcuts.binding.${binding.id}`;

    assert.equal(
      en[key],
      binding.label,
      `en label drifted from DEFAULT_KEY_BINDINGS for ${binding.id}`,
    );
  }
});

test("every locale outside the pending list is at full parity with en", () => {
  const locales = [
    { name: "es", messages: es },
    { name: "ru", messages: ru },
    { name: "zh-CN", messages: zhCN },
    { name: "zh-TW", messages: zhTW },
  ];

  for (const locale of locales) {
    if ((LOCALES_PENDING_PARITY as readonly string[]).includes(locale.name)) {
      continue;
    }

    const missing = Object.keys(en).filter(
      (key) => !hasKey(locale.messages, key),
    );

    assert.deepEqual(
      missing,
      [],
      `${locale.name} is missing ${missing.length} message keys`,
    );
  }
});
