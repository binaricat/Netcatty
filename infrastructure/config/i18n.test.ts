import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_UI_LOCALE,
  getSystemLocales,
  matchSupportedLocale,
  resolveDefaultUiLocale,
  resolveSupportedLocale,
} from "./i18n.ts";

test("explicit stored locale always wins over system locales", () => {
  assert.equal(resolveDefaultUiLocale("en", ["zh-CN", "zh-TW"]), "en");
  assert.equal(resolveDefaultUiLocale("zh-TW", ["en-US"]), "zh-TW");
  assert.equal(resolveDefaultUiLocale("zh-CN", ["es-MX"]), "zh-CN");
  assert.equal(resolveDefaultUiLocale("ru", ["zh-CN"]), "ru");
  assert.equal(resolveDefaultUiLocale("es", ["en-US"]), "es");
  assert.equal(resolveDefaultUiLocale("  en  ", ["zh-CN"]), "en");
});

test("stored unsupported locale falls back to DEFAULT_UI_LOCALE rather than overriding with system locale", () => {
  assert.equal(resolveDefaultUiLocale("fr-FR", ["zh-CN"]), DEFAULT_UI_LOCALE);
});

test("first launch maps Simplified Chinese system locales to zh-CN", () => {
  for (const tag of ["zh", "zh-CN", "zh-SG", "zh-Hans", "zh-Hans-CN", "zh-Hans-SG", "zh-Hans-HK", "zh_CN", "ZH-HANS-CN"]) {
    assert.equal(resolveDefaultUiLocale(null, [tag]), "zh-CN", `expected ${tag} -> zh-CN`);
  }
});

test("first launch maps Traditional Chinese system locales to zh-TW", () => {
  for (const tag of ["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW", "zh-Hant-HK", "zh-Hant-US", "zh_TW", "ZH-HK"]) {
    assert.equal(resolveDefaultUiLocale(null, [tag]), "zh-TW", `expected ${tag} -> zh-TW`);
  }
});

test("Chinese locale matching ignores BCP-47 extension subtags", () => {
  assert.equal(matchSupportedLocale("zh-u-rg-twzzzz"), "zh-CN");
  assert.equal(matchSupportedLocale("zh-TW-u-nu-latn"), "zh-TW");
  assert.equal(matchSupportedLocale("zh-CN-u-ca-chinese"), "zh-CN");
});

test("first launch maps Spanish, Russian, and English system locales", () => {
  assert.equal(resolveDefaultUiLocale(null, ["es"]), "es");
  assert.equal(resolveDefaultUiLocale(null, ["es-MX"]), "es");
  assert.equal(resolveDefaultUiLocale(null, ["es-419"]), "es");
  assert.equal(resolveDefaultUiLocale(null, ["ru"]), "ru");
  assert.equal(resolveDefaultUiLocale(null, ["ru-RU"]), "ru");
  assert.equal(resolveDefaultUiLocale(null, ["en"]), "en");
  assert.equal(resolveDefaultUiLocale(null, ["en-US"]), "en");
  assert.equal(resolveDefaultUiLocale(null, ["en-GB"]), "en");
});

test("first launch falls back to DEFAULT_UI_LOCALE for unsupported or empty locales", () => {
  assert.equal(resolveDefaultUiLocale(null, ["fr-FR"]), DEFAULT_UI_LOCALE);
  assert.equal(resolveDefaultUiLocale(undefined, ["ja-JP"]), DEFAULT_UI_LOCALE);
  assert.equal(resolveDefaultUiLocale("", ["de-DE", "ko-KR"]), DEFAULT_UI_LOCALE);
  assert.equal(resolveDefaultUiLocale("   ", []), DEFAULT_UI_LOCALE);
  assert.equal(resolveDefaultUiLocale(null, null), DEFAULT_UI_LOCALE);
  assert.equal(matchSupportedLocale("fr-FR"), null);
  assert.equal(matchSupportedLocale("ja-JP"), null);
  assert.equal(matchSupportedLocale(""), null);
});

test("first launch respects multi-locale priority lists", () => {
  assert.equal(resolveDefaultUiLocale(null, ["ja-JP", "zh-TW", "en-US"]), "zh-TW");
  assert.equal(resolveDefaultUiLocale(null, ["fr-FR", "zh-HK", "zh-CN"]), "zh-TW");
  assert.equal(resolveDefaultUiLocale(null, ["de-DE", "es-MX", "zh-CN"]), "es");
  assert.equal(resolveDefaultUiLocale(null, ["ja-JP", "en-US", "zh-CN"]), "en");
  assert.equal(resolveDefaultUiLocale(null, ["", "  ", "ru-RU"]), "ru");
});

test("resolveSupportedLocale handles regional and script variants cleanly", () => {
  assert.equal(resolveSupportedLocale("zh-HK"), "zh-TW");
  assert.equal(resolveSupportedLocale("zh-Hant-TW"), "zh-TW");
  assert.equal(resolveSupportedLocale("zh-Hans-CN"), "zh-CN");
  assert.equal(resolveSupportedLocale("es-MX"), "es");
  assert.equal(resolveSupportedLocale("ru-RU"), "ru");
  assert.equal(resolveSupportedLocale("fr-FR"), DEFAULT_UI_LOCALE);
});

test("getSystemLocales falls back from navigator.languages to navigator.language", () => {
  assert.deepEqual(
    getSystemLocales({ languages: ["ja-JP", "zh-TW"], language: "ja-JP" }),
    ["ja-JP", "zh-TW"],
  );
  assert.deepEqual(
    getSystemLocales({ languages: [], language: "zh-CN" }),
    ["zh-CN"],
  );
  assert.deepEqual(
    getSystemLocales({ languages: ["fr-FR"], language: "ru-RU" }),
    ["fr-FR", "ru-RU"],
  );
  assert.deepEqual(getSystemLocales(null), []);
  assert.deepEqual(getSystemLocales(undefined), []);
});

test("resolveDefaultUiLocale handles missing global navigator safely", () => {
  const savedDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: undefined,
  });
  try {
    assert.deepEqual(getSystemLocales(), []);
    assert.equal(resolveDefaultUiLocale(null), DEFAULT_UI_LOCALE);
    assert.equal(resolveDefaultUiLocale("zh-CN"), "zh-CN");
  } finally {
    if (savedDescriptor) {
      Object.defineProperty(globalThis, "navigator", savedDescriptor);
    } else {
      delete (globalThis as Record<string, unknown>).navigator;
    }
  }
});

test("resolveDefaultUiLocale reads global navigator when systemLocales is omitted", () => {
  const savedDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      languages: ["ja-JP", "zh-HK", "en-US"],
      language: "ja-JP",
    },
  });
  try {
    assert.equal(resolveDefaultUiLocale(null), "zh-TW");
    assert.equal(resolveDefaultUiLocale("en"), "en");
  } finally {
    if (savedDescriptor) {
      Object.defineProperty(globalThis, "navigator", savedDescriptor);
    } else {
      delete (globalThis as Record<string, unknown>).navigator;
    }
  }
});
