"use strict";

/* global process, __dirname, console */

if (!process.versions.electron) {
  const test = require("node:test");
  test("inline keyword highlighting stays responsive", {
    skip: "run with Electron so the real WebGL renderer is available",
  }, () => {});
} else {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const electron = require("electron");
  const esbuild = require("esbuild");
  const tempDirBridge = require("../electron/bridges/tempDirBridge.cjs");

  const appRoot = path.resolve(__dirname, "..");
  const showWindow = process.env.NETCATTY_TERMINAL_PERF_SHOW_WINDOW === "1";
  const userData = fs.mkdtempSync(`${tempDirBridge.getTempFilePath("xterm-keyword-highlight-perf")}-`);
  electron.app.setPath("userData", userData);
  electron.app.on("window-all-closed", () => {});
  let window = null;

  const cleanup = (exitCode) => {
    if (window && !window.isDestroyed()) window.destroy();
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch (error) {
      console.warn("Unable to remove xterm performance test data:", error);
    } finally {
      electron.app.exit(exitCode);
    }
  };

  void electron.app.whenReady().then(async () => {
    window = new electron.BrowserWindow({
      show: showWindow,
      width: 1000,
      height: 640,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: false,
        nodeIntegration: true,
        sandbox: false,
      },
    });
    await window.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(
        "<!doctype html><style>html,body,#terminal{width:920px;height:560px;margin:0}</style><div id=terminal></div>",
      ),
    );

    const xtermPath = require.resolve("@xterm/xterm", { paths: [appRoot] });
    const webglPath = require.resolve("@xterm/addon-webgl", { paths: [appRoot] });
    const serializePath = require.resolve("@xterm/addon-serialize", { paths: [appRoot] });
    const highlighterPath = path.join(appRoot, "components/terminal/keywordHighlight.ts");
    const pressurePath = path.join(appRoot, "components/terminal/runtime/terminalOutputPressure.ts");
    const highlighterBundle = esbuild.buildSync({
      stdin: {
        contents: [
          `export * from ${JSON.stringify(highlighterPath)};`,
          `export { noteTerminalOutputPressureData } from ${JSON.stringify(pressurePath)};`,
        ].join("\n"),
        loader: "ts",
        resolveDir: appRoot,
      },
      bundle: true,
      format: "cjs",
      platform: "browser",
      target: "chrome142",
      write: false,
    }).outputFiles[0].text;

    const result = await window.webContents.executeJavaScript(`(async () => {
      try {
      const { Terminal } = require(${JSON.stringify(xtermPath)});
      const { WebglAddon } = require(${JSON.stringify(webglPath)});
      const { SerializeAddon } = require(${JSON.stringify(serializePath)});
      const highlighterModule = { exports: {} };
      ((module, exports) => { ${highlighterBundle} })(highlighterModule, highlighterModule.exports);
      const { KeywordHighlighter, noteTerminalOutputPressureData } = highlighterModule.exports;
      const term = new Terminal({
        allowProposedApi: true,
        cols: 120,
        cursorBlink: false,
        rows: 40,
        scrollback: 10000,
      });
      term.open(document.getElementById("terminal"));
      let renderer = "dom";
      try {
        term.loadAddon(new WebglAddon());
        renderer = "webgl";
      } catch {}
      const serializer = new SerializeAddon();
      term.loadAddon(serializer);
      const highlighter = new KeywordHighlighter(term);
      const redRules = [{
        id: "error",
        label: "Error",
        patterns: ["ERROR", "failed", "10\\\\.2\\\\.\\\\d+\\\\.\\\\d+"],
        color: "#F87171",
        enabled: true,
      }];
      const blueRules = redRules.map(rule => ({ ...rule, color: "#60A5FA" }));
      highlighter.setRules(redRules, true);
      const originalRecolorRange = highlighter.recolorRange.bind(highlighter);
      let measuredRecolorRows = 0;
      let measuredRefreshes = 0;
      highlighter.recolorRange = (startY, endY, refresh, force) => {
        measuredRecolorRows += Math.abs(endY - startY) + 1;
        if (refresh) measuredRefreshes += 1;
        return originalRecolorRange(startY, endY, refresh, force);
      };
      const write = data => new Promise(resolve => term.write(data, resolve));
      const waitPaint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      // #3271: inspect the first actual renderer frame for tail -200f and
      // subsequent coalesced log ticks, before the deferred catch-up can run.
      let streamingFrames = 0;
      let uncoloredStreamingFrame = false;
      const streamingRender = term.onRender(() => {
        streamingFrames += 1;
        for (let row = 0; row < term.rows; row += 1) {
          const line = term.buffer.active.getLine(term.buffer.active.viewportY + row);
          const column = line?.translateToString(true).indexOf("ERROR") ?? -1;
          if (column >= 0 && line.getCell(column).getFgColor() !== 0xf87171) {
            uncoloredStreamingFrame = true;
          }
        }
      });
      for (const lines of [200, 12, 12, 12]) {
        const batch = Array.from({ length: lines }, () => "log ERROR").join("\\r\\n") + "\\r\\n";
        noteTerminalOutputPressureData(term, batch);
        await write(batch);
        await waitPaint();
        await new Promise(resolve => setTimeout(resolve, 120));
      }
      streamingRender.dispose();
      if (uncoloredStreamingFrame) throw new Error("Streaming output rendered before keyword color");
      if (streamingFrames < 4) throw new Error("Streaming renderer frames were not observed");
      await highlighter.whenSettled();
      term.reset();

      await write("row-1 ERROR\\r\\nrow-2 ERROR\\r\\nrow-3 ERROR\\r\\nrow-4 ERROR");
      await write("\\x1b[1;");
      await write(
        "1Hrow-2 ERROR\\x1b[2;1Hrow-3 ERROR"
          + "\\x1b[3;1Hrow-4 ERROR\\x1b[4;1Hprompt ER",
      );
      await write("ROR\\x1b[1;1H");
      await waitPaint();
      const moshFrame = serializer.serialize({ scrollback: 0 });
      const moshHighlightCount = (moshFrame.match(/38;2;248;113;113m/g) || []).length;
      term.reset();

      const moshRows = 40;
      const seedMoshRows = async () => {
        await write(Array.from(
          { length: moshRows },
          (_, index) => "old-" + (index + 1) + " ERROR",
        ).join("\\r\\n"));
      };
      const rowFrames = Array.from(
        { length: moshRows },
        (_, index) => "\\x1b[" + (index + 1) + ";1Hnew-" + (index + 1)
          + " ERROR\\x1b[1;1H",
      );
      await seedMoshRows();
      measuredRecolorRows = 0;
      measuredRefreshes = 0;
      const mergedMoshStart = performance.now();
      await write(rowFrames.join(""));
      await waitPaint();
      const mergedMoshMs = performance.now() - mergedMoshStart;
      const mergedMoshRecolorRows = measuredRecolorRows;
      const mergedMoshRefreshes = measuredRefreshes;
      term.reset();
      await seedMoshRows();
      measuredRecolorRows = 0;
      measuredRefreshes = 0;
      const splitMoshStart = performance.now();
      for (const rowFrame of rowFrames) await write(rowFrame);
      await waitPaint();
      const splitMoshMs = performance.now() - splitMoshStart;
      const splitMoshRecolorRows = measuredRecolorRows;
      const splitMoshRefreshes = measuredRefreshes;
      const splitMoshFrame = serializer.serialize({ scrollback: 0 });
      const splitMoshHighlightCount = (splitMoshFrame.match(/38;2;248;113;113m/g) || []).length;
      term.reset();

      let history = "";
      for (let line = 0; line < 10000; line += 1) {
        history += "2026-08-13 worker=" + (line % 32) + " ERROR failed from 10.2." + (line % 255) + "." + ((line * 7) % 255) + "\\r\\n";
      }

      const initialStart = performance.now();
      noteTerminalOutputPressureData(term, history);
      await write(history);
      await waitPaint();
      const initialWriteMs = performance.now() - initialStart;
      await new Promise(resolve => setTimeout(resolve, 650));
      await highlighter.whenSettled();
      const rebuildsBeforeEnter = highlighter.rebuildCount;

      const enterStart = performance.now();
      const prompt = "\\r\\nplain prompt # ";
      noteTerminalOutputPressureData(term, prompt);
      await write(prompt);
      await waitPaint();
      const enterWriteMs = performance.now() - enterStart;
      await new Promise(resolve => setTimeout(resolve, 650));
      await highlighter.whenSettled();
      const enterRebuildCount = highlighter.rebuildCount;

      const rebuildStart = performance.now();
      highlighter.setRules(blueRules, true);
      await highlighter.whenSettled();
      await waitPaint();
      const rebuildMs = performance.now() - rebuildStart;

      const serialized = serializer.serialize({ scrollback: 10000 });
      const pristine = highlighter.serializeAddon.serialize({ scrollback: 10000 });
      const state = {
        renderer,
        moshHighlightCount,
        mergedMoshMs,
        mergedMoshRecolorRows,
        mergedMoshRefreshes,
        splitMoshMs,
        splitMoshRecolorRows,
        splitMoshRefreshes,
        splitMoshHighlightCount,
        rawChars: history.length,
        initialWriteMs,
        rebuildsBeforeEnter,
        enterWriteMs,
        enterRebuildCount,
        rebuildMs,
        rebuildCount: highlighter.rebuildCount,
        blueMatchCount: (serialized.match(/38;2;96;165;250m/g) || []).length,
        pristineHasNetcattyColor: /38;2;(248;113;113|96;165;250)m/.test(pristine),
      };
      highlighter.dispose();
      term.dispose();
      return state;
      } catch (error) {
        return { executionError: String(error && (error.stack || error)) };
      }
    })()`);

    assert.equal(result.executionError, undefined, JSON.stringify(result));
    if (process.env.NETCATTY_TERMINAL_PERF_REQUIRE_WEBGL === "1") {
      assert.equal(result.renderer, "webgl", JSON.stringify(result));
    }
    assert.ok(result.moshHighlightCount >= 4, JSON.stringify(result));
    assert.ok(result.splitMoshHighlightCount >= 40, JSON.stringify(result));
    assert.ok(result.splitMoshRecolorRows <= 80, JSON.stringify(result));
    assert.ok(result.splitMoshRefreshes <= 80, JSON.stringify(result));
    assert.ok(result.splitMoshMs < 500, `split Mosh repaint regressed: ${JSON.stringify(result)}`);
    assert.equal(result.enterRebuildCount, result.rebuildsBeforeEnter, JSON.stringify(result));
    assert.equal(result.rebuildCount, result.rebuildsBeforeEnter + 1, JSON.stringify(result));
    assert.ok(result.blueMatchCount >= 10000, JSON.stringify(result));
    assert.equal(result.pristineHasNetcattyColor, false, JSON.stringify(result));
    assert.ok(result.enterWriteMs < 150, `Enter write regressed: ${JSON.stringify(result)}`);
    assert.ok(result.rebuildMs < 1000, `10k-line rule rebuild regressed: ${JSON.stringify(result)}`);
    process.stdout.write(`XTERM_KEYWORD_HIGHLIGHT_PERFORMANCE_OK ${JSON.stringify(result)}\n`);
    cleanup(0);
  }).catch((error) => {
    console.error(error);
    cleanup(1);
  });
}
