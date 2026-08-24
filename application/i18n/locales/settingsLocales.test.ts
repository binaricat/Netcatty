import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_KEY_BINDINGS } from "../../../domain/models/keyBindings.ts";
import en from "./en.ts";
import { HOST_ICON_COLORS, HOST_ICON_IDS } from "../../../domain/hostIcon.ts";
import zhCN from "./zh-CN.ts";
import ru from "./ru.ts";
import es from "./es.ts";

const LOCALIZED_SETTINGS_LOCALES = [
  { name: "zh-CN", messages: zhCN },
  { name: "ru", messages: ru },
  { name: "es", messages: es },
];

const APP_LOCK_LOCALES = [
  { name: "en", messages: en },
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

test("localized settings include network proxy labels", () => {
  const keys = [
    "settings.system.networkProxy.title",
    "settings.system.networkProxy.description",
    "settings.system.networkProxy.mode",
    "settings.system.networkProxy.mode.system",
    "settings.system.networkProxy.mode.direct",
    "settings.system.networkProxy.mode.custom",
    "settings.system.networkProxy.url",
    "settings.system.networkProxy.url.placeholder",
    "settings.system.networkProxy.url.desc",
    "settings.system.networkProxy.bypass",
    "settings.system.networkProxy.bypass.placeholder",
    "settings.system.networkProxy.bypass.desc",
    "settings.system.networkProxy.hint",
  ];

  for (const locale of LOCALIZED_SETTINGS_LOCALES) {
    const missing = keys.filter((key) => !locale.messages[key]);
    assert.deepEqual(missing, [], `${locale.name} is missing network proxy labels`);
  }
});

test("localized settings include OSC desktop notification labels", () => {
  const keys = [
    "settings.terminal.behavior.oscNotifications",
    "settings.terminal.behavior.oscNotifications.desc",
    "settings.terminal.behavior.oscNotifications.off",
    "settings.terminal.behavior.oscNotifications.unfocused",
    "settings.terminal.behavior.oscNotifications.always",
  ];

  for (const locale of LOCALIZED_SETTINGS_LOCALES) {
    const missing = keys.filter((key) => !locale.messages[key]);
    assert.deepEqual(missing, [], `${locale.name} is missing OSC notification labels`);
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

test("all app lock strings are translated in every supported locale", () => {
  const keys = [
    "appLock.title",
    "appLock.reason.default",
    "appLock.reason.startup",
    "appLock.reason.idle",
    "appLock.reason.manual",
    "appLock.passwordLabel",
    "appLock.passwordPlaceholder",
    "appLock.unlock",
    "appLock.unlocking",
    "appLock.error.emptyPassword",
    "appLock.error.incorrectPassword",
    "appLock.systemUnlock.unlockWith",
    "appLock.systemUnlock.error",
    "appLock.logoLabel",
    "appLock.reset.title",
    "appLock.reset.description",
    "appLock.reset.cancel",
    "appLock.reset.confirm",
    "appLock.reset.resetting",
    "appLock.reset.error",
    "topTabs.lockApp",
    "settings.appLock.title",
    "settings.appLock.description",
    "settings.appLock.enable",
    "settings.appLock.enableDesc",
    "settings.appLock.timeout",
    "settings.appLock.timeoutDesc",
    "settings.appLock.timeout.0",
    "settings.appLock.timeout.1",
    "settings.appLock.timeout.5",
    "settings.appLock.timeout.15",
    "settings.appLock.timeout.30",
    "settings.appLock.timeout.60",
    "settings.appLock.systemUnlock.label",
    "settings.appLock.systemUnlock.desc",
    "settings.appLock.systemUnlock.unavailableDesc",
    "settings.appLock.systemUnlock.unavailable",
    "settings.appLock.systemUnlock.locked",
    "settings.appLock.systemUnlock.autoPrompt.label",
    "settings.appLock.systemUnlock.autoPrompt.desc",
    "settings.appLock.currentPassword",
    "settings.appLock.currentPasswordPlaceholder",
    "settings.appLock.newPassword",
    "settings.appLock.newPasswordPlaceholder",
    "settings.appLock.confirmPassword",
    "settings.appLock.confirmPasswordPlaceholder",
    "settings.appLock.savePassword",
    "settings.appLock.savingPassword",
    "settings.appLock.passwordSet",
    "settings.appLock.replacePassword",
    "settings.appLock.enableAfterPassword",
    "settings.appLock.localOnlyHint",
    "settings.appLock.validation.currentRequired",
    "settings.appLock.validation.newRequired",
    "settings.appLock.validation.confirmRequired",
    "settings.appLock.validation.mismatch",
    "settings.appLock.validation.incorrect",
  ];

  for (const locale of APP_LOCK_LOCALES) {
    const missing = keys.filter((key) => !locale.messages[key]);
    assert.deepEqual(missing, [], `${locale.name} is missing app lock labels`);
  }
});

test("localized vault messages include host icon labels", () => {
  const keys = [
    "hostDetails.icon.title",
    "hostDetails.icon.desc",
    "hostDetails.icon.mode.auto",
    "hostDetails.icon.mode.custom",
    "hostDetails.icon.reset",
    "hostDetails.icon.showLibrary",
    "hostDetails.icon.hideLibrary",
    "hostDetails.icon.autoUsesDistro",
    "hostDetails.icon.customOverridesDistro",
    ...HOST_ICON_IDS.map((id) => `hostDetails.icon.option.${id}`),
    ...HOST_ICON_COLORS.map((color) => `hostDetails.icon.color.${color.id}`),
  ];

  for (const locale of LOCALIZED_SETTINGS_LOCALES) {
    const missing = keys.filter((key) => !locale.messages[key]);
    assert.deepEqual(missing, [], `${locale.name} is missing host icon labels`);
  }
});

test("localized vault messages include interactive authentication labels", () => {
  const keys = [
    "hostDetails.auth.mfaFirst",
    "hostDetails.auth.mfaFirst.desc",
  ];

  for (const locale of LOCALIZED_SETTINGS_LOCALES) {
    const missing = keys.filter((key) => !locale.messages[key]);
    assert.deepEqual(missing, [], `${locale.name} is missing interactive authentication labels`);
  }
});
