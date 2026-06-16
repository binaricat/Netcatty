import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_KEY_BINDINGS } from "../../../domain/models/keyBindings.ts";
import zhCN from "./zh-CN.ts";
import ru from "./ru.ts";

const LOCALIZED_SETTINGS_LOCALES = [
  { name: "zh-CN", messages: zhCN },
  { name: "ru", messages: ru },
];

test("localized settings include names for every default shortcut", () => {
  for (const locale of LOCALIZED_SETTINGS_LOCALES) {
    const missing = DEFAULT_KEY_BINDINGS
      .map((binding) => `settings.shortcuts.binding.${binding.id}`)
      .filter((key) => !locale.messages[key]);

    assert.deepEqual(missing, [], `${locale.name} is missing shortcut labels`);
  }
});

test("localized settings include workspace focus indicator labels", () => {
  const keys = [
    "settings.terminal.section.workspaceFocus",
    "settings.terminal.workspaceFocus.style",
    "settings.terminal.workspaceFocus.style.desc",
    "settings.terminal.workspaceFocus.dim",
    "settings.terminal.workspaceFocus.border",
  ];

  for (const locale of LOCALIZED_SETTINGS_LOCALES) {
    const missing = keys.filter((key) => !locale.messages[key]);
    assert.deepEqual(missing, [], `${locale.name} is missing workspace focus labels`);
  }
});

test("localized settings include terminal font weight option labels", () => {
  const keys = [
    "settings.terminal.font.weight.thin",
    "settings.terminal.font.weight.extraLight",
    "settings.terminal.font.weight.light",
    "settings.terminal.font.weight.normal",
    "settings.terminal.font.weight.medium",
    "settings.terminal.font.weight.semiBold",
    "settings.terminal.font.weight.bold",
    "settings.terminal.font.weight.extraBold",
    "settings.terminal.font.weight.black",
  ];

  for (const locale of LOCALIZED_SETTINGS_LOCALES) {
    const missing = keys.filter((key) => !locale.messages[key]);
    assert.deepEqual(missing, [], `${locale.name} is missing font weight labels`);
  }
});
