import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import { shouldKeepHistoryPreviewOnKey } from "./terminalHistoryScrollOverride";

test("Ctrl+Insert copies selection, preserves selection, and leaks no PTY bytes across legacy, Kitty, and Win32 modes (#4351)", async () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const bundle = buildSync({
    stdin: {
      contents: `
        export { createXTermRuntime } from "./components/terminal/runtime/createXTermRuntime";
        export { DEFAULT_TERMINAL_SETTINGS } from "./domain/models/terminal";
        export { DEFAULT_KEY_BINDINGS } from "./domain/models/keyBindings";
      `,
      loader: "ts",
      resolveDir: root,
    },
    bundle: true,
    format: "iife",
    globalName: "runtimeTest",
    platform: "browser",
    write: false,
    alias: {
      "node:diagnostics_channel": path.join(root, "infrastructure/shims/nodeDiagnosticsChannel.ts"),
      "diagnostics_channel": path.join(root, "infrastructure/shims/nodeDiagnosticsChannel.ts"),
    },
    define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta": "{}" },
  }).outputFiles[0].text;

  const dom = new JSDOM("<body/>", {
    url: "http://localhost",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  Object.assign(dom.window, { structuredClone });
  try {
    dom.window.eval(`
      Object.defineProperty(navigator, 'platform', { value: 'Win32' });
      window.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
      window.ResizeObserver = window.IntersectionObserver = class { observe(){} unobserve(){} disconnect(){} };
      HTMLCanvasElement.prototype.getContext = function(type) {
        if (type !== '2d') return null;
        return new Proxy(
          {
            canvas: this,
            measureText: () => ({ width: 8, fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 3 }),
            getImageData: () => ({ data: new Uint8ClampedArray(4) }),
            createLinearGradient: () => ({ addColorStop(){} }),
          },
          { get: (target, key) => (key in target ? target[key] : () => {}) },
        );
      };
    `);
    dom.window.eval(bundle);

    const results = await dom.window.eval(`(async () => {
      const { createXTermRuntime, DEFAULT_TERMINAL_SETTINGS, DEFAULT_KEY_BINDINGS } = runtimeTest;
      const ref = (current) => ({ current });
      const copiedTexts = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => { copiedTexts.push(text); },
        },
      });

      const make = (id, kittyKeyboardProtocolEnabled, options = {}) => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const writes = [];
        const host = { id, label: id, hostname: 'localhost', protocol: options.protocol ?? 'local', sshInputCompatibility: false };
        const runtime = createXTermRuntime({
          container,
          host,
          getHost: () => host,
          sessionId: id,
          sessionRef: ref(id),
          statusRef: ref('connected'),
          fontFamilyId: 'jetbrains-mono',
          resolvedFontFamily: 'monospace',
          fontSize: 14,
          terminalTheme: { colors: { background: '#111111', foreground: '#eeeeee', cursor: '#ffffff', selection: '#444444' } },
          terminalSettingsRef: ref({ ...DEFAULT_TERMINAL_SETTINGS, rendererType: 'dom', fontLigatures: false, cursorBlink: false }),
          terminalBackend: { writeToSession: (_id, data) => writes.push(data), resizeSession(){}, openExternalAvailable: false },
          hotkeySchemeRef: ref('pc'),
          keyBindingsRef: ref(options.bindings ?? DEFAULT_KEY_BINDINGS),
          onHotkeyActionRef: ref(undefined),
          terminalContextActionsRef: ref({}),
          snippetsRef: ref(options.snippets ?? []),
          onSnippetShortkeyRef: ref(options.onSnippet),
          isBroadcastEnabledRef: ref(false),
          onBroadcastInputRef: ref(undefined),
          commandBufferRef: ref(''),
          requestSearchFocus: options.onSearch ?? (() => {}),
          kittyKeyboardProtocolEnabled,
        });
        return { runtime, writes };
      };

      const modes = [
        { name: 'legacy', kitty: false, setup: '' },
        { name: 'native-kitty', kitty: false, setup: '\\x1b[>3u' },
        { name: 'netcatty-kitty', kitty: true, setup: '\\x1b[>3u' },
        { name: 'win32', kitty: false, setup: '\\x1b[?9001h' },
      ];

      const modeResults = [];
      for (const mode of modes) {
        const { runtime, writes } = make('sess-' + mode.name, mode.kitty);
        try {
          await new Promise((resolve) => runtime.term.write('hello world\\r\\n', resolve));
          if (mode.setup) {
            await new Promise((resolve) => runtime.term.write(mode.setup, resolve));
          }
          writes.length = 0;
          copiedTexts.length = 0;

          // Case 1: with active selection, Ctrl+Insert copies, preserves selection, emits zero bytes.
          runtime.term.select(0, 0, 5);
          const downWithSel = new KeyboardEvent('keydown', {
            bubbles: true, cancelable: true, key: 'Insert', code: 'Insert', keyCode: 45, ctrlKey: true,
          });
          runtime.term.textarea.dispatchEvent(downWithSel);
          runtime.term.textarea.dispatchEvent(new KeyboardEvent('keyup', {
            bubbles: true, cancelable: true, key: 'Insert', code: 'Insert', keyCode: 45, ctrlKey: true,
          }));
          const withSelection = {
            prevented: downWithSel.defaultPrevented,
            hasSelectionAfter: runtime.term.hasSelection(),
            selectionAfter: runtime.term.getSelection(),
            copied: [...copiedTexts],
            writes: [...writes],
          };

          // Case 2: without selection, Ctrl+Insert still emits zero bytes (never leaks ESC[2;5~ / 5~).
          runtime.term.clearSelection();
          writes.length = 0;
          copiedTexts.length = 0;
          const downNoSel = new KeyboardEvent('keydown', {
            bubbles: true, cancelable: true, key: 'Insert', code: 'Insert', keyCode: 45, ctrlKey: true,
          });
          runtime.term.textarea.dispatchEvent(downNoSel);
          runtime.term.textarea.dispatchEvent(new KeyboardEvent('keyup', {
            bubbles: true, cancelable: true, key: 'Insert', code: 'Insert', keyCode: 45, ctrlKey: true,
          }));
          const withoutSelection = {
            prevented: downNoSel.defaultPrevented,
            copied: [...copiedTexts],
            writes: [...writes],
          };

          modeResults.push({ mode: mode.name, win32InputMode: runtime.term.modes.win32InputMode, withSelection, withoutSelection });
        } finally {
          runtime.dispose();
        }
      }

      // User shortcut and snippet bindings for Ctrl+Insert retain precedence.
      const precedenceResults = [];
      for (const kind of ['binding', 'snippet']) {
        let searchCalls = 0;
        let snippetCalls = 0;
        copiedTexts.length = 0;
        const { runtime, writes } = make(
          'prec-' + kind,
          false,
          kind === 'binding'
            ? {
                onSearch: () => { searchCalls += 1; },
                bindings: DEFAULT_KEY_BINDINGS.map((b) =>
                  b.action === 'searchTerminal' ? { ...b, pc: 'Ctrl + Insert' } : b),
              }
            : {
                snippets: [{ id: 'snip-1', shortkey: 'Ctrl + Insert' }],
                onSnippet: () => { snippetCalls += 1; },
              },
        );
        try {
          await new Promise((resolve) => runtime.term.write('hello world\\r\\n\\x1b[?9001h', resolve));
          runtime.term.select(0, 0, 5);
          writes.length = 0;
          runtime.term.textarea.dispatchEvent(new KeyboardEvent('keydown', {
            bubbles: true, cancelable: true, key: 'Insert', code: 'Insert', keyCode: 45, ctrlKey: true,
          }));
          precedenceResults.push({ kind, searchCalls, snippetCalls, copied: [...copiedTexts], writes: [...writes] });
        } finally {
          runtime.dispose();
        }
      }

      return JSON.stringify({ modeResults, precedenceResults });
    })()`);
    const parsed = JSON.parse(results);

    for (const item of parsed.modeResults) {
      if (item.mode === "win32") {
        assert.equal(item.win32InputMode, true, "win32 mode must be enabled via DECSET 9001");
      }
      assert.equal(item.withSelection.prevented, true, `${item.mode}: keydown prevented`);
      assert.equal(item.withSelection.hasSelectionAfter, true, `${item.mode}: selection preserved`);
      assert.equal(item.withSelection.selectionAfter, "hello", `${item.mode}: selection text intact`);
      assert.deepEqual(item.withSelection.copied, ["hello"], `${item.mode}: copied selected text`);
      assert.deepEqual(item.withSelection.writes, [], `${item.mode}: zero PTY bytes with selection`);

      assert.equal(item.withoutSelection.prevented, true, `${item.mode}: no-selection keydown prevented`);
      assert.deepEqual(item.withoutSelection.copied, [], `${item.mode}: no clipboard overwrite without selection`);
      assert.deepEqual(item.withoutSelection.writes, [], `${item.mode}: zero PTY bytes without selection`);
    }

    const bindingResult = parsed.precedenceResults.find((r: { kind: string }) => r.kind === "binding");
    assert.deepEqual(bindingResult, { kind: "binding", searchCalls: 1, snippetCalls: 0, copied: [], writes: [] });
    const snippetResult = parsed.precedenceResults.find((r: { kind: string }) => r.kind === "snippet");
    assert.deepEqual(snippetResult, { kind: "snippet", searchCalls: 0, snippetCalls: 1, copied: [], writes: [] });
  } finally {
    dom.window.close();
  }
});

test("shouldKeepHistoryPreviewOnKey keeps preview open for Ctrl+Insert when preview selection exists", () => {
  const ctrlInsert = {
    type: "keydown",
    key: "Insert",
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  };
  assert.equal(shouldKeepHistoryPreviewOnKey(ctrlInsert, { hasPreviewSelection: true }), true);
  assert.equal(shouldKeepHistoryPreviewOnKey(ctrlInsert, { hasPreviewSelection: false }), false);
  assert.equal(
    shouldKeepHistoryPreviewOnKey({ ...ctrlInsert, shiftKey: true }, { hasPreviewSelection: true }),
    false,
  );
});
