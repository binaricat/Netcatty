"use strict";
/* global process, __dirname, console, document, getComputedStyle */
if (!process.versions.electron) {
  require("node:test")("foreground intense renders without changing terminal data", {
    skip: "run with Electron to exercise DOM and WebGL rendering",
  }, () => {});
} else {
  const { app, BrowserWindow } = require("electron");
  const fs = require("node:fs");
  const path = require("node:path");
  const esbuild = require("esbuild");
  const temp = require("../electron/bridges/tempDirBridge.cjs");
  const root = path.resolve(__dirname, "..");
  const userData = fs.mkdtempSync(`${temp.getTempFilePath("foreground-intense")}-`);
  app.setPath("userData", userData);
  app.on("window-all-closed", () => {});
  let win;
  const cleanup = code => {
    win?.destroy();
    fs.rmSync(userData, { recursive: true, force: true });
    app.exit(code);
  };
  const bundle = esbuild.buildSync({
    stdin: {
      contents: 'export { Terminal } from "@xterm/xterm"; export { WebglAddon } from "@xterm/addon-webgl"; export { SerializeAddon } from "@xterm/addon-serialize";',
      resolveDir: root,
    },
    bundle: true, format: "cjs", platform: "browser", write: false,
  }).outputFiles[0].text;
  async function exercise({ Terminal, WebglAddon, SerializeAddon }) {
    const assert = require("node:assert/strict");
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const results = [];
    for (const renderer of ["dom", "webgl"]) {
      const host = document.createElement("div");
      host.style.cssText = "width:800px;height:250px";
      document.body.appendChild(host);
      const theme = { foreground: "#aaaaaa", background: "#000000", foregroundIntense: "#ff0000", cyan: "#00aaaa", brightCyan: "#00ffff" };
      const term = new Terminal({ cols: 40, rows: 8, fontFamily: "monospace", fontSize: 20, cursorBlink: false, allowProposedApi: true, theme, drawBoldTextInBrightColors: true, minimumContrastRatio: 1 });
      term.open(host);
      let addon;
      if (renderer === "webgl") {
        addon = new WebglAddon({ preserveDrawingBuffer: true });
        term.loadAddon(addon);
        assert.ok(host.querySelector("canvas"), "WebGL must actually initialize");
      }
      const serial = new SerializeAddon();
      term.loadAddon(serial);
      const write = data => new Promise(resolve => term.write(data, resolve));
      const render = async () => { term.refresh(0, term.rows - 1); await wait(100); };
      const color = (x, background = false) => {
        if (renderer === "dom") {
          const spans = host.querySelector(".xterm-rows").firstElementChild.children;
          let offset = 0;
          for (const span of spans) {
            if (x < offset + span.textContent.length) return background ? getComputedStyle(span).backgroundColor : getComputedStyle(span).color;
            offset += span.textContent.length;
          }
          throw new Error("DOM cell not found: " + x);
        }
        const canvas = [...host.querySelectorAll(".xterm-screen canvas")].find(c => c.getContext("webgl2"));
        const gl = canvas?.getContext("webgl2");
        assert.ok(gl, "read actual WebGL output");
        const cell = term._core._renderService.dimensions.device.cell;
        const pixels = new Uint8Array(4 * Math.floor(cell.width) * Math.floor(cell.height));
        gl.readPixels(Math.floor(x * cell.width), canvas.height - Math.floor(cell.height), Math.floor(cell.width), Math.floor(cell.height), gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const counts = new Map();
        for (let i = 0; i < pixels.length; i += 4) {
          if (!(pixels[i] || pixels[i + 1] || pixels[i + 2])) continue;
          const key = `rgb(${pixels[i]}, ${pixels[i + 1]}, ${pixels[i + 2]})`;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || "rgb(0, 0, 0)";
      };
      // Blocks have a solid interior, allowing exact pixel checks despite font antialiasing.
      await write("\x1b[?25l\x1b[0m█\x1b[1m█\x1b[0;36m█\x1b[1m█\x1b[39;1m█\x1b[0m");
      await render();
      assert.deepEqual([0, 1, 2, 3, 4].map(x => color(x)), ["rgb(170, 170, 170)", "rgb(255, 0, 0)", "rgb(0, 170, 170)", "rgb(0, 255, 255)", "rgb(255, 0, 0)"], renderer + " issue examples");
      assert.equal(term.buffer.active.getLine(0).getCell(1).isFgDefault(), true, "rendering must preserve default color provenance");
      const snapshot = serial.serialize();
      assert.ok(!snapshot.includes("38;2;255;0;0"), "snapshot must not bake theme colors into data");
      term.options.theme = { ...theme, foregroundIntense: "#00ff00" };
      await render();
      assert.equal(color(1), "rgb(0, 255, 0)", renderer + " recolors existing text");
      term.options.theme = { ...theme, foregroundIntense: undefined };
      await render();
      assert.equal(color(1), "rgb(170, 170, 170)", renderer + " disabling restores existing text");
      term.options.theme = { ...theme, foregroundIntense: "#00ff00" };
      term.reset();
      await write(snapshot);
      await render();
      assert.equal(color(1), "rgb(0, 255, 0)", renderer + " snapshot uses current theme");
      await write("\x1b[?1049h\x1b[2J\x1b[H\x1b[1m█\x1b[0m");
      await render();
      assert.equal(color(0), "rgb(0, 255, 0)", renderer + " alternate screen");
      await write("\x1b[?1049l");
      await render();
      assert.equal(color(1), "rgb(0, 255, 0)", renderer + " restores normal screen");
      term.reset();
      await write("\x1b[?25l█\x1b[1m█\x1b[0m");
      await render();
      assert.deepEqual([0, 1].map(x => color(x)), ["rgb(170, 170, 170)", "rgb(0, 255, 0)"], renderer + " full reset");
      term.options.theme = { ...theme, foregroundIntense: "#00ff00", selectionForeground: "#ff00ff", selectionBackground: "#000000", selectionInactiveBackground: "#000000" };
      term.reset();
      await write("\x1b[?25lM\x1b[1mM\x1b[0m");
      term.select(1, 0, 1);
      await render();
      assert.equal(color(1), "rgb(255, 0, 255)", renderer + " selection overrides intense");
      const marker = term.registerMarker(0);
      const decoration = term.registerDecoration({ marker, x: 1, width: 1, foregroundColor: "#ffff00", layer: "top" });
      await render();
      assert.equal(color(1), "rgb(255, 255, 0)", renderer + " top keyword decoration overrides selection/intense");
      decoration.dispose();
      marker.dispose();
      term.clearSelection();
      term.reset();
      await write("\x1b[?25l\x1b[1;7m█ \x1b[0m");
      await render();
      assert.equal(color(0), "rgb(0, 0, 0)", renderer + " inverse foreground is default background");
      assert.equal(color(1, true), "rgb(0, 255, 0)", renderer + " inverse background uses intense");
      results.push({ renderer, issueExamples: true, themeSwitch: true, disable: true, snapshot: true, alternateScreen: true, reset: true, selection: true, decoration: true, inverse: true });
      addon?.dispose();
      term.dispose();
      host.remove();
    }
    return results;
  }
  void app.whenReady().then(async () => {
    win = new BrowserWindow({ show: true, width: 900, height: 400, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
    await win.loadURL("data:text/html,<body style='margin:0;background:black'>");
    await win.webContents.insertCSS(fs.readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8"));
    const result = await win.webContents.executeJavaScript(`(async () => { const loaded = {exports:{}}; ((module,exports)=>{${bundle}})(loaded,loaded.exports); return (${exercise.toString()})(loaded.exports); })()`);
    console.log("FOREGROUND_INTENSE_RENDERING_OK", JSON.stringify(result));
    cleanup(0);
  }).catch(error => { console.error(error); cleanup(1); });
}
