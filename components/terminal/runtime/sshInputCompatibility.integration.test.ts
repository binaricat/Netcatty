import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";

// Real xterm + runtime input callbacks; canvas measurement is stubbed because
// these assertions concern writes, not rendering or a native OS input method.
test("SSH host mode gates every interactive text entry and stays fixed until reconnect", async () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const bundle = buildSync({
    stdin: {
      contents: 'export {createXTermRuntime} from "./components/terminal/runtime/createXTermRuntime"; export {DEFAULT_TERMINAL_SETTINGS} from "./domain/models/terminal"; export {dispatchTerminalLinePaste} from "./components/terminal/runtime/terminalUserPaste"; export {wakeTerminalFromHibernate} from "./components/terminal/terminalRuntimeMount";',
      loader: "ts", resolveDir: root,
    },
    bundle: true, format: "iife", globalName: "runtimeTest", platform: "browser", write: false,
    alias: {
      "node:diagnostics_channel": path.join(root, "infrastructure/shims/nodeDiagnosticsChannel.ts"),
      "diagnostics_channel": path.join(root, "infrastructure/shims/nodeDiagnosticsChannel.ts"),
    },
    define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta": "{}" },
  }).outputFiles[0].text;
  const dom = new JSDOM("<body/>", { url: "http://localhost", runScripts: "outside-only", pretendToBeVisual: true });
  Object.assign(dom.window, { structuredClone });
  try {
    dom.window.eval(`
      window.matchMedia = () => ({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
      window.ResizeObserver = window.IntersectionObserver = class {observe(){} unobserve(){} disconnect(){}};
      HTMLCanvasElement.prototype.getContext = function(type) {
        if (type !== '2d') return null;
        return new Proxy({canvas:this,measureText:()=>({width:8,fontBoundingBoxAscent:12,fontBoundingBoxDescent:3}),
          getImageData:()=>({data:new Uint8ClampedArray(4)}),createLinearGradient:()=>({addColorStop(){}})},
          {get:(target,key)=>key in target ? target[key] : ()=>{}});
      };
    `);
    dom.window.eval(bundle);
    const result = await dom.window.eval(`(async () => {
      const {createXTermRuntime, DEFAULT_TERMINAL_SETTINGS, dispatchTerminalLinePaste, wakeTerminalFromHibernate} = runtimeTest;
      const ref = current => ({current});
      const panes = [];
      const make = host => {
        const el = document.createElement('div'); document.body.appendChild(el);
        const writes = [], logical = [], broadcasts = [];
        const context = {
          container:el, host, getHost:()=>host,
          fontFamilyId:'jetbrains-mono', resolvedFontFamily:'monospace', fontSize:14,
          terminalTheme:{colors:{background:'#111111',foreground:'#eeeeee',cursor:'#ffffff',selection:'#444444'}},
          terminalSettingsRef:ref({...DEFAULT_TERMINAL_SETTINGS,rendererType:'dom',fontLigatures:false,cursorBlink:false}),
          terminalBackend:{writeToSession:(_,data)=>writes.push(data),resizeSession(){},openExternalAvailable:false},
          sessionRef:ref(host.id),hotkeySchemeRef:ref('disabled'),disableTerminalFontZoomRef:ref(false),
          keyBindingsRef:ref([]),onHotkeyActionRef:ref(undefined),isBroadcastEnabledRef:ref(true),
          onBroadcastInputRef:ref(data=>{broadcasts.push(data);return [];}),
          onOutputTriggerUserInputRef:ref(data=>logical.push(data)),
          sessionId:host.id,statusRef:ref('connected'),commandBufferRef:ref(''),requestSearchFocus(){},
          kittyKeyboardProtocolEnabled:true,
        };
        const runtime = createXTermRuntime(context);
        const pane={...runtime,writes,logical,broadcasts,context,el}; panes.push(pane); return pane;
      };
      const equal = (actual, expected, label) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(label+': '+JSON.stringify({actual,expected}));
      };
      const wait = () => new Promise(resolve=>setTimeout(resolve,20));
      const check = (pane, text, split, label) => {
        equal(pane.writes.splice(0),split ? Array.from(text) : [text],label);
        equal(pane.logical.splice(0),[text],label+' logical payload once');
        pane.broadcasts.length=0;
      };
      const hosts=[false,true].map((mode,index)=>({id:'mode-'+index,label:'Mode',hostname:'localhost',protocol:'ssh',sshInputCompatibility:mode}));
      const metrics=[];
      for (const host of hosts) {
        const pane=make(host), term=pane.term, ta=term.textarea, mode=host.sshInputCompatibility;
        for (const text of ['中文','👩🏽‍💻é','x'.repeat(32),'x'.repeat(33)]) {
          term.paste(text); check(pane,text,mode && Array.from(text).length<=32,'raw paste '+mode);
        }
        ta.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'中国'}));
        check(pane,'中国',mode,'insertText');
        const longIme='中'.repeat(40);
        ta.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:longIme}));
        check(pane,longIme,mode,'IME keeps its uncapped scope');
        ta.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,keyCode:229,key:'Process'}));
        ta.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'中文'}));
        check(pane,'中文',mode,'IME 229 insertText');
        ta.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
        ta.value='中文';
        ta.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'中文'}));
        ta.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));
        await wait(); check(pane,'中文',mode,'compositionend');
        // xterm's composition fallback reaches onData independently of insertText.
        ta.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
        term.input('中国',true); check(pane,'中国',mode,'composition onData fallback');
        ta.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''})); await wait();
        pane.writes.length=0; pane.logical.length=0;
        for (const data of ['\\x1b[A','\\x03','\\x03\\x04','\\x1b[0;;200u']) {
          term.input(data,true); check(pane,data,false,'terminal control');
        }
        await new Promise(resolve=>term.write('\\x1b[?2004h',resolve));
        term.paste('中文'); check(pane,'\\x1b[200~中文\\x1b[201~',false,'bracketed paste');
        await new Promise(resolve=>term.write('\\x1b[?2004l',resolve));
        dispatchTerminalLinePaste(term,'中文\\r',{lineDelayMs:1,sensitive:false});
        equal(pane.writes.splice(0),['中文\\r'],'existing line-paste path stays intact');
        pane.logical.length=0;
        await new Promise(resolve=>term.write('\\x1b[>25u',resolve));
        ta.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'中文'}));
        const kittyWrites=pane.writes.splice(0);
        equal(kittyWrites,['\\x1b[0;;20013:25991u'],'Kitty associated text stays in one transport write');
        pane.logical.length=0;
        await new Promise(resolve=>term.write('\\x1b[<u',resolve));
        host.sshInputCompatibility=!mode;
        term.paste('中文'); check(pane,'中文',mode,'save does not change active runtime');
        // The app reconnects with the existing runtime, so exercise that reset too.
        pane.resetConnectionInputState(host);
        term.paste('中文'); check(pane,'中文',!mode,'existing runtime reconnect');
        pane.dispose();
        const reconnected=make(host);
        reconnected.term.paste('中文'); check(reconnected,'中文',!mode,'reconnect reads saved mode');
        metrics.push({mode,entryPoints:5,reconnectedMode:!mode});
      }
      // Exercise the actual wake entry that recreates xterm but only reattaches
      // the existing backend. Its context contains the newly saved host record.
      for (const mode of [false,true]) {
        const connectedHost={id:'hibernate-'+mode,label:'Hibernate',hostname:'127.0.0.1',protocol:'ssh',sshInputCompatibility:mode};
        const savedHost={...connectedHost,sshInputCompatibility:!mode};
        let pane=make(connectedHost), reattached=0;
        const wake = async old => {
          old.dispose();
          const refs={xtermRuntimeRef:ref(null),termRef:ref(null),fitAddonRef:ref(null),
            serializeAddonRef:ref(null),searchAddonRef:ref(null),hasRuntimeRef:ref(false)};
          const context={...old.context,host:savedHost};
          const success=await wakeTerminalFromHibernate({
            refs,runtimeContext:context,container:old.el,
            getPayload:()=>({snapshot:'',alternateScreen:false,pendingBuffer:''}),
            prepareWakeFlow:async()=>true,takePendingBuffer:()=>'',
            stopHibernateDataListener(){},stopHibernateListeners(){},
            reattachSession(){reattached++;},safeFit(){},resizeSession(){},forceSyncRenderAfterResize(){},
            lastFittedSizeRef:ref(null),isBootActiveRef:ref(false),sessionId:connectedHost.id,updateStatus(){},
          });
          equal(success,true,'hibernate wake succeeds');
          equal(context.sessionRef.current,connectedHost.id,'hibernate retains backend session');
          const next={...refs.xtermRuntimeRef.current,context,el:old.el,
            writes:old.writes,logical:old.logical,broadcasts:old.broadcasts};
          panes.push(next); next.writes.length=0; next.logical.length=0; return next;
        };
        pane=await wake(pane);
        pane.term.paste('中文');check(pane,'中文',mode,'wake retains connection-time mode');
        pane.resetConnectionInputState(savedHost);
        pane.term.paste('中文');check(pane,'中文',!mode,'real reconnect refreshes mode after wake');
        pane=await wake(pane);
        pane.term.paste('中文');check(pane,'中文',!mode,'next wake retains refreshed connection mode');
        equal(reattached,2,'both wakes reattach the existing backend');
      }
      // The SSH-only field cannot change other transports' existing policy.
      for (const protocol of ['local','telnet','serial','mosh','et','ssh-mosh','ssh-et']) {
        const pane=make({id:'other-'+protocol,label:protocol,hostname:'127.0.0.1',
          protocol:protocol.startsWith('ssh-')?'ssh':protocol,
          moshEnabled:protocol==='ssh-mosh',etEnabled:protocol==='ssh-et',sshInputCompatibility:false});
        pane.term.paste('中文'); check(pane,'中文',true,protocol+' retains legacy short paste');
        pane.term.input('a\\rb',true); check(pane,'a\\rb',true,protocol+' retains legacy control-containing text');
      }
      for (const pane of panes) { try {pane.dispose();} catch {} }
      return JSON.stringify(metrics);
    })()`);
    assert.deepEqual(JSON.parse(result), [
      { mode: false, entryPoints: 5, reconnectedMode: true },
      { mode: true, entryPoints: 5, reconnectedMode: false },
    ]);
  } finally {
    dom.window.close();
  }
});
