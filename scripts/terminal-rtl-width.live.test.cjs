"use strict";
/* global process, __dirname, console */
if (!process.versions.electron) {
  require("node:test")("RTL DOM cell geometry", { skip: "run with Electron" }, () => {});
} else {
  const { app, BrowserWindow } = require("electron");
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { buildSync } = require("esbuild");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-rtl-width-"));
  app.setPath("userData", profile);
  app.on("window-all-closed", () => {});
  const bundle = buildSync({
    stdin: {
      contents: 'export { Terminal } from "@xterm/xterm"; export { findRightToLeftRuns } from "./components/terminal/runtime/terminalBidiJoiner";',
      resolveDir: path.resolve(__dirname, ".."),
    },
    bundle: true, format: "iife", globalName: "rtlTest", platform: "browser", write: false,
  }).outputFiles[0].text;
  let win;
  function finish(code) {
    win?.destroy();
    app.exit(code);
  }
  void app.whenReady().then(async () => {
    win = new BrowserWindow({ show: true, width: 600, height: 320 });
    await win.loadURL("data:text/html,<div id='terminal' style='width:500px;height:260px'></div>");
    await win.webContents.insertCSS(fs.readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8"));
    const measurement = await win.webContents.executeJavaScript(`(async () => {
      ${bundle}
      const fontFamily = '"Noto Sans Mono", "DejaVu Sans", monospace';
      const term = new rtlTest.Terminal({cols: 30, rows: 8, fontSize: 24, fontFamily, allowProposedApi: true});
      term.open(document.querySelector("#terminal"));
      term.registerCharacterJoiner(text => text.startsWith("ffi") ? [[0, 3]] : rtlTest.findRightToLeftRuns(text));
      const a = "יייייייי", b = "שששששששש";
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.font = "24px " + fontFamily;
      await new Promise(resolve => term.write(a + " Z\\r\\n" + b + " Z\\r\\n01234567 Z\\r\\nffi Z\\r\\n", resolve));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rows = [...document.querySelectorAll(".xterm-rows > div")].slice(0, 4);
      const geometry = rows.map(row => {
        const spans = [...row.children];
        const suffix = spans.find(span => span.textContent.includes("Z"));
        const content = spans[0].firstElementChild ?? spans[0];
        const range = document.createRange();
        range.selectNodeContents(content);
        const glyphs = range.getBoundingClientRect();
        const cellBox = spans[0].getBoundingClientRect();
        return {
          glyphWidth: glyphs.width,
          glyphRight: glyphs.right - cellBox.left,
          transform: content.style.transform,
          marker: suffix.getBoundingClientRect().right - row.getBoundingClientRect().left,
          joinedWidth: spans[0].getBoundingClientRect().width,
          text: row.textContent,
          first: spans[0].textContent,
          widthStyle: spans[0].style.width,
          overflow: spans[0].style.overflow,
        };
      });
      return { geometry, cell: term._core._renderService.dimensions.css.cell.width, natural: [ctx.measureText(a).width, ctx.measureText(b).width] };
    })()`);
    console.log(JSON.stringify(measurement));
    const [thin, wide, ascii, ligature] = measurement.geometry;
    assert.equal(ligature.first, "ffi");
    assert.equal(ligature.widthStyle, "", "ASCII ligatures must keep their existing layout");
    assert.equal(ligature.overflow, "", "ASCII ligature overhang must not be clipped");
    // Ensure the fixture actually exercises unequal font metrics rather than
    // passing accidentally on a monospace/fallback-only test environment.
    assert.ok(Math.abs(measurement.natural[0] - measurement.natural[1]) > 8);
    assert.ok(measurement.natural[1] > measurement.cell * 8 + 8, "wide fallback must exceed its cell allocation");
    assert.notEqual(wide.transform, "", "nominally oversized RTL glyphs must actually fit, not just clip");
    assert.equal(wide.overflow, "", "RTL text must not be hidden by overflow clipping");
    assert.ok(wide.glyphRight <= wide.joinedWidth + 1, JSON.stringify(measurement));
    assert.equal(thin.transform, "", "narrow RTL text must not be unnecessarily rescaled");
    for (const row of [thin, wide]) {
      assert.match(row.text, / Z/);
      assert.ok(Math.abs(row.joinedWidth - measurement.cell * 8) <= 1, JSON.stringify(measurement));
      assert.ok(Math.abs(row.marker - ascii.marker) <= 1, JSON.stringify(measurement));
    }
    finish(0);
  }).catch(error => { console.error(error); finish(1); });
}
