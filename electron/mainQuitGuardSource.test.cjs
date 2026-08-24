const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

test("before-quit dirty editor guard queries only registered editor-owner windows", () => {
  const source = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const lifecycleSource = readFileSync(path.join(__dirname, "main", "appLockLifecycle.cjs"), "utf8");
  const beforeQuitIndex = source.indexOf('app.on("before-quit"');
  const dirtyEditorWindowsIndex = source.indexOf("getDirtyEditorWindows", beforeQuitIndex);
  const handleBeforeQuitIndex = source.indexOf("handleBeforeQuit", beforeQuitIndex);
  const handleBeforeQuitEndIndex = source.indexOf("}).catch", handleBeforeQuitIndex);
  const queryableIndex = lifecycleSource.indexOf("const queryableWebContents");
  const queryCallIndex = lifecycleSource.indexOf("queryDirtyEditors", queryableIndex);
  const lifecycleBeforeQuitIndex = lifecycleSource.indexOf("async function handleBeforeQuit");
  const lifecycleGuardSetup = lifecycleSource.slice(lifecycleBeforeQuitIndex, queryCallIndex);

  assert.notEqual(beforeQuitIndex, -1);
  assert.notEqual(dirtyEditorWindowsIndex, -1);
  assert.notEqual(handleBeforeQuitIndex, -1);
  assert.notEqual(handleBeforeQuitEndIndex, -1);
  assert.notEqual(lifecycleBeforeQuitIndex, -1);
  assert.notEqual(queryableIndex, -1);
  assert.ok(dirtyEditorWindowsIndex < handleBeforeQuitIndex);
  assert.match(source.slice(beforeQuitIndex, handleBeforeQuitIndex), /const dirtyEditorWindows = typeof getWindowManager\(\)\.getDirtyEditorWindows === "function"/);
  assert.match(source.slice(handleBeforeQuitIndex, handleBeforeQuitEndIndex), /mainWindows,\s*\n\s*queryDirtyEditors/);
  assert.match(lifecycleGuardSetup, /const reachableMainWindows = \(Array\.isArray\(mainWindows\) \? mainWindows : \[\]\)\.filter/);
  // Prefer queryableWindows (reachable + non-crashed webContents) over a raw
  // reachableMainWindows map so dirty checks and focus targets stay aligned.
  assert.match(
    lifecycleSource.slice(queryableIndex, queryCallIndex),
    /queryableWindows\s*\n?\s*\.map\(\(candidate\) => candidate\.webContents\)/,
  );
  assert.doesNotMatch(lifecycleGuardSetup, /isVisible|isMinimized/);
});

test("macOS reopen after last window re-applies app lock for a fresh session", () => {
  const source = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const lifecycleSource = readFileSync(path.join(__dirname, "main", "appLockLifecycle.cjs"), "utf8");

  assert.match(lifecycleSource, /function ensureAppLockForFreshSession/);
  assert.match(lifecycleSource, /function hasNoUsableAppContentWindows/);
  assert.match(source, /ensureAppLockForFreshSession/);
  assert.match(source, /hasNoUsableAppContentWindows/);

  const createIndex = source.indexOf("async function createAndShowMainWindow");
  const createBodyEnd = source.indexOf("async function deliverSshDeepLink", createIndex);
  assert.notEqual(createIndex, -1);
  assert.notEqual(createBodyEnd, -1);
  const createBody = source.slice(createIndex, createBodyEnd);
  assert.match(createBody, /hasNoUsableAppContentWindows\(getAppLockReopenWindows\(\)\)/);
  assert.match(createBody, /ensureAppLockForFreshSession\(appLockController,\s*"startup"\)/);

  const allClosedIndex = source.indexOf('app.on("window-all-closed"');
  assert.notEqual(allClosedIndex, -1);
  const allClosedBody = source.slice(allClosedIndex, allClosedIndex + 350);
  assert.match(allClosedBody, /process\.platform !== "darwin"/);
  assert.match(allClosedBody, /ensureAppLockForFreshSession\(appLockController,\s*"startup"\)/);
});

test("before-quit dirty editor guard foregrounds dirty windows through the focus recovery helper", () => {
  const lifecycleSource = readFileSync(path.join(__dirname, "main", "appLockLifecycle.cjs"), "utf8");
  const beforeQuitIndex = lifecycleSource.indexOf("async function handleBeforeQuit");
  const loopIndex = lifecycleSource.indexOf("for (const win of dirtyWindows)", beforeQuitIndex);
  const dialogIndex = lifecycleSource.indexOf("// App Lock overlay sits above renderer toasts", loopIndex);
  const foregroundBlock = lifecycleSource.slice(loopIndex, dialogIndex);

  assert.notEqual(beforeQuitIndex, -1);
  assert.notEqual(loopIndex, -1);
  assert.notEqual(dialogIndex, -1);
  assert.match(foregroundBlock, /windowManager\.showAndFocusMainWindow\(win\)/);
  assert.doesNotMatch(foregroundBlock, /commitQuit\(\)/);
});

test("before-quit keeps the original event cancelled while plugin shutdown runs without a renderer", () => {
  const lifecycleSource = readFileSync(path.join(__dirname, "main", "appLockLifecycle.cjs"), "utf8");
  const commitIndex = lifecycleSource.indexOf("const commit = () => {");
  const commitEnd = lifecycleSource.indexOf("};", commitIndex);
  const commitBlock = lifecycleSource.slice(commitIndex, commitEnd);

  assert.notEqual(commitIndex, -1);
  assert.match(commitBlock, /event\?\.preventDefault\?\.\(\)/);
  assert.match(commitBlock, /commitQuit\(\)/);
  assert.ok(
    commitBlock.indexOf("event?.preventDefault?.()") < commitBlock.indexOf("commitQuit()"),
    "the original quit must be cancelled before asynchronous plugin shutdown starts",
  );

  const source = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const beforeQuitIndex = source.indexOf('app.on("before-quit"');
  const handleIndex = source.indexOf("handleBeforeQuit", beforeQuitIndex);
  const handleEnd = source.indexOf("}).catch", handleIndex);
  assert.notEqual(handleIndex, -1);
  assert.match(source.slice(handleIndex, handleEnd), /commitQuit,/);
});

test("all app content windows use the WindowManager-level last-window close handler", () => {
  const mainSource = readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const windowSource = readFileSync(path.join(
    __dirname,
    "bridges",
    "windowManager",
    "mainWindow.cjs",
  ), "utf8");
  const createWindowIndex = mainSource.indexOf("async function createWindow()");
  const setHandlerIndex = mainSource.indexOf("setAppContentWindowClosedHandler", createWindowIndex);
  const managerCreateIndex = mainSource.indexOf("windowManager.createWindow", createWindowIndex);

  assert.notEqual(setHandlerIndex, -1);
  assert.notEqual(managerCreateIndex, -1);
  assert.ok(setHandlerIndex < managerCreateIndex);
  const closedIndex = windowSource.indexOf("win.on('closed'");
  const appContentBranchIndex = windowSource.indexOf("if (registerAsAppContentWindow)", closedIndex);
  const notifyIndex = windowSource.indexOf("notifyAppContentWindowClosed(win)", appContentBranchIndex);
  assert.notEqual(closedIndex, -1);
  assert.notEqual(appContentBranchIndex, -1);
  assert.notEqual(notifyIndex, -1);
});
