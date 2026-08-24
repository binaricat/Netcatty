import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readAppLockSectionSource = () => (
  readFileSync(new URL("./AppLockSettingsSection.tsx", import.meta.url), "utf8")
);

test("disabling app lock does not trigger a second renderer-side unlock request", () => {
  const source = readAppLockSectionSource();

  assert.doesNotMatch(source, /unlockApp\?\.\(/);
  assert.doesNotMatch(source, /unlockApp\?:/);
});

test("app lock setup starts with password setup instead of a misleading enable toggle", () => {
  const source = readAppLockSectionSource();

  assert.match(source, /!hasPassword \? \(/);
  assert.match(source, /settings\.appLock\.setupTitle/);
  assert.match(source, /settings\.appLock\.setupDescription/);
  assert.match(source, /settings\.appLock\.manageTitle/);
  assert.doesNotMatch(
    source,
    /hasAppLockPassword \? t\("settings\.appLock\.enableDesc"\) : t\("settings\.appLock\.enableAfterPassword"\)/,
  );
});

test("app lock section exposes settings-search anchors", () => {
  const source = readAppLockSectionSource();

  assert.match(source, /anchorId="system-app-lock"/);
});

test("app lock disable handler uses its modal current password field", () => {
  const source = readAppLockSectionSource();
  const handlerStart = source.indexOf("const handleDisable = useCallback");
  const handlerEnd = source.indexOf("const handleSavePassword", handlerStart);
  const handlerSource = source.slice(handlerStart, handlerEnd);

  assert.match(handlerSource, /requestAppLockDisable\(disablePassword\)/);
  assert.match(handlerSource, /disablePassword,/);
  assert.doesNotMatch(source, /handleAppLockEnabledChange/);
});

test("app lock page uses settings rows and moves password forms into a dialog", () => {
  const source = readAppLockSectionSource();
  const dialogStart = source.indexOf('<Dialog');
  const firstPasswordInput = source.indexOf('<Input');

  assert.match(source, /<SettingCard divided>/);
  assert.match(source, /<SettingRow/);
  assert.match(source, /<DialogContent/);
  assert.ok(firstPasswordInput > dialogStart, "password inputs should only render inside the dialog");
  assert.doesNotMatch(source.slice(0, dialogStart), /<Input/);
  assert.doesNotMatch(source, /settings\.appLock\.enableDesc/);
  assert.match(source, /settings\.appLock\.disableTitle/);
  assert.match(source, /settings\.appLock\.disableDescription/);
  assert.match(source, /settings\.appLock\.disable/);
  assert.match(source, /settings\.appLock\.changePasswordTitle/);
  assert.match(source, /settings\.appLock\.currentPasswordForDisablePlaceholder/);
  assert.match(source, /settings\.appLock\.currentPasswordForChangePlaceholder/);
});

test("app lock system unlock setting uses bridge-provided platform label", () => {
  const source = readAppLockSectionSource();

  assert.match(source, /showSystemUnlock/);
  assert.match(source, /appLockSystemUnlockStatus\.label/);
  assert.match(source, /settings\.appLock\.systemUnlock\.label/);
  assert.doesNotMatch(source, /navigator\.platform/);
});

test("app lock system unlock enablement does not require current password in settings", () => {
  const source = readAppLockSectionSource();
  const handlerStart = source.indexOf("const handleSystemUnlockChange = useCallback");
  const handlerEnd = source.indexOf("const handleAutoPromptChange", handlerStart);
  const handlerSource = source.slice(handlerStart, handlerEnd);

  assert.match(handlerSource, /setAppLockSystemUnlockEnabled\(\{/);
  assert.doesNotMatch(handlerSource, /appLockSystemUnlockPassword/);
  assert.doesNotMatch(handlerSource, /currentPassword:/);

  const systemUnlockStart = source.indexOf("{showSystemUnlock");
  const systemUnlockEnd = source.indexOf("settings.appLock.changePasswordTitle", systemUnlockStart);
  const systemUnlockSection = source.slice(systemUnlockStart, systemUnlockEnd);
  assert.doesNotMatch(systemUnlockSection, /settings\.appLock\.currentPassword/);
});

test("app lock system unlock setting hides when unavailable unless already enabled", () => {
  const source = readAppLockSectionSource();

  assert.match(source, /appLockSystemUnlockStatus\.available \|\| appLockSettings\.systemUnlockEnabled/);
  // Already-enabled toggle stays clickable when unavailable so the user can disable.
  assert.match(
    source,
    /disabled=\{\s*isSavingSystemUnlock\s*\|\|\s*\(!appLockSystemUnlockStatus\.available && !appLockSettings\.systemUnlockEnabled\)\s*\}/,
  );
});

test("app lock system unlock exposes auto prompt as a child option", () => {
  const source = readAppLockSectionSource();

  assert.match(source, /settings\.appLock\.systemUnlock\.autoPrompt\.label/);
  assert.match(source, /settings\.appLock\.systemUnlock\.autoPrompt\.desc/);
  assert.match(source, /appLockSettings\.systemUnlockAutoPromptEnabled/);
  assert.match(source, /appLockSettings\.systemUnlockEnabled/);
});

test("app lock system unlock handles native verification failures", () => {
  const source = readAppLockSectionSource();

  assert.match(source, /'cancelled' \| 'failed'/);
  assert.match(source, /result\.error === 'cancelled'/);
  assert.match(source, /case 'failed':\s*return t\('settings\.appLock\.systemUnlock\.unavailable'\)/);
});

test("app lock disable explains that turning it off removes the saved password", () => {
  const englishLocale = readFileSync(new URL("../../../application/i18n/locales/en/core.ts", import.meta.url), "utf8");

  assert.match(englishLocale, /saved password will be removed/);
  assert.match(englishLocale, /requires creating a new one/);
});
