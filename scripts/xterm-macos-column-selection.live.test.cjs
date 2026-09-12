"use strict";

if (!process.versions.electron) {
  const test = require("node:test");
  test("macOS Option drag keeps rectangular and remote mouse behavior", {
    skip: "run with Electron on macOS",
  }, () => {});
} else if (process.platform !== "darwin") {
  const skipElectron = require("electron");
  process.stdout.write("XTERM_MACOS_COLUMN_SELECTION_SKIP platform is not macOS\n");
  skipElectron.app.exit(0);
} else {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const { pathToFileURL } = require("node:url");
  const electron = require("electron");
  const tempDirBridge = require("../electron/bridges/tempDirBridge.cjs");

  const appRoot = path.resolve(__dirname, "..");
  const userData = fs.mkdtempSync(
    `${tempDirBridge.getTempFilePath("xterm-macos-selection")}-`,
  );
  electron.app.setPath("userData", userData);
  electron.app.on("window-all-closed", () => {});
  let window = null;

  const cleanup = (exitCode) => {
    if (window && !window.isDestroyed()) window.destroy();
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch (error) {
      console.warn("Unable to remove xterm selection test data:", error);
    } finally {
      electron.app.exit(exitCode);
    }
  };
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  void electron.app.whenReady().then(async () => {
    window = new electron.BrowserWindow({
      show: process.env.NETCATTY_XTERM_SELECTION_SHOW_WINDOW === "1",
      width: 860,
      height: 400,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
        sandbox: false,
        // The harness imports the shipped ESM bundle directly from disk.
        webSecurity: false,
        backgroundThrottling: false,
      },
    });
    await window.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(
        "<!doctype html><style>html,body{margin:0;background:#111}#terminal{width:800px;height:320px;padding:20px}</style><div id=terminal></div>",
      ),
    );

    const xtermPath = require.resolve("@xterm/xterm", { paths: [appRoot] });
    const xtermEsmUrl = pathToFileURL(path.join(path.dirname(xtermPath), "xterm.mjs")).href;
    await window.webContents.executeJavaScript(`(async () => {
      const { Terminal } = await import(${JSON.stringify(xtermEsmUrl)});
      const term = new Terminal({
        cols: 20,
        rows: 6,
        fontFamily: "Menlo",
        fontSize: 18,
        allowProposedApi: true,
        macOptionClickForcesSelection: true,
        macOptionIsMeta: false,
        altClickMovesCursor: true,
      });
      let data = "";
      term.onData(value => { data += value; });
      term.open(document.getElementById("terminal"));
      const content = [
        "ABCDEFGHIJKLMNOPQRST",
        "abcdefghijklmnopqrst",
        "01234567890123456789",
        "!@#$%^&*()_+-=[]{}|;",
      ].join("\\r\\n");
      window.harness = {
        reset: (mouseTracking, optionAsMeta) => new Promise(resolve => {
          data = "";
          term.reset();
          term.clearSelection();
          term.options.macOptionIsMeta = optionAsMeta;
          term.options.altClickMovesCursor = !optionAsMeta;
          term.write((mouseTracking ? "\\x1b[?1002h\\x1b[?1006h" : "\\x1b[?1002l\\x1b[?1006l") + content, resolve);
        }),
        geometry: () => {
          const screen = term.element.querySelector(".xterm-screen").getBoundingClientRect();
          return {
            left: screen.left,
            top: screen.top,
            cellWidth: screen.width / term.cols,
            cellHeight: screen.height / term.rows,
          };
        },
        state: () => ({
          selection: term.getSelection(),
          data,
          mouseTrackingMode: term.modes.mouseTrackingMode,
          optionAsMeta: term.options.macOptionIsMeta,
        }),
      };
    })()`);

    const drag = async ({ alt = false } = {}) => {
      const geometry = await window.webContents.executeJavaScript("window.harness.geometry()");
      const point = (column, row) => ({
        x: Math.round(geometry.left + geometry.cellWidth * (column + 0.5)),
        y: Math.round(geometry.top + geometry.cellHeight * (row + 0.5)),
      });
      const start = point(1, 0);
      const end = point(5, 2);
      /** @type {Array<"alt">} */
      const modifiers = alt ? ["alt"] : [];
      /** @type {Array<"alt" | "leftbuttondown">} */
      const moveModifiers = alt ? ["alt", "leftbuttondown"] : ["leftbuttondown"];
      window.webContents.sendInputEvent({ type: "mouseDown", ...start, button: "left", clickCount: 1, modifiers });
      window.webContents.sendInputEvent({ type: "mouseMove", ...end, button: "left", modifiers: moveModifiers });
      window.webContents.sendInputEvent({ type: "mouseUp", ...end, button: "left", clickCount: 1, modifiers });
      await delay(100);
      return window.webContents.executeJavaScript("window.harness.state()");
    };
    const runScenario = async (mouseTracking, alt, optionAsMeta = false) => {
      await window.webContents.executeJavaScript(
        `window.harness.reset(${mouseTracking}, ${optionAsMeta})`,
      );
      return drag({ alt });
    };

    const normal = await runScenario(false, false);
    const option = await runScenario(false, true);
    const remote = await runScenario(true, false);
    const remoteOption = await runScenario(true, true);
    const optionAsMeta = await runScenario(false, true, true);
    const remoteOptionAsMeta = await runScenario(true, true, true);
    const optionAfterMeta = await runScenario(false, true, false);
    const expectedColumn = "BCDEF\nbcdef\n12345";
    const expectedNormal = "BCDEFGHIJKLMNOPQRST\nabcdefghijklmnopqrst\n012345";

    assert.equal(
      normal.selection,
      expectedNormal,
      `ordinary drag must remain a normal selection: ${JSON.stringify(normal)}`,
    );
    assert.equal(option.selection, expectedColumn, `Option drag must select columns: ${JSON.stringify(option)}`);
    assert.equal(remote.selection, "", `remote drag must not create a local selection: ${JSON.stringify(remote)}`);
    assert.match(remote.data, /\x1b\[<0;\d+;\d+M/, `remote drag must report mouse down: ${JSON.stringify(remote)}`);
    assert.match(remote.data, /\x1b\[<32;\d+;\d+M/, `remote drag must report mouse movement: ${JSON.stringify(remote)}`);
    assert.match(remote.data, /\x1b\[<0;\d+;\d+m/, `remote drag must report mouse up: ${JSON.stringify(remote)}`);
    assert.equal(
      remoteOption.selection,
      expectedColumn,
      `Option drag must force rectangular selection in mouse mode: ${JSON.stringify(remoteOption)}`,
    );
    assert.equal(remoteOption.data, "", `forced local selection must not emit mouse reports: ${JSON.stringify(remoteOption)}`);
    assert.equal(
      optionAsMeta.selection,
      expectedNormal,
      `Option-as-Meta must disable rectangular selection: ${JSON.stringify(optionAsMeta)}`,
    );
    assert.equal(
      remoteOptionAsMeta.selection,
      expectedNormal,
      `Option-as-Meta must disable rectangular selection in mouse mode: ${JSON.stringify(remoteOptionAsMeta)}`,
    );
    assert.equal(
      remoteOptionAsMeta.data,
      "",
      `Option must still force local selection in mouse mode: ${JSON.stringify(remoteOptionAsMeta)}`,
    );
    assert.equal(
      optionAfterMeta.selection,
      expectedColumn,
      `turning Option-as-Meta off must restore rectangular selection: ${JSON.stringify(optionAfterMeta)}`,
    );

    process.stdout.write(
      `XTERM_MACOS_COLUMN_SELECTION_OK ${JSON.stringify({ normal, option, remote, remoteOption, optionAsMeta, remoteOptionAsMeta, optionAfterMeta })}\n`,
    );
    cleanup(0);
  }).catch((error) => {
    console.error(error);
    cleanup(1);
  });
}
