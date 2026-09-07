"use strict";
/* global process, __dirname, console */
if (!process.versions.electron) {
  require("node:test")("fit preserves terminal reading position", {
    skip: "run with Electron for real xterm viewport coverage",
  }, () => {});
} else {
  const { app, BrowserWindow } = require("electron");
  const fs = require("node:fs");
  const path = require("node:path");
  const esbuild = require("esbuild");
  const temp = require("../electron/bridges/tempDirBridge.cjs");
  const root = path.resolve(__dirname, "..");
  const userData = fs.mkdtempSync(`${temp.getTempFilePath("fit-scroll")}-`);
  app.setPath("userData", userData);
  app.on("window-all-closed", () => {});
  const source = fs.readFileSync(path.join(root, "components/Terminal.tsx"), "utf8");
  const start = source.indexOf("  const safeFit = (options?: SafeFitOptions) => {");
  const end = source.indexOf("  const prevIsResizingRef", start);
  if (start < 0 || end < 0) throw new Error("Cannot extract production safeFit");
  const safeFitSource = esbuild.transformSync(source.slice(start, end), { loader: "ts" }).code;
  const bundle = esbuild.buildSync({
    stdin: {
      contents: 'export {Terminal} from "@xterm/xterm"; export {alignTerminalViewportScroll, forceSyncRenderAfterResize, createSynchronizedOutputFitScheduler} from "./components/terminal/terminalHelpers";',
      loader: "ts", resolveDir: root,
    },
    bundle: true, format: "cjs", platform: "browser", write: false,
    define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta": "{}" },
  }).outputFiles[0].text;
  let win;
  const cleanup = code => {
    win?.destroy();
    fs.rmSync(userData, { recursive: true, force: true });
    app.exit(code);
  };
  void app.whenReady().then(async () => {
    win = new BrowserWindow({
      show: true, width: 1000, height: 700,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false },
    });
    await win.loadURL("data:text/html,<body style='background:%23111;color:white'><h3>Issue 3299: resize reading position</h3><div id='terminal'></div>");
    await win.webContents.insertCSS(fs.readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8"));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const assert = require('node:assert/strict');
      const loaded = {exports:{}};
      ((module,exports)=>{${bundle}})(loaded,loaded.exports);
      const {Terminal,forceSyncRenderAfterResize,createSynchronizedOutputFitScheduler} = loaded.exports;
      const alignTerminalViewportScroll = process.env.NETCATTY_FIT_BASELINE ? ()=>{} : loaded.exports.alignTerminalViewportScroll;
      const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
      const term = new Terminal({cols:80,rows:25,scrollback:1000,fontSize:14,allowProposedApi:true,smoothScrollDuration:0});
      const el = document.getElementById('terminal');
      el.style.cssText='width:900px;height:560px'; term.open(el);
      const write = data => new Promise(resolve=>term.write(data,resolve));
      const ref = current => ({current});
      const termRef=ref(term), containerRef=ref(el), isRendererActiveRef=ref(true), lastFittedSizeRef=ref(null);
      const autocompleteRepositionRef=ref(null), xtermRuntimeRef=ref(null), pendingWriteSafeFitRef=ref(null);
      const synchronizedFitSchedulerRef=ref(createSynchronizedOutputFitScheduler());
      let dimensions={cols:80,rows:25};
      const fitAddonRef=ref({proposeDimensions:()=>dimensions});
      const hasPendingTerminalWrites=()=>false;
      const XTERM_PERFORMANCE_CONFIG={resize:{useRAF:false}};
      const logger={warn:(message,error)=>{throw error || new Error(message)}};
      ${safeFitSource}
      const safeFitRef=ref(safeFit);
      const fit=(cols,rows)=>{dimensions={cols,rows};safeFit({force:true,immediate:true});};
      const domRow=()=>term._core._viewport._scrollableElement.getScrollPosition().scrollTop / term._core._renderService.dimensions.css.cell.height;
      const check=(expected,label)=>{
        assert.equal(term.buffer.active.viewportY,expected,label+' buffer');
        assert.ok(Math.abs(domRow()-expected)<0.01,label+' DOM expected '+expected+' actual '+domRow());
      };
      await write(Array.from({length:200},(_,i)=>'line '+i+' '+('A    B repeated '.repeat(7))).join('\\r\\n'));
      await wait(100); term.scrollToLine(70); await wait(50);
      fit(80,16); await wait(80); check(70,'shrink');
      fit(80,30); await wait(80); check(70,'grow');
      for(let rows=29;rows>=12;rows--){fit(80,rows);await wait(20);check(70,'drag '+rows);}
      term.scrollToBottom();await wait(50);fit(80,8);await wait(80);check(term.buffer.active.baseY,'pinned shrink');
      term.scrollLines(-1);await wait(50);check(term.buffer.active.baseY-1,'first scroll after shrink');
      term.scrollToLine(70);await wait(50);
      const oldSize=[term.cols,term.rows];
      await write('\\x1b[?2026h');fit(100,20);fit(120,24);await wait(80);
      assert.deepEqual([term.cols,term.rows],oldSize,'no reflow inside synchronized frame');
      term.scrollLines(-3);await wait(40);const selected=term.buffer.active.viewportY;
      await write('\\x1b[?2026l');await wait(120);
      assert.deepEqual([term.cols,term.rows],[120,24]);check(Math.min(selected,term.buffer.active.baseY),'user selected position');
      await write('\\x1b[?2026h');fit(90,18);await write('\\x1b[?2026l\\x1b[?2026h');await wait(70);
      assert.equal(term.cols,120,'a new synchronized frame delays retry');
      await write('\\x1b[?2026l');await wait(100);check(Math.min(selected,term.buffer.active.baseY),'mode reentry');
      await write('\\r\\n'+Array.from({length:1200},()=> 'A    B repeated').join('\\r\\n'));
      await wait(80);term.scrollToLine(100);await wait(30);
      await write('\\x1b[?2026h');fit(130,22);await write('\\r\\n'.repeat(5));
      const afterTrim=term.buffer.active.viewportY;
      await write('\\x1b[?2026l');await wait(100);check(afterTrim,'scrollback trim');
      await write('\\x1b[?2026h\\x1b[?1049h');fit(100,20);
      await write('alternate output\\x1b[?1049l\\x1b[?2026l');await wait(100);
      check(Math.min(afterTrim,term.buffer.active.baseY),'alternate buffer round trip');
      await write('\\x1b[?2026h');fit(110,21);await wait(1400);
      assert.equal(term.modes.synchronizedOutputMode,false,'xterm timeout releases output');
      assert.equal(term.cols,110,'fit retried after output timeout');
      const beforeDispose=term.cols;
      await write('\\x1b[?2026h');fit(140,25);synchronizedFitSchedulerRef.current.dispose();
      await write('\\x1b[?2026l');await wait(100);assert.equal(term.cols,beforeDispose,'teardown cancels retry');
      assert.ok(el.querySelector('.xterm-screen').getBoundingClientRect().height > 0,'real rendered terminal');
      return {passed:['shrink','grow','18 drag steps','bottom and next scroll','synchronized repeated spaced text','user scroll','mode reentry','full scrollback trim','alternate buffer','output timeout','cleanup'],viewportY:term.buffer.active.viewportY,domRow:domRow()};
    })()`);
    console.log(JSON.stringify(result));
    if (process.env.NETCATTY_FIT_SCREENSHOT) {
      fs.writeFileSync(process.env.NETCATTY_FIT_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    }
    cleanup(0);
  }).catch(error=>{console.error(error);cleanup(1);});
}
