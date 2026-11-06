import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import React, { useEffect } from "react";
import { act, create } from "react-test-renderer";
import ts from "typescript";
import type { Host } from "../../../domain/models";
import { resolveTerminalPopupHost } from "../../TerminalPopupPage";
import { useTerminalEffects } from "../useTerminalEffects";
import { isTerminalAlternateScreenActive, readTerminalHibernateContext, resolveTerminalSnapshotCapture } from "../terminalHibernateRuntime";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const terminalSource = readFileSync(path.join(root, "components/Terminal.tsx"), "utf8");
const homeStart = terminalSource.indexOf("  useEffect(() => {", terminalSource.indexOf("// Home renderer for AI observe popups"));
const homeEnd = terminalSource.indexOf("  const cleanupSession =", homeStart);
const homeEffect = ts.transpileModule(terminalSource.slice(homeStart, homeEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const cleanupEnd = terminalSource.indexOf("  const cleanupSessionRef =", homeEnd);
const popupCleanup = ts.transpileModule(`${terminalSource.slice(homeEnd, cleanupEnd)}
globalThis.cleanup = cleanupSession;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const noop = () => {};
const ref = <T,>(current: T) => ({ current });

// Actual popup host resolution, home snapshot callbacks, attach boot effect,
// and real xterm writes. Unrelated visual effects are omitted by the hook seam.
test("attached popups retain the active mode across snapshots and return, including hibernated homes", async (t) => {
  const bundle = buildSync({
    stdin: { contents: 'export * from "./components/terminal/runtime/createXTermRuntime"; export {DEFAULT_TERMINAL_SETTINGS} from "./domain/models/terminal";', loader: "ts", resolveDir: root },
    bundle: true, format: "iife", globalName: "runtimeTest", platform: "browser", write: false,
    alias: {
      "node:diagnostics_channel": path.join(root, "infrastructure/shims/nodeDiagnosticsChannel.ts"),
      "diagnostics_channel": path.join(root, "infrastructure/shims/nodeDiagnosticsChannel.ts"),
    },
    define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta": "{}" },
  }).outputFiles[0].text;
  const dom = new JSDOM("<body/>", { url: "http://localhost", runScripts: "outside-only", pretendToBeVisual: true });
  const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.assign(dom.window, { structuredClone });
  dom.window.eval(`
    window.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
    window.ResizeObserver=window.IntersectionObserver=class {observe(){} unobserve(){} disconnect(){}};
    HTMLCanvasElement.prototype.getContext=function(type){
      if(type!=='2d')return null;
      return new Proxy({canvas:this,measureText:()=>({width:8,fontBoundingBoxAscent:12,fontBoundingBoxDescent:3}),
        getImageData:()=>({data:new Uint8ClampedArray(4)}),createLinearGradient:()=>({addColorStop(){}})},
        {get:(target,key)=>key in target?target[key]:()=>{}});
    };
  `);
  dom.window.eval(bundle);
  const runtimeModule = dom.window.eval("runtimeTest");
  try {
    for (const mode of [false, true]) for (const hibernated of [false, true]) {
      await t.test(`connected=${mode}, saved=${!mode}, home hibernated=${hibernated}`, async () => {
        const sessionId = `popup-${mode}-${hibernated}`;
        const connectedHost: Host = { id: "host", label: "Host", hostname: "127.0.0.1", port: 22379, username: "agent", protocol: "ssh" as const, tags: [], os: "linux" as const, sshInputCompatibility: mode };
        const savedHost = { ...connectedHost, sshInputCompatibility: !mode };
        const session = { id: sessionId, hostId: "host", hostLabel: "Host", hostname: "127.0.0.1", username: "agent", protocol: "ssh" as const, status: "connected" as const, createdAt: 1 };
        const popupHost = resolveTerminalPopupHost({ title: "Host", startupCommand: "", parentSessionId: sessionId, sourceSession: session, attachSessionId: sessionId }, [savedHost]);
        assert.equal(popupHost.sshInputCompatibility, !mode, "the popup sees the latest vault preference");
        const settings = { ...runtimeModule.DEFAULT_TERMINAL_SETTINGS, rendererType: "dom", fontLigatures: false, cursorBlink: false };
        const homeSettings = ref(settings);
        const writes: string[] = [];
        const makeContext = (host: Host, settingsRef = ref(settings)) => ({
          container: document.body.appendChild(document.createElement("div")), host,
          fontFamilyId: "jetbrains-mono", resolvedFontFamily: "monospace", fontSize: 14,
          terminalTheme: { colors: { background: "#111111", foreground: "#eeeeee", cursor: "#ffffff", selection: "#444444" } },
          terminalSettingsRef: settingsRef,
          terminalBackend: { writeToSession: (_id: string, data: string) => writes.push(data), resizeSession: noop, openExternalAvailable: false },
          sessionRef: ref<string | null>(sessionId), sessionId, statusRef: ref("connected"),
          hotkeySchemeRef: ref("disabled"), disableTerminalFontZoomRef: ref(false), keyBindingsRef: ref([]),
          onHotkeyActionRef: ref(undefined), isBroadcastEnabledRef: ref(false), onBroadcastInputRef: ref(undefined),
          commandBufferRef: ref(""), requestSearchFocus: noop, kittyKeyboardProtocolEnabled: false,
        });
        const homeContext = makeContext(connectedHost, homeSettings);
        const homeRuntime = runtimeModule.createXTermRuntime(homeContext);
        const homeRuntimeRef = ref(hibernated ? null : homeRuntime);
        const homeTermRef = ref(hibernated ? null : homeRuntime.term);
        if (hibernated) homeRuntime.dispose();
        let snapshotRequest: (payload: object) => Promise<void>;
        let applySnapshot: (payload: object) => Promise<boolean>;
        let snapshot: Record<string, unknown> = {};
        const bridge = {
          onTerminalSessionSnapshotRequest(callback: typeof snapshotRequest) { snapshotRequest = callback; return noop; },
          onTerminalSessionApplySnapshot(callback: typeof applySnapshot) { applySnapshot = callback; return noop; },
          respondTerminalSessionSnapshot(_request: string, text: string, keyboard: unknown, enabled: boolean, sensitive: boolean, cwd: string, title: string, perCharacterInput: boolean) {
            snapshot = { success: true, snapshot: text, kittyKeyboardModeState: keyboard, kittyKeyboardProtocolEnabled: enabled, passwordPromptActive: sensitive, cwd, title, perCharacterInput };
          },
        };
        const homeEnv = {
          useEffect: (effect: () => void) => effect(), netcattyBridge: { get: () => bridge },
          attachExistingSession: false, sessionId, terminalSettingsRef: homeSettings,
          xtermRuntimeRef: homeRuntimeRef, termRef: homeTermRef,
          serializeAddonRef: ref(hibernated ? null : homeRuntime.serializeAddon),
          hibernatedRef: ref(hibernated), softHiddenRef: ref(false),
          hibernateSnapshotRef: ref(""), hibernatePendingBufferRef: ref(""), hibernateViewportSnapshotRef: ref(""), hibernateScrollbackSnapshotRef: ref(""),
          hibernateContextSnapshotRef: ref(""), hibernateContextViewportSnapshotRef: ref(""), hibernateContextScrollbackSnapshotRef: ref(""), hibernateAlternateScreenRef: ref(false),
          kittyKeyboardProtocolEnabledForSession: false, passwordPromptActiveRef: ref(false), knownCwdRef: ref(null), terminalTitleRef: ref(null), pluginTerminalLifecycleRef: ref(null),
          promptSecurityScreenRef: ref({ active: null, incomplete: null }),
          onTerminalCwdChange: undefined, onTerminalTitleChange: undefined, terminalCwdTracker: { setRendererCwd: noop },
          flushPendingTerminalWritesBeforeHibernate: async () => true, resetTerminalLineTimestamps: noop,
          applyAuthoritativeHibernateSnapshot: noop, logger: { warn: noop },
          getTerminalPerCharacterInput: runtimeModule.getTerminalPerCharacterInput,
          restoreTerminalPerCharacterInput: runtimeModule.restoreTerminalPerCharacterInput,
        };
        vm.runInNewContext(homeEffect, homeEnv);
        const popupContext = makeContext(popupHost);
        popupContext.sessionRef.current = null;
        popupContext.statusRef.current = "connecting";
        const values = {
          ...popupContext, host: popupHost, terminalSettings: settings,
          containerRef: ref(popupContext.container), xtermRuntimeRef: ref(null), termRef: ref(null), fitAddonRef: ref(null), serializeAddonRef: ref(null), searchAddonRef: ref(null), hasRuntimeRef: ref(false),
          attachExistingSession: true, attachAuthorization: "owned-popup", vaultInitialized: true,
          CONNECTION_TIMEOUT: 30000, Error, XTERM_PERFORMANCE_CONFIG: {}, effectiveTheme: popupContext.terminalTheme,
          effectiveFontSize: 14, effectiveFontWeight: 400, fontWeightFixupDoneRef: ref(false),
          isVisible: true, isVisibleRef: ref(true), isFocused: true, inWorkspace: true, isLocalConnection: false, isNetworkDevice: false, isSerialConnection: false,
          pluginDecorationRules: [], pluginTerminalLifecycle: new Proxy({}, { get: () => noop }),
          onTerminalCwdChange: undefined, onTerminalTitleChange: undefined, keys: [], identities: [], serialConfig: {}, zmodem: {},
          connectionLogBufferRef: ref({ reset: noop }), terminalOutputHistory: { clear: noop }, terminalDataCapturedRef: ref(false), hasConnectedRef: ref(false), pendingOutputScrollRef: ref(false), promptLineBreakStateRef: ref(null), terminalLogSanitizerRef: ref(null),
          kittyKeyboardProtocolEnabledForSession: false, terminalCwdTracker: { getRendererCwd: () => null, setRendererCwd: noop }, passwordPromptActiveRef: ref(false),
          createPromptLineBreakState: () => ({}), createReplaySafeTerminalLogSanitizer: () => ({}),
          prepareInitialCwdIntent: noop, prepareRestoredReconnect: noop,
          applyUserCursorPreference: noop, applyUserCursorWidthPreference: noop, shouldApplyUserCursorPreference: () => false,
          terminalAltKeyOptions: () => ({}), shouldStartTerminalBackend: () => true,
          createXTermRuntime: runtimeModule.createXTermRuntime,
          terminalBackend: {
            ...popupContext.terminalBackend,
            acquireSessionFlowPauseLease: async () => ({ waitForPause: async () => ({ success: true }), release: noop }),
            requestSessionSnapshot: async () => { await snapshotRequest!({ sessionId, requestId: "request" }); return snapshot; },
            rebindSessionOutput: async () => ({ success: true, previousWebContentsId: 10 }),
            restoreSessionOutput: async () => ({ success: true }),
          },
          sessionStarters: { reattachSession: (term: { paste: (data: string) => void }) => { term.paste("中文"); return true; } },
          setStatus: noop, setProgressLogs: noop, setShowLogs: noop, setIsCancelling: noop, setIsDisconnectedDialogDismissed: noop,
          setError: (error: unknown) => { if (error) errors.push(error); },
          updateStatus: (status: string) => { popupContext.statusRef.current = status; },
          safeFit: noop, logger: { warn: noop, error: (...args: unknown[]) => errors.push(args) },
          onPluginRuntimeCwdChange: noop, onOpenExternalError: noop, requestSearchFocus: noop,
          requestPluginTerminalProviders: undefined, isPluginTerminalProviderAvailable: () => false,
          isPromptSecurityAlternateScreenActive: undefined,
          useEffect: (effect: React.EffectCallback, dependencies: React.DependencyList) => {
            useEffect(() => {
              if (effect.toString().includes("bootAbort")) return effect();
              // The injected hook owns this dependency list; unrelated effects stay inert.
              // eslint-disable-next-line react-hooks/exhaustive-deps
            }, dependencies);
          },
          useLayoutEffect: noop,
        };
        const errors: unknown[] = [];
        const defaultRefs = new Map<PropertyKey, ReturnType<typeof ref>>();
        const context = new Proxy(values, { get: (target, key) => {
          if (key in target) return target[key as keyof typeof target];
          if (!defaultRefs.has(key)) defaultRefs.set(key, ref(null));
          return defaultRefs.get(key);
        } });
        const Harness = () => { useTerminalEffects(context); return null; };
        let renderer: ReturnType<typeof create>;
        await act(async () => { renderer = create(React.createElement(Harness)); });
        for (let attempt = 0; popupContext.statusRef.current !== "connected" && attempt < 30 && !errors.length; attempt++) {
          await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
        }
        try {
          assert.deepEqual(errors, [], "actual attach boot succeeded");
          assert.equal(popupContext.sessionRef.current, sessionId, "attach retains the original SSH backend");
          assert.deepEqual(writes.splice(0), mode ? ["中", "文"] : ["中文"], "first attached input must retain the connection mode");
          assert.equal(snapshot.perCharacterInput, mode, "home snapshot exports captured mode, including false and no live xterm");
          const popupRuntime = values.xtermRuntimeRef.current as typeof homeRuntime;
          assert.equal(popupRuntime.getPerCharacterInput(), mode);
          const cleanupEnv = {
            ...homeEnv, attachExistingSession: true, attachAuthorization: "owned-popup",
            sessionRef: popupContext.sessionRef, xtermRuntimeRef: values.xtermRuntimeRef,
            terminalSettingsRef: popupContext.terminalSettingsRef, termRef: values.termRef,
            serializeAddonRef: values.serializeAddonRef, attachHomeWebContentsIdRef: ref(10),
            disposeDataRef: ref(null), disposeExitRef: ref(null), disposeTelnetEchoModeRef: ref(null),
            telnetLocalEchoRef: ref(false), sessionCleanupPromiseRef: ref(null),
            isTerminalAlternateScreenActive, readTerminalHibernateContext, resolveTerminalSnapshotCapture,
            releaseTerminalFlowBeforeHibernate: noop,
            terminalBackend: {
              ...values.terminalBackend,
              applySessionSnapshot: async (_id: string, text: string, context: { perCharacterInput?: boolean }) => {
                assert.equal(context.perCharacterInput, mode, "actual close exports the popup's active choice");
                return { success: await applySnapshot!({ sessionId, snapshot: text, ...context }) };
              },
            },
          };
          vm.runInNewContext(popupCleanup, cleanupEnv);
          await (cleanupEnv as typeof cleanupEnv & { cleanup: () => Promise<void> }).cleanup();
          assert.equal(runtimeModule.getTerminalPerCharacterInput(homeSettings), mode, "actual popup close retains the home captured state");
          const restoredHome = hibernated ? runtimeModule.createXTermRuntime({ ...homeContext, host: savedHost }) : homeRuntime;
          restoredHome.term.paste("中文");
          assert.deepEqual(writes.splice(0), mode ? ["中", "文"] : ["中文"], "home input after return and wake retains the active choice");
          if (hibernated) restoredHome.dispose();
        } finally {
          values.hasConnectedRef.current = false;
          await act(async () => { renderer!.unmount(); });
          homeRuntime.dispose();
        }
      });
    }
  } finally {
    dom.window.close();
    for (const key of keys) { const descriptor = previous.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
