"use strict";

if (!process.versions.electron) {
  require("node:test")("tray panel fills its window through the app-lock gate", {
    skip: "run npm run build && npm run test:tray-panel-layout",
  }, () => {});
} else {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const { app, BrowserWindow, ipcMain, screen } = require("electron");
  const tempDirBridge = require("../electron/bridges/tempDirBridge.cjs");
  const { TRAY_PANEL_WIDTH, TRAY_PANEL_HEIGHT, placeTrayPanel } = require("../electron/bridges/trayPanelBounds.cjs");
  const { windowsCssRoundedOverlayChromeOptions } = require("../electron/bridges/windowManager/windowsWindowChrome.cjs");

  const userData = fs.mkdtempSync(`${tempDirBridge.getTempFilePath("tray-layout-test")}-`);
  app.setPath("userData", userData);
  app.on("window-all-closed", () => {});
  const scale = process.env.NETCATTY_TRAY_LAYOUT_SCALE || "1";
  app.commandLine.appendSwitch("force-device-scale-factor", scale);
  let win;
  let panelBounds;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const finish = (code) => {
    clearTimeout(watchdog);
    if (win && !win.isDestroyed()) win.destroy();
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch (error) {
      console.warn("Unable to remove tray layout test data:", error.message);
    }
    app.exit(code);
  };
  const watchdog = setTimeout(() => {
    console.error("TRAY_LAYOUT_FAIL timed out");
    finish(1);
  }, 30_000);

  // Only the desktop service boundary is faked. Load the complete built tray
  // route, including AppLockGate, providers, and the production styles.
  const preload = path.join(userData, "preload.cjs");
  fs.writeFileSync(preload, `
    const { contextBridge, ipcRenderer } = require('electron');
    let state = { initialized: true, locked: false, reason: null, version: 1 };
    const listen = (channel, callback) => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    };
    listen('test:lock-state', next => { state = next; });
    contextBridge.exposeInMainWorld('netcatty', {
      getAppLockRuntimeState: async () => state,
      onAppLockRuntimeStateChanged: callback => listen('test:lock-state', callback),
      onTrayPanelMenuData: callback => listen('test:menu-data', callback),
      hideTrayPanel: () => ipcRenderer.send('test:hide-tray'),
    });
  `);

  const waitFor = async (expression) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await win.webContents.executeJavaScript(expression)) return;
      await delay(50);
    }
    assert.fail(`Timed out waiting for ${expression}`);
  };
  const checkLayout = async (label, locked = false, expectedBounds = panelBounds) => {
    const actual = await win.webContents.executeJavaScript(`(() => {
      const panel = document.getElementById('tray-panel-root');
      const bounds = panel.getBoundingClientRect();
      const background = document.querySelector('[data-app-lock-background]');
      return {
        width: bounds.width, height: bounds.height,
        viewportWidth: innerWidth, viewportHeight: innerHeight, deviceScale: devicePixelRatio,
        inert: background.inert, hidden: background.getAttribute('aria-hidden'),
      };
    })()`);
    const detail = `${label}: ${JSON.stringify({ ...actual, expectedBounds, nativeBounds: win.getContentBounds() })}`;
    assert.equal(actual.viewportWidth, expectedBounds.width, detail);
    assert.equal(actual.viewportHeight, expectedBounds.height, detail);
    if (process.platform === "win32") assert.equal(actual.deviceScale, Number(scale), label);
    assert.equal(actual.width, actual.viewportWidth, detail);
    assert.equal(actual.height, actual.viewportHeight, `${label}: panel must fill the window, got ${JSON.stringify(actual)}`);
    assert.equal(actual.inert, locked, `${label}: background interaction guard`);
    assert.equal(actual.hidden, locked ? "true" : null, `${label}: accessibility guard`);
    console.log(`TRAY_LAYOUT_PASS ${label} scale=${actual.deviceScale} ${actual.width}x${actual.height}`);
  };

  void app.whenReady().then(async () => {
    const { workArea, bounds, scaleFactor } = screen.getPrimaryDisplay();
    console.log("TRAY_LAYOUT_DISPLAY", JSON.stringify({ workArea, bounds, scaleFactor }));
    panelBounds = placeTrayPanel({
      anchor: { x: workArea.x + workArea.width - 24, y: workArea.y + workArea.height, width: 24, height: 24 },
      workArea,
      width: TRAY_PANEL_WIDTH,
      height: TRAY_PANEL_HEIGHT,
    });
    win = new BrowserWindow({
      width: TRAY_PANEL_WIDTH,
      height: TRAY_PANEL_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      ...windowsCssRoundedOverlayChromeOptions(),
      webPreferences: { preload, contextIsolation: true, sandbox: false, zoomFactor: 1 },
    });
    ipcMain.on("test:hide-tray", () => win.hide());
    // Match showTrayPanel, including its intentional size limit when the
    // display work area cannot fit the full 360x520 panel (e.g. at 200% scale).
    win.setBounds(panelBounds, false);
    await win.loadFile(path.join(__dirname, "../dist/index.html"), { hash: "/tray" });
    await waitFor("Boolean(document.getElementById('tray-panel-root'))");
    win.show();
    await checkLayout("empty-first-open");

    for (let attempt = 1; attempt <= 3; attempt++) {
      win.hide();
      win.setBounds(panelBounds, false);
      win.show();
      await checkLayout(`reopen-${attempt}`);
    }

    const sessions = Array.from({ length: 30 }, (_, i) => ({
      id: `test-${i}`, label: `Test server ${i}`, hostLabel: `Test server ${i}`, status: "connected",
    }));
    win.webContents.send("test:menu-data", { sessions });
    await waitFor("document.getElementById('tray-panel-root').textContent.includes('Test server 29')");
    await checkLayout("many-sessions");

    win.webContents.send("test:lock-state", { initialized: true, locked: true, reason: "manual", version: 2 });
    await waitFor("document.querySelector('[data-app-lock-background]').inert");
    await checkLayout("locked", true);
    win.webContents.send("test:lock-state", { initialized: true, locked: false, reason: null, version: 3 });
    await waitFor("!document.querySelector('[data-app-lock-background]').inert");
    await checkLayout("unlocked");

    win.webContents.send("test:menu-data", { sessions: [] });
    await waitFor("!document.getElementById('tray-panel-root').textContent.includes('Test server 29')");
    await checkLayout("empty-again");

    // Also exercise a short work area on machines with a large desktop. The
    // original regression leaves an empty panel at 250px, even in a 340px window.
    const shortBounds = { ...panelBounds, height: Math.min(panelBounds.height, 340) };
    win.hide();
    win.setBounds(shortBounds, false);
    win.show();
    await waitFor(`innerHeight === ${shortBounds.height}`);
    await checkLayout("short-work-area", false, shortBounds);

    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    for (let attempt = 0; attempt < 50 && win.isVisible(); attempt++) await delay(20);
    assert.equal(win.isVisible(), false, "Escape closes the panel");
    finish(0);
  }).catch((error) => {
    console.error("TRAY_LAYOUT_FAIL", error);
    finish(1);
  });
}
