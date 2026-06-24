import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_RESTORE_TERMINAL_CWD,
  DEFAULT_RESTORE_PREVIOUS_SESSION,
  resolveRestoreTerminalCwdSetting,
  resolveRestorePreviousSessionSetting,
} from "./sessionRestoreSettings.ts";

test("restore previous session setting defaults on", () => {
  assert.equal(DEFAULT_RESTORE_PREVIOUS_SESSION, true);
  assert.equal(resolveRestorePreviousSessionSetting(null), true);
});

test("restore previous session setting preserves explicit stored values", () => {
  assert.equal(resolveRestorePreviousSessionSetting(true), true);
  assert.equal(resolveRestorePreviousSessionSetting(false), false);
});

test("restore terminal cwd setting defaults off", () => {
  assert.equal(DEFAULT_RESTORE_TERMINAL_CWD, false);
  assert.equal(resolveRestoreTerminalCwdSetting(null), false);
});

test("restore terminal cwd setting preserves explicit stored values", () => {
  assert.equal(resolveRestoreTerminalCwdSetting(true), true);
  assert.equal(resolveRestoreTerminalCwdSetting(false), false);
});

test("restore previous session setting participates in cross-window settings sync", () => {
  const storageSyncSource = readFileSync(new URL("./settingsStorageSync.ts", import.meta.url), "utf8");
  const ipcSyncSource = readFileSync(new URL("./settingsIpcSync.ts", import.meta.url), "utf8");

  assert.match(storageSyncSource, /STORAGE_KEY_RESTORE_PREVIOUS_SESSION/);
  assert.match(storageSyncSource, /setRestorePreviousSessionState/);
  assert.match(storageSyncSource, /e\.key === STORAGE_KEY_RESTORE_PREVIOUS_SESSION/);

  assert.match(ipcSyncSource, /STORAGE_KEY_RESTORE_PREVIOUS_SESSION/);
  assert.match(ipcSyncSource, /setRestorePreviousSessionState/);
  assert.match(ipcSyncSource, /key === STORAGE_KEY_RESTORE_PREVIOUS_SESSION/);
});

test("disabling restore previous session clears the stored restore snapshot", () => {
  const settingsSource = readFileSync(new URL("./useSettingsState.ts", import.meta.url), "utf8");
  const importIndex = settingsSource.indexOf("sessionRestoreStorage");
  const setterIndex = settingsSource.indexOf("const setRestorePreviousSession = useCallback");
  const clearIndex = settingsSource.indexOf("sessionRestoreStorage.clear()", setterIndex);
  const writeIndex = settingsSource.indexOf("localStorageAdapter.writeBoolean(STORAGE_KEY_RESTORE_PREVIOUS_SESSION", setterIndex);

  assert.notEqual(importIndex, -1);
  assert.notEqual(setterIndex, -1);
  assert.notEqual(clearIndex, -1);
  assert.notEqual(writeIndex, -1);
  assert.ok(
    writeIndex < clearIndex,
    "the setting should be persisted before clearing the restore snapshot",
  );
});

test("session restore persistence re-arms when restore previous session is enabled", () => {
  const source = readFileSync(new URL("./useSessionState.ts", import.meta.url), "utf8");
  const adapterEventImportIndex = source.indexOf("LOCAL_STORAGE_ADAPTER_CHANGED_EVENT");
  const revisionStateIndex = source.indexOf("restorePreviousSessionRevision");
  const keyGuardIndex = source.indexOf("key !== STORAGE_KEY_RESTORE_PREVIOUS_SESSION");
  const listenerIndex = source.indexOf("addEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT");
  const effectDependencyIndex = source.indexOf("restorePreviousSessionRevision, persistSessionRestore]", source.indexOf("beforeunload"));

  assert.notEqual(adapterEventImportIndex, -1);
  assert.notEqual(revisionStateIndex, -1);
  assert.notEqual(keyGuardIndex, -1);
  assert.notEqual(listenerIndex, -1);
  assert.notEqual(effectDependencyIndex, -1);
});

test("session restore persistence can be disabled for non-main windows", () => {
  const hookSource = readFileSync(new URL("./useSessionState.ts", import.meta.url), "utf8");
  const traySource = readFileSync(new URL("../../components/TrayPanel.tsx", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
  const indexSource = readFileSync(new URL("../../index.tsx", import.meta.url), "utf8");
  const registerBridgesSource = readFileSync(new URL("../../electron/main/registerBridges.cjs", import.meta.url), "utf8");
  const mainWindowSource = readFileSync(new URL("../../electron/bridges/windowManager/mainWindow.cjs", import.meta.url), "utf8");

  assert.match(hookSource, /persistSessionRestore\?: boolean/);
  assert.match(hookSource, /restoreEnabled: persistSessionRestore && resolveRestorePreviousSessionSetting/);
  assert.match(hookSource, /payload: persistSessionRestore \? sessionRestoreStorage\.read\(\) : null/);
  assert.match(hookSource, /if \(!persistSessionRestore\) return;/);
  assert.match(traySource, /useSessionState\(\{ persistSessionRestore: false \}\)/);
  assert.match(appSource, /window\.location\.hash\.startsWith\('#\/session-window'\)/);
  assert.match(appSource, /persistSessionRestore: !isPeerSessionWindow/);
  assert.match(indexSource, /hash === '#\/session-window'/);
  assert.match(registerBridgesSource, /route: "session-window"/);
  assert.match(registerBridgesSource, /registerAsMainWindow: false/);
  assert.match(mainWindowSource, /const rendererHash = typeof route === "string"/);
  assert.match(mainWindowSource, /registerAsMainWindow = true/);
  assert.match(mainWindowSource, /if \(registerAsMainWindow\)/);
  assert.match(mainWindowSource, /loadURL\(`\$\{getDevRendererBaseUrl\(devServerUrl\)\}\$\{rendererHash\}`\)/);
  assert.match(mainWindowSource, /loadURL\(`app:\/\/netcatty\/index\.html\$\{rendererHash\}`\)/);
});

test("session peer windows do not run main-window startup effects", () => {
  const appSource = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
  const autoSyncSource = readFileSync(new URL("./useAutoSync.ts", import.meta.url), "utf8");
  const startupEffectsSource = readFileSync(new URL("../app/useAppStartupEffects.ts", import.meta.url), "utf8");
  const updateCheckSource = readFileSync(new URL("./useUpdateCheck.ts", import.meta.url), "utf8");
  const settingsStateSource = readFileSync(new URL("./useSettingsState.ts", import.meta.url), "utf8");
  const settingsIpcSyncSource = readFileSync(new URL("./settingsIpcSync.ts", import.meta.url), "utf8");
  const storageSyncSource = readFileSync(new URL("./settingsStorageSync.ts", import.meta.url), "utf8");
  const systemEffectsSource = readFileSync(new URL("./systemSettingsEffects.ts", import.meta.url), "utf8");
  const trayFocusIndex = appSource.indexOf("onTrayFocusSession");
  const trayPanelJumpIndex = appSource.indexOf("onTrayPanelJumpToSession");

  assert.match(appSource, /const isPeerSessionWindow = typeof window !== 'undefined' && window\.location\.hash\.startsWith\('#\/session-window'\)/);
  assert.match(appSource, /useSettingsState\(\{[^}]*enableSettingsSync: !isPeerSessionWindow[^}]*enableSystemEffects: !isPeerSessionWindow/s);
  assert.match(appSource, /useAppStartupEffects\(\{[^}]*enabled: !isPeerSessionWindow/s);
  assert.match(appSource, /useUpdateCheck\(\{[^}]*enabled: !isPeerSessionWindow/s);
  assert.match(appSource, /if \(isPeerSessionWindow \|\| !isVaultInitialized \|\| versionBackupAttemptedRef\.current\) return;/);
  assert.match(appSource, /useAutoSync\(\{[^}]*enabled: !isPeerSessionWindow/s);
  assert.match(autoSyncSource, /enabled\?: boolean/);
  assert.match(autoSyncSource, /const enabled = config\.enabled !== false/);
  assert.match(autoSyncSource, /if \(!enabled\) return;/);
  assert.match(updateCheckSource, /enabled\?: boolean/);
  assert.match(updateCheckSource, /const enabled = options\?\.enabled !== false/);
  assert.match(updateCheckSource, /if \(!enabled\) return;/);
  assert.match(settingsStateSource, /enableSystemEffects\?: boolean/);
  assert.match(settingsStateSource, /enableSettingsSync\?: boolean/);
  assert.match(settingsStateSource, /const enableSettingsSync = options\.enableSettingsSync !== false/);
  assert.match(settingsStateSource, /useSettingsIpcSync\(\{[^}]*enabled: enableSettingsSync/s);
  assert.match(settingsStateSource, /useSettingsStorageSync\(\{[^}]*enabled: enableSettingsSync/s);
  assert.match(settingsStateSource, /if \(!enableSettingsSync\) return;\s*try \{\s*netcattyBridge\.get\(\)\?\.notifySettingsChanged/s);
  assert.match(settingsStateSource, /useSystemSettingsEffects\(\{[^}]*enabled: enableSystemEffects/s);
  assert.match(settingsIpcSyncSource, /enabled\?: boolean/);
  assert.match(settingsIpcSyncSource, /if \(!enabled\) return;/);
  assert.match(storageSyncSource, /enabled\?: boolean/);
  assert.match(storageSyncSource, /if \(!enabled\) return;/);
  assert.match(systemEffectsSource, /enabled\?: boolean/);
  assert.match(systemEffectsSource, /if \(!enabled\) return;/);
  assert.ok(
    appSource.lastIndexOf("if (isPeerSessionWindow) return;", trayFocusIndex) !== -1,
    "peer session windows should not register tray focus/toggle listeners",
  );
  assert.ok(
    appSource.lastIndexOf("if (isPeerSessionWindow) return;", trayPanelJumpIndex) !== -1,
    "peer session windows should not register tray panel listeners",
  );
  assert.match(startupEffectsSource, /enabled = true/);
  assert.match(startupEffectsSource, /if \(!enabled\) return;/);
  assert.match(startupEffectsSource, /export function shouldQueueKeyboardInteractiveRequest/);
  assert.match(startupEffectsSource, /request\.scope !== "terminal"/);
  assert.match(startupEffectsSource, /shouldQueueKeyboardInteractiveRequest\(request, sessionsRef\.current\)/);
  assert.doesNotMatch(
    startupEffectsSource,
    /if \(!enabled\) return;\s*const bridge = netcattyBridge\.get\(\);\s*if \(!bridge\?\.onCheckDirtyEditors\) return;/,
    "dirty editor quit guard must remain registered in peer session windows",
  );
});

test("restore-only settings do not bump the cloud sync settings version", () => {
  const settingsSource = readFileSync(new URL("./useSettingsState.ts", import.meta.url), "utf8");
  const settingsVersionIndex = settingsSource.indexOf("settingsVersion: useMemo");
  const settingsVersionSource = settingsSource.slice(settingsVersionIndex);

  assert.notEqual(settingsVersionIndex, -1);
  assert.doesNotMatch(settingsVersionSource, /restorePreviousSession|restoreTerminalCwd/);
});

test("restore previous session re-arms after cross-window settings ipc sync", () => {
  const hookSource = readFileSync(new URL("./useSessionState.ts", import.meta.url), "utf8");
  const settingsIpcSyncSource = readFileSync(new URL("./settingsIpcSync.ts", import.meta.url), "utf8");

  assert.match(settingsIpcSyncSource, /STORAGE_KEY_RESTORE_PREVIOUS_SESSION/);
  assert.match(hookSource, /netcattyBridge/);
  assert.match(hookSource, /onSettingsChanged/);
  assert.match(hookSource, /handleRestorePreviousSessionChanged\(payload\?\.key\)/);
  assert.match(hookSource, /key !== STORAGE_KEY_RESTORE_PREVIOUS_SESSION/);
  assert.match(hookSource, /setRestorePreviousSessionRevision\(\(revision\) => revision \+ 1\)/);
});

test("restore terminal cwd setting participates in cross-window settings sync", () => {
  const storageSyncSource = readFileSync(new URL("./settingsStorageSync.ts", import.meta.url), "utf8");
  const ipcSyncSource = readFileSync(new URL("./settingsIpcSync.ts", import.meta.url), "utf8");

  assert.match(storageSyncSource, /STORAGE_KEY_RESTORE_TERMINAL_CWD/);
  assert.match(storageSyncSource, /setRestoreTerminalCwdState/);
  assert.match(storageSyncSource, /e\.key === STORAGE_KEY_RESTORE_TERMINAL_CWD/);

  assert.match(ipcSyncSource, /STORAGE_KEY_RESTORE_TERMINAL_CWD/);
  assert.match(ipcSyncSource, /setRestoreTerminalCwdState/);
  assert.match(ipcSyncSource, /key === STORAGE_KEY_RESTORE_TERMINAL_CWD/);
});
