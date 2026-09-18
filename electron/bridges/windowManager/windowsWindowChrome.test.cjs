const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { readFileSync } = require("node:fs");

const {
  CLEAR_BACKGROUND,
  isWindowsPlatform,
  windowsFramelessContentChromeOptions,
  windowsCssRoundedOverlayChromeOptions,
} = require("./windowsWindowChrome.cjs");

test("CLEAR_BACKGROUND is fully transparent ARGB", () => {
  assert.equal(CLEAR_BACKGROUND, "#00000000");
});

test("isWindowsPlatform detects win32 only", () => {
  assert.equal(isWindowsPlatform("win32"), true);
  assert.equal(isWindowsPlatform("darwin"), false);
  assert.equal(isWindowsPlatform("linux"), false);
});

test("content chrome is a no-op outside Windows", () => {
  assert.deepEqual(windowsFramelessContentChromeOptions("darwin"), {});
  assert.deepEqual(windowsFramelessContentChromeOptions("linux"), {});
});

test("content chrome enables native rounding without transparency on Windows", () => {
  assert.deepEqual(windowsFramelessContentChromeOptions("win32"), {
    roundedCorners: true,
  });
  assert.equal(
    Object.hasOwn(windowsFramelessContentChromeOptions("win32"), "transparent"),
    false,
    "resizable app windows must not use transparent hosts",
  );
});

test("CSS overlay chrome clears the opaque backdrop on every platform", () => {
  assert.deepEqual(windowsCssRoundedOverlayChromeOptions("darwin"), {
    transparent: true,
    backgroundColor: CLEAR_BACKGROUND,
  });
  assert.deepEqual(windowsCssRoundedOverlayChromeOptions("linux"), {
    transparent: true,
    backgroundColor: CLEAR_BACKGROUND,
  });
});

test("CSS overlay chrome disables OS rounding on Windows", () => {
  assert.deepEqual(windowsCssRoundedOverlayChromeOptions("win32"), {
    transparent: true,
    backgroundColor: CLEAR_BACKGROUND,
    roundedCorners: false,
  });
});

test("main/settings/tray call sites wire Windows chrome helpers", () => {
  const here = __dirname;
  const main = readFileSync(path.join(here, "mainWindow.cjs"), "utf8");
  const settings = readFileSync(path.join(here, "settingsWindow.cjs"), "utf8");
  const popup = readFileSync(path.join(here, "terminalPopupWindow.cjs"), "utf8");
  const editor = readFileSync(path.join(here, "editorWindow.cjs"), "utf8");
  const tray = readFileSync(path.join(here, "../globalShortcutBridge.cjs"), "utf8");
  const css = readFileSync(path.join(here, "../../../index.css"), "utf8");
  const html = readFileSync(path.join(here, "../../../index.html"), "utf8");
  const helper = readFileSync(path.join(here, "windowsWindowChrome.cjs"), "utf8");

  for (const [label, source] of [
    ["mainWindow", main],
    ["settingsWindow", settings],
    ["terminalPopupWindow", popup],
    ["editorWindow", editor],
  ]) {
    assert.match(source, /require\("\.\/windowsWindowChrome\.cjs"\)/, `${label} must require chrome helpers`);
    assert.match(source, /windowsFramelessContentChromeOptions/, `${label} must use content chrome helper`);
    assert.doesNotMatch(source, /resolveFramelessHostBackgroundColor/, `${label} should not clear host backdrop`);
    const requireIndex = source.indexOf('require("./windowsWindowChrome.cjs")');
    const withIndex = source.indexOf("with (ctx)");
    assert.ok(
      requireIndex !== -1 && withIndex !== -1 && requireIndex < withIndex,
      `${label}: require chrome helpers before with(ctx) so injected require cannot remount the path`,
    );
  }
  assert.match(tray, /windowsCssRoundedOverlayChromeOptions/);
  assert.match(tray, /#2505/);
  assert.match(css, /html\.tray-window/);
  assert.match(css, /html\.tray-window \.splash-screen/);
  assert.match(html, /tray-window/);
  assert.match(html, /removeTraySplash|splash\.remove\(\)/);
  assert.match(tray, /trayPanelShowWhenReady|trayPanelReady/);
  assert.match(tray, /isOpenOrPending/);
  assert.match(helper, /square tips under a rounded panel/);
  assert.match(helper, /not resizable/);
  assert.doesNotMatch(helper, /[^\x00-\x7F]/, "helper comments must stay ASCII-only");
  const contentHelperMatch = helper.match(
    /function windowsFramelessContentChromeOptions\([\s\S]*?\n\}/,
  );
  assert.ok(contentHelperMatch, "content chrome helper must exist");
  assert.match(contentHelperMatch[0], /roundedCorners:\s*true/);
  assert.doesNotMatch(
    contentHelperMatch[0],
    /transparent/,
    "content chrome must stay opaque/resizable",
  );
});
