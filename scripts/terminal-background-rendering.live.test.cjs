"use strict";
/* global process, __dirname, console */
if (!process.versions.electron) {
  require("node:test")("background terminals stop painting without stopping output", {
    skip: "run with Electron to exercise real terminal visibility and rendering",
  }, () => {});
} else {
  const { app, BrowserWindow } = require("electron");
  const fs = require("node:fs");
  const path = require("node:path");
  const esbuild = require("esbuild");
  const temp = require("../electron/bridges/tempDirBridge.cjs");
  const root = path.resolve(__dirname, "..");
  const userData = fs.mkdtempSync(`${temp.getTempFilePath("background-rendering")}-`);
  app.setPath("userData", userData);
  app.on("window-all-closed", () => {});
  let win;
  const cleanup = (code) => {
    win?.destroy();
    fs.rmSync(userData, { recursive: true, force: true });
    app.exit(code);
  };
  const bundle = esbuild.buildSync({
    stdin: {
      contents: [
        'export {createXTermRuntime} from "./components/terminal/runtime/createXTermRuntime";',
        'export {DEFAULT_TERMINAL_SETTINGS} from "./domain/models/terminal";',
        'export {resolveInactiveTerminalPaneStyle} from "./components/terminalPaneVisibility";',
      ].join("\n"),
      loader: "ts", resolveDir: root,
    },
    bundle: true, format: "cjs", platform: "browser", target: "chrome148", write: false,
    define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta": "{}" },
  }).outputFiles[0].text;
  void app.whenReady().then(async () => {
    win = new BrowserWindow({
      show: true, width: 1100, height: 740,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false },
    });
    await win.loadURL("data:text/html,<body style='margin:0;background:%23111'><div id='root'></div>");
    await win.webContents.insertCSS(fs.readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8"));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const assert = require('node:assert/strict');
      const loaded = {exports:{}};
      ((module,exports)=>{${bundle}})(loaded,loaded.exports);
      const {createXTermRuntime,DEFAULT_TERMINAL_SETTINGS,resolveInactiveTerminalPaneStyle} = loaded.exports;
      const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
      const ref = current => ({current});
      const panes = [];
      const root = document.getElementById('root');
      root.style.cssText = 'position:relative;width:1050px;height:660px;overflow:hidden';
      const visibleStyle = {left:'0px',top:'0px',width:'1050px',height:'660px'};
      const apply = (pane, visible, layout = visibleStyle) => {
        const style = visible ? layout : resolveInactiveTerminalPaneStyle(layout,{width:1050,height:660},false,true);
        pane.el.style.cssText = 'position:absolute;background:#111';
        Object.assign(pane.el.style,style);
        pane.el.style.zIndex = visible ? '10' : '0';
      };
      for(let index=0;index<5;index++) {
        const el=document.createElement('div');root.appendChild(el);
        const pane={el,frames:0};apply(pane,true);
        const r=createXTermRuntime({
          container:el,host:{id:'test-'+index,label:'test',hostname:'localhost',protocol:'ssh'},
          fontFamilyId:'jetbrains-mono',resolvedFontFamily:'monospace',fontSize:14,
          terminalTheme:{colors:{background:'#111111',foreground:'#eeeeee',cursor:'#ffffff',selection:'#444444'}},
          terminalSettingsRef:ref({...DEFAULT_TERMINAL_SETTINGS,cursorBlink:false}),
          terminalBackend:{write:()=>{},resize:()=>{},openExternalAvailable:false},
          sessionRef:ref('test-'+index),hotkeySchemeRef:ref('disabled'),disableTerminalFontZoomRef:ref(false),
          keyBindingsRef:ref([]),onHotkeyActionRef:ref(undefined),isBroadcastEnabledRef:ref(false),
          onBroadcastInputRef:ref(undefined),sessionId:'test-'+index,statusRef:ref('connected'),
          commandBufferRef:ref(''),requestSearchFocus:()=>{},
        });
        r.fitAddon.fit();r.term.onRender(()=>pane.frames++);
        pane.r=r;panes.push(pane);
        await new Promise(resolve=>r.term.write('ready\\r\\n',resolve));
      }
      assert.ok(root.querySelector('canvas'),'exercise WebGL, not only a fake renderer');
      const write=(pane,data)=>new Promise(resolve=>pane.r.term.write(data,resolve));
      const size=pane=>[pane.r.term.cols,pane.r.term.rows];
      const beforeSizes=panes.map(size);
      for(let i=1;i<5;i++)apply(panes[i],false);
      await wait(200);
      const before=panes.map(p=>p.frames);
      for(let tick=0;tick<12;tick++) {
        await Promise.all(panes.map(p=>write(p,'background-'+tick+'\\r\\n')));
        await wait(30);
      }
      const hiddenFrames=panes.map((p,i)=>p.frames-before[i]);
      assert.ok(hiddenFrames[0]>0,'visible terminal still paints');
      assert.deepEqual(hiddenFrames.slice(1),[0,0,0,0],'background terminals must not paint');
      assert.deepEqual(panes.map(size),beforeSizes,'hiding preserves terminal dimensions');
      for(const pane of panes) {
        const b=pane.r.term.buffer.active;
        assert.equal(b.getLine(b.baseY+b.cursorY-1).translateToString(true),'background-11','hidden output is already parsed');
      }
      // Cached right-hand split offsets can exceed a restored window's width.
      apply(panes[4],false,{...visibleStyle,left:'1600px'});
      await wait(150);
      const offsetFrames=panes[4].frames;
      await write(panes[4],'cached-offset\\r\\n');await wait(100);
      assert.equal(panes[4].frames,offsetFrames,'cached split offsets must not leave hidden panes painting');
      assert.ok(panes[4].el.getBoundingClientRect().right<=0,'park the entire cached split pane');
      assert.deepEqual(size(panes[4]),beforeSizes[4]);
      // No zero-width fitting during a window resize while tabs are parked.
      root.style.width='850px';
      assert.equal(panes[1].el.clientWidth,1050);
      for(let tick=0;tick<12;tick++) {
        const pane=panes[1+tick%4];
        await write(pane,'switch-'+tick+'\\r\\n');
        const start=pane.frames;apply(pane,true);await wait(100);
        assert.ok(pane.frames>start,'reveal must repaint');
        assert.deepEqual(size(pane),beforeSizes[1]);apply(pane,false);await wait(30);
      }
      // A full-screen program must keep interpreting cursor operations while hidden.
      const tui=panes[2];
      await write(tui,'\\x1b[?1049h\\x1b[2J\\x1b[HOLD');
      await wait(100);const tuiBefore=tui.frames;
      await write(tui,'\\x1b[HNEW\\x1b[2;1Hsecond row');await wait(100);
      assert.equal(tui.frames,tuiBefore);
      assert.equal(tui.r.term.buffer.active.getLine(0).translateToString(true),'NEW');
      apply(tui,true,{...visibleStyle,width:'850px'});tui.r.fitAddon.fit();await wait(100);
      assert.ok(tui.frames>tuiBefore);
      assert.equal(tui.r.term.buffer.active.getLine(0).translateToString(true),'NEW');
      await write(tui,'\\x1b[?1049l');
      // Two visible split panes paint; parked panes continue parsing without painting.
      for(const pane of panes)apply(pane,false);
      apply(panes[0],true,{left:'0px',top:'0px',width:'425px',height:'660px'});
      apply(panes[1],true,{left:'425px',top:'0px',width:'425px',height:'660px'});
      panes[0].r.fitAddon.fit();panes[1].r.fitAddon.fit();await wait(150);
      const splitBefore=panes.map(p=>p.frames);
      await Promise.all(panes.map(p=>write(p,'split-final\\r\\n')));await wait(100);
      assert.ok(panes[0].frames>splitBefore[0] && panes[1].frames>splitBefore[1]);
      assert.deepEqual(panes.slice(2).map((p,i)=>p.frames-splitBefore[i+2]),[0,0,0]);
      const summary={hiddenFrames,rapidSwitches:12,alternateScreen:true,split:true,sizes:beforeSizes};
      panes.forEach(p=>p.r.dispose());root.replaceChildren();
      assert.equal(document.querySelectorAll('.xterm').length,0);
      return summary;
    })()`);
    console.log("TERMINAL_BACKGROUND_RENDERING_OK", JSON.stringify(result));
    cleanup(0);
  }).catch(error=>{console.error(error);cleanup(1);});
}
