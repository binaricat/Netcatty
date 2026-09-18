"use strict";
/* global process, __dirname, console */
if (!process.versions.electron || process.platform !== "darwin") {
  require("node:test")("macOS Command-period interrupts without losing held keys", {
    skip: "run with Electron on macOS for real xterm keyboard coverage",
  }, () => {});
} else {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const fs = require("node:fs");
  const path = require("node:path");
  const temp = require("../electron/bridges/tempDirBridge.cjs");
  const userData = fs.mkdtempSync(`${temp.getTempFilePath("command-period-test")}-`);
  app.setPath("userData", userData);
  app.on("window-all-closed", () => {});
  let win;
  const finish = code => {
    win?.destroy();
    fs.rmSync(userData, { recursive: true, force: true });
    app.exit(code);
  };
  const bundle = require("esbuild").buildSync({
    stdin: {
      contents: 'export {createXTermRuntime} from "./components/terminal/runtime/createXTermRuntime"; export {DEFAULT_TERMINAL_SETTINGS} from "./domain/models/terminal"; export {dispatchKittyKeyboardBroadcastInput} from "./components/terminal/runtime/kittyKeyboardBroadcast";',
      loader: "ts", resolveDir: path.resolve(__dirname, ".."),
    },
    bundle: true, format: "cjs", platform: "browser", write: false,
    define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta": "{}" },
  }).outputFiles[0].text;
  void app.whenReady().then(async () => {
    win = new BrowserWindow({
      show: true, width: 1000, height: 600,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
    });
    await win.loadURL("data:text/html,<body style='background:%23111'></body>");
    await win.webContents.insertCSS(fs.readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8"));
    ipcMain.once("command-period-ready", () => {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: ".", modifiers: ["meta"] });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: ".", modifiers: ["meta"] });
    });
    const result = await win.webContents.executeJavaScript(`(async () => {
      const assert = require('node:assert/strict');
      const loaded = {exports:{}};
      ((module,exports)=>{${bundle}})(loaded,loaded.exports);
      const {createXTermRuntime,DEFAULT_TERMINAL_SETTINGS,dispatchKittyKeyboardBroadcastInput} = loaded.exports;
      // Force a non-QWERTY layout: physical KeyC maps to j.
      Object.defineProperty(navigator,'keyboard',{configurable:true,value:{
        getLayoutMap:async()=>new Map([['KeyC','j'],['Period','.']]),
      }});
      const ref = current => ({current});
      const panes = [];
      const make = (id, broadcast) => {
        const el=document.createElement('div');
        el.style.cssText='width:450px;height:240px;display:inline-block';document.body.appendChild(el);
        const writes=[];let sink=()=>{};
        const send=data=>{writes.push(data);sink(data);};
        const r=createXTermRuntime({
          container:el,host:{id,label:id,hostname:'localhost',protocol:'local'},
          fontFamilyId:'jetbrains-mono',resolvedFontFamily:'monospace',fontSize:14,
          terminalTheme:{colors:{background:'#111111',foreground:'#eeeeee',cursor:'#ffffff',selection:'#444444'}},
          terminalSettingsRef:ref({...DEFAULT_TERMINAL_SETTINGS,cursorBlink:false}),
          terminalBackend:{writeToSession:(_,data)=>send(data),interruptSession:()=>send('\\x03'),resize:()=>{},openExternalAvailable:false},
          sessionRef:ref(id),hotkeySchemeRef:ref('disabled'),disableTerminalFontZoomRef:ref(false),
          keyBindingsRef:ref([]),onHotkeyActionRef:ref(undefined),isBroadcastEnabledRef:ref(Boolean(broadcast)),
          onBroadcastInputRef:ref(broadcast),sessionId:id,statusRef:ref('connected'),
          commandBufferRef:ref(''),requestSearchFocus:()=>{},kittyKeyboardProtocolEnabled:true,
        });
        r.fitAddon.fit(); const pane={r,el,writes,setSink:next=>{sink=next;}};panes.push(pane);return pane;
      };
      const write=(p,data)=>new Promise(resolve=>p.r.term.write(data,resolve));
      const key=(p,type,key,code,mods={})=>p.r.term.textarea.dispatchEvent(new KeyboardEvent(type,{
        bubbles:true,cancelable:true,key,code,keyCode:code==='Period'?190:67,...mods,
      }));
      const peer=make('peer');
      const source=make('source',(_,__,options)=>{
        dispatchKittyKeyboardBroadcastInput('peer',options.kittyKeyboardInput);return ['peer'];
      });
      await write(peer,'\\x1b[>11u');
      source.r.term.options.vtExtensions={...source.r.term.options.vtExtensions,win32InputMode:true};
      const summary=[];
      for(const mode of ['kitty','win32','legacy']) {
        await write(source,'\\x1b[?9001l\\x1b[<u');
        if(mode==='kitty')await write(source,'\\x1b[>11u');
        if(mode==='win32')await write(source,'\\x1b[?9001h');
        assert.equal(source.r.term.modes.win32InputMode,mode==='win32');
        source.r.term.focus();source.writes.length=0;peer.writes.length=0;
        key(source,'keydown','.','Period',mode==='win32'?{ctrlKey:true}:{});
        if(mode!=='win32')source.r.term.textarea.dispatchEvent(new InputEvent('input',{
          bubbles:true,inputType:'insertText',data:'.',
        }));
        key(source,'keydown','.','Period',{metaKey:true,repeat:true});
        key(source,'keyup','.','Period',{metaKey:true});
        assert.ok(source.writes.includes('\\x03'),mode+' interrupts the source');
        assert.ok(peer.writes.some(s=>s.includes('[99;5:3u')),mode+' peer releases C on Dvorak');
        assert.ok(peer.writes.some(s=>/\\[46;\\d+:3u/.test(s)),mode+' peer releases held Period '+JSON.stringify({source:source.writes,peer:peer.writes}));
        if(mode==='kitty') {
          assert.ok(source.writes.some(s=>s.includes('[99;5:3u')),'source releases C on Dvorak');
          assert.ok(source.writes.some(s=>/\\[46;\\d+:3u/.test(s)),'source releases held Period');
        }
        if(mode==='win32') {
          assert.ok(source.writes.some(s=>/^\\x1b\\[190;\\d+;\\d+;0;/.test(s)),
            'native source releases physical Period: '+JSON.stringify(source.writes));
          assert.ok(!source.writes.some(s=>/^\\x1b\\[67;\\d+;\\d+;0;/.test(s)),
            'native source never releases an unpressed physical C');
        }
        summary.push({mode,source:[...source.writes],peer:[...peer.writes]});
        // The interrupt release must not consume a separately held C.
        source.writes.length=0;peer.writes.length=0;
        key(source,'keydown','c','KeyC');
        key(source,'keydown','.','Period',{metaKey:true});
        key(source,'keyup','.','Period',{metaKey:true});
        const before=peer.writes.length;
        key(source,'keyup','c','KeyC');
        assert.ok(peer.writes.slice(before).some(s=>/\\[106;\\d+:3u/.test(s)),
          mode+' physical C (layout j) remains paired independently');
      }
      // Native Electron input must interrupt an actual foreground command.
      const smoke=make('shell');smoke.r.term.focus();
      const pty=require(${JSON.stringify(require.resolve("node-pty"))});
      const shell=pty.spawn('/bin/sh',['-i'],{
        name:'xterm-256color',cols:80,rows:24,env:{...process.env,PS1:'PROMPT> '},
      });
      let output='';
      shell.onData(data=>{output+=data;smoke.r.term.write(data);});
      smoke.setSink(data=>shell.write(data));
      const waitFor=async predicate=>{
        const start=Date.now();
        while(!predicate()) {
          if(Date.now()-start>8000)throw new Error('shell smoke timeout: '+output);
          await new Promise(resolve=>setTimeout(resolve,30));
        }
      };
      try {
        await waitFor(()=>output.includes('PROMPT> '));
        output='';
        shell.write("echo __TAIL_''READY__; tail -f /dev/null\\r");
        await waitFor(()=>output.includes('__TAIL_READY__\\r\\n'));
        await new Promise(resolve=>setTimeout(resolve,150));
        output='';
        require('electron').ipcRenderer.send('command-period-ready');
        await waitFor(()=>output.includes('PROMPT> '));
        shell.write("echo __AFTER_''INTERRUPT__\\r");
        await waitFor(()=>output.includes('__AFTER_INTERRUPT__\\r\\n'));
        summary.push({nativeCommandPeriod:true,tailInterrupted:true,shellUsable:true});
      } finally {shell.kill();}
      panes.forEach(p=>p.r.dispose());return summary;

    })()`);
    console.log("COMMAND_PERIOD_OK", JSON.stringify(result));finish(0);
  }).catch(error=>{console.error(error);finish(1);});
}
