"use strict";

if (!process.versions.electron) {
  const test = require("node:test");
  test("closed synchronized-output frames render before the next frame opens", {
    skip: "run with Electron so xterm's renderer is available",
  }, () => {});
} else {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const electron = require("electron");

  const appRoot = path.resolve(__dirname, "..");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-xterm-sync-render-"));
  electron.app.setPath("userData", userData);
  electron.app.commandLine.appendSwitch("disable-gpu");
  electron.app.on("window-all-closed", () => {});

  const cleanup = (exitCode) => {
    fs.rmSync(userData, { recursive: true, force: true });
    electron.app.exit(exitCode);
  };

  void electron.app.whenReady().then(async () => {
    const window = new electron.BrowserWindow({
      show: false,
      width: 640,
      height: 360,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
        sandbox: false,
      },
    });
    await window.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(
        "<!doctype html><style>html,body,#terminal{width:600px;height:320px;margin:0}</style><div id=terminal></div>",
      ),
    );

    const xtermPath = require.resolve("@xterm/xterm", { paths: [appRoot] });
    const result = await window.webContents.executeJavaScript(`(async () => {
      const { Terminal } = require(${JSON.stringify(xtermPath)});
      const term = new Terminal({ cols: 10, rows: 2, cursorBlink: false });
      term.open(document.getElementById("terminal"));

      const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
      await nextFrame();
      await nextFrame();

      const renders = [];
      const renderSubscription = term.onRender(event => renders.push(event));
      const write = data => new Promise(resolve => term.write(data, resolve));
      const firstFrameStart = "\\x1b[?2026h\\x1b[1;1HAAAAAAAAAA";
      const firstFrameClose = "\\x1b[2;1HBBBBBBBBBB\\x1b[?2026l";
      const secondFrameOpen = "\\x1b[?2026h\\x1b[1;1HCC";

      // Keep the synchronized frame open across two input chunks so xterm
      // buffers dirty rows, then queue the next frame before the completed
      // first frame's debounced paint can run.
      await write(firstFrameStart);
      await write(firstFrameClose);
      await write(secondFrameOpen);
      await nextFrame();
      await nextFrame();
      const rendersBeforeSecondFrameClose = renders.length;

      await write("\\x1b[?2026l");
      await nextFrame();
      renderSubscription.dispose();
      term.dispose();
      return { rendersBeforeSecondFrameClose };
    })()`);

    assert.ok(
      result.rendersBeforeSecondFrameClose > 0,
      `the completed first frame was not rendered before the second frame opened: ${JSON.stringify(result)}`,
    );
    process.stdout.write(`XTERM_SYNC_RENDER_OK ${JSON.stringify(result)}\n`);
    window.destroy();
    cleanup(0);
  }).catch((error) => {
    console.error(error);
    cleanup(1);
  });
}
