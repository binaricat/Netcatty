import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import ts from "typescript";

test("native Shift+Insert broadcasts clipboard bytes once without an Insert key", async () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const layer = readFileSync(new URL("../../TerminalLayer.tsx", import.meta.url), "utf8");
  const start = layer.indexOf("  const handleBroadcastInput = useCallback(");
  const end = layer.indexOf("  const handleCommandSubmitted =", start);
  assert.ok(start >= 0 && end > start);
  const dispatcher = ts.transpileModule(layer.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const bundle = buildSync({
    stdin: {
      contents: `
        export { createXTermRuntime } from "./components/terminal/runtime/createXTermRuntime";
        export { DEFAULT_TERMINAL_SETTINGS } from "./domain/models/terminal";
        export { resolveTerminalBroadcastTargetIds } from "./domain/terminalBroadcast";
        export { dispatchKittyKeyboardBroadcastInput } from "./components/terminal/runtime/kittyKeyboardBroadcast";
        export * from "./components/terminal/runtime/terminalPacedBroadcast";
      `,
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
      Object.defineProperty(navigator, 'platform', {value:'Win32'});
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
    const results = await dom.window.eval(`(async () => {
      const {createXTermRuntime, DEFAULT_TERMINAL_SETTINGS, resolveTerminalBroadcastTargetIds,
        dispatchKittyKeyboardBroadcastInput, markTerminalBroadcastUserInput,
        captureTerminalBroadcastInput, isTerminalBroadcastInputCurrent} = runtimeTest;
      const ref = current => ({current});
      const useCallback = fn => fn;
      const sessionsRef = ref([]), isGlobalBroadcastEnabled = false;
      const broadcastPasswordBypassRef = ref(false);
      const canUseDirectSessionWriteFallback = () => true;
      const isTerminalSensitiveInputActive = () => false;
      const wires = new Map();
      const terminalBackend = {
        writeToSession:(id,data)=>wires.get(id).push(data), resizeSession(){}, openExternalAvailable:false,
      };
      ${dispatcher}
      const make = (id, kittyKeyboardProtocolEnabled) => {
        const container = document.createElement('div'); document.body.appendChild(container);
        wires.set(id, []);
        const host = {id,label:id,hostname:'localhost',protocol:'ssh',sshInputCompatibility:false};
        return createXTermRuntime({
          container, host, getHost:()=>host, sessionId:id, sessionRef:ref(id), statusRef:ref('connected'),
          fontFamilyId:'jetbrains-mono',resolvedFontFamily:'monospace',fontSize:14,
          terminalTheme:{colors:{background:'#111111',foreground:'#eeeeee',cursor:'#ffffff',selection:'#444444'}},
          terminalSettingsRef:ref({...DEFAULT_TERMINAL_SETTINGS,rendererType:'dom',fontLigatures:false,cursorBlink:false}),
          terminalBackend,hotkeySchemeRef:ref('disabled'),keyBindingsRef:ref([]),onHotkeyActionRef:ref(undefined),
          isBroadcastEnabledRef:ref(true),onBroadcastInputRef:ref(handleBroadcastInput),
          commandBufferRef:ref(''),requestSearchFocus(){},kittyKeyboardProtocolEnabled,
        });
      };
      const results = [];
      for (const bracketed of [false,true]) {
        for (const delayed of [true,false]) {
          for (const peerKitty of [false,true]) {
            const source = make('source', false), peer = make('peer', peerKitty);
            try {
              sessionsRef.current = ['source','peer'].map(id=>({id,protocol:'ssh',workspaceId:'workspace'}));
              if (peerKitty) await new Promise(resolve=>peer.term.write('\\x1b[>8u',resolve));
              if (bracketed) await new Promise(resolve=>source.term.write('\\x1b[?2004h',resolve));
              const key = new KeyboardEvent('keydown', {
                bubbles:true,cancelable:true,key:'Insert',code:'Insert',keyCode:45,shiftKey:true,
              });
              source.term.textarea.dispatchEvent(key);
              const beforePaste = [...wires.get('peer')];
              if (delayed) await new Promise(resolve=>setTimeout(resolve,10));
              // Supply the native clipboard event which Chromium emits for this chord.
              const paste = new Event('paste', {bubbles:true,cancelable:true});
              Object.defineProperty(paste,'clipboardData',{value:{getData:()=> 'clipboard'}});
              source.term.textarea.dispatchEvent(paste);
              source.term.textarea.dispatchEvent(new KeyboardEvent('keyup', {
                bubbles:true,key:'Insert',code:'Insert',keyCode:45,shiftKey:true,
              }));
              results.push({bracketed,delayed,peerKitty,beforePaste,
                prevented:key.defaultPrevented,source:[...wires.get('source')],peer:[...wires.get('peer')]});
              // Ordinary Insert still uses the physical-key broadcast path.
              if (!peerKitty) {
                wires.get('source').length=0; wires.get('peer').length=0;
                source.term.textarea.dispatchEvent(new KeyboardEvent('keydown', {
                  bubbles:true,cancelable:true,key:'Insert',code:'Insert',keyCode:45,
                }));
                results.push({plainInsert:true,source:[...wires.get('source')],peer:[...wires.get('peer')]});
              }
            } finally { source.dispose(); peer.dispose(); }
          }
        }
      }
      return JSON.stringify(results);
    })()`);
    for (const result of JSON.parse(results)) {
      if (result.plainInsert) {
        assert.deepEqual(result.source, ["\x1b[2~"]);
        assert.deepEqual(result.peer, ["\x1b[2~"]);
        continue;
      }
      const label = JSON.stringify(result);
      assert.deepEqual(result.beforePaste, [], label);
      assert.equal(result.prevented, false, "native paste must remain enabled: " + label);
      const expected = result.bracketed ? "\x1b[200~clipboard\x1b[201~" : "clipboard";
      assert.deepEqual(result.source, [expected], label);
      assert.deepEqual(result.peer, [expected], label);
    }
  } finally {
    dom.window.close();
  }
});
