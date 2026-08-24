import assert from "node:assert/strict";
import test from "node:test";

import en from "./en.ts";
import ru from "./ru.ts";
import es from "./es.ts";
import zhCN from "./zh-CN.ts";
import zhTW from "./zh-TW.ts";

const INLINE_IMAGE_KEYS = [
  "settings.terminal.section.inlineImages",
  "settings.terminal.inlineImages.enabled",
  "settings.terminal.inlineImages.enabled.desc",
  "settings.terminal.inlineImages.kitty",
  "settings.terminal.inlineImages.kitty.desc",
  "settings.terminal.inlineImages.sixel",
  "settings.terminal.inlineImages.sixel.desc",
  "settings.terminal.inlineImages.iip",
  "settings.terminal.inlineImages.iip.desc",
  "settings.terminal.inlineImages.storageLimit",
  "settings.terminal.inlineImages.storageLimit.desc",
  "settings.terminal.inlineImages.maxMegapixels",
  "settings.terminal.inlineImages.maxMegapixels.desc",
  "settings.terminal.inlineImages.sequenceLimit",
  "settings.terminal.inlineImages.sequenceLimit.desc",
  "settings.terminal.inlineImages.unit.mb",
  "settings.terminal.inlineImages.unit.megapixels",
  "settings.terminal.inlineImages.hibernateNote",
];

const LOCALES = [
  { name: "en", messages: en },
  { name: "es", messages: es },
  { name: "zh-CN", messages: zhCN },
  { name: "zh-TW", messages: zhTW },
  { name: "ru", messages: ru },
];

test("every locale ships the inline image settings strings", () => {
  for (const locale of LOCALES) {
    const missing = INLINE_IMAGE_KEYS.filter((key) => !locale.messages[key]);
    assert.deepEqual(missing, [], `${locale.name} is missing inline image settings labels`);
  }
});

test("inline image strings are actually translated, not copied from English", () => {
  const translatedKeys = INLINE_IMAGE_KEYS.filter(
    (key) => !key.startsWith("settings.terminal.inlineImages.unit.")
      && key !== "settings.terminal.inlineImages.sixel",
  );

  for (const locale of LOCALES) {
    if (locale.name === "en") continue;
    const untranslated = translatedKeys.filter((key) => locale.messages[key] === en[key]);
    assert.deepEqual(untranslated, [], `${locale.name} still uses the English string`);
  }
});
