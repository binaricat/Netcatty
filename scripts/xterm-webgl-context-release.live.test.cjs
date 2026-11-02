"use strict";

if (!process.versions.electron) {
  require("node:test")("WebGL context disposal", { skip: "run with Electron" }, () => {});
} else {
const assert = require("node:assert/strict");
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.commandLine.appendSwitch("use-angle", "swiftshader");
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
app.on("window-all-closed", () => {});

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  });
  await window.loadURL("data:text/html,<div id='terminal'></div>");
  const esmSource = fs.readFileSync(path.join(path.dirname(require.resolve("@xterm/addon-webgl")), "addon-webgl.mjs"));
  const results = await window.webContents.executeJavaScript(`(async () => {
    const { Terminal } = require(${JSON.stringify(require.resolve("@xterm/xterm"))});
    const commonjs = require(${JSON.stringify(require.resolve("@xterm/addon-webgl"))});
    const esm = await import(${JSON.stringify("data:text/javascript;base64," + esmSource.toString("base64"))});
    const results = [];
    for (let iteration = 0; iteration < 20; iteration++) {
      const { WebglAddon } = iteration % 2 ? esm : commonjs;
      const terminal = new Terminal({ cols: 172, rows: 45 });
      terminal.open(document.getElementById('terminal'));
      const addon = new WebglAddon();
      terminal.loadAddon(addon);
      await new Promise(resolve => terminal.write('GPU context lifecycle test', resolve));
      await new Promise(resolve => requestAnimationFrame(resolve));
      const gl = addon._renderer._gl;
      const extension = gl.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('WEBGL_lose_context unavailable');
      let releases = 0;
      const loseContext = extension.loseContext.bind(extension);
      extension.loseContext = () => { releases++; loseContext(); };
      terminal.dispose();
      await new Promise(resolve => setTimeout(resolve, 10));
      results.push({ releases, lost: gl.isContextLost() });
      document.getElementById('terminal').replaceChildren();
    }
    return results;
  })()`);
  assert.equal(results.length, 20);
  for (const result of results) {
    assert.deepEqual(result, { releases: 1, lost: true });
  }
  console.log("PASS: 20 terminal disposals each released exactly one real WebGL context");
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
}
