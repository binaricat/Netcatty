import test from "node:test";
import assert from "node:assert/strict";

import { handleTerminalAutocompleteKeyEvent } from "./autocomplete/terminalAutocompleteKeyEvent.ts";

const suggestion = (text: string) => ({
  text,
  displayText: text,
  source: "history" as const,
  score: 1,
});

function keyEvent(key: string) {
  return {
    type: "keydown",
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  } as KeyboardEvent & { defaultPrevented: boolean };
}

function shiftKeyEvent(key: string) {
  return {
    ...keyEvent(key),
    shiftKey: true,
  } as KeyboardEvent & { defaultPrevented: boolean };
}

function createContext(overrides: Record<string, unknown> = {}) {
  let state = {
    suggestions: [suggestion("show version")],
    selectedIndex: -1,
    popupVisible: true,
    popupAnchorViewport: { left: 0, top: 0, bottom: 0 },
    expandUpward: false,
    subDirPanels: [],
    subDirFocusLevel: -1,
  };
  const writes: string[] = [];
  const previews: number[] = [];
  const accepted: number[] = [];
  const clears: number[] = [];
  const stateRef = { current: state };

  return {
    writes,
    previews,
    accepted,
    clears,
    context: {
      settingsRef: {
        current: {
          enabled: true,
          showGhostText: false,
          showPopupMenu: true,
          debounceMs: 100,
          minChars: 1,
          maxSuggestions: 8,
          livePreview: false,
          allowLineReplacement: false,
          shiftEnterNewlineEnabled: true,
        },
      },
      stateRef,
      ghostAddonRef: { current: null },
      typedInputBufferRef: { current: "sh" },
      typedBufferReliableRef: { current: true },
      previewActiveRef: { current: false },
      lastAcceptedCommandRef: { current: null },
      setState(update: typeof state | ((prev: typeof state) => typeof state)) {
        state = typeof update === "function" ? update(state) : update;
        stateRef.current = state;
      },
      expandSubDir() {},
      writeToTerminal(text: string) { writes.push(text); },
      clearState() { clears.push(1); },
      renderSubDirPath() {},
      handleSubDirSelect() {},
      fetchSubDirForIndex() {},
      renderPreviewSelection(index: number) { previews.push(index); },
      acceptSnippet() { return true; },
      acceptPreviewlessSelection(index: number) { accepted.push(index); return true; },
      ...overrides,
    },
  };
}

test("serial-style popup navigation does not render candidates into the input line", () => {
  const { context, previews } = createContext();
  const event = keyEvent("ArrowDown");

  const result = handleTerminalAutocompleteKeyEvent(event, context);

  assert.equal(result, false);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(previews, []);
});

test("serial-style popup Enter confirms the selected candidate instead of passing Enter through", () => {
  const { context, accepted, clears } = createContext({
    stateRef: {
      current: {
        suggestions: [suggestion("show version")],
        selectedIndex: 0,
        popupVisible: true,
        popupAnchorViewport: { left: 0, top: 0, bottom: 0 },
        expandUpward: false,
        subDirPanels: [],
        subDirFocusLevel: -1,
      },
    },
  });
  const event = keyEvent("Enter");

  const result = handleTerminalAutocompleteKeyEvent(event, context);

  assert.equal(result, false);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(accepted, [0]);
  assert.deepEqual(clears, []);
});

test("serial-style popup Enter passes through when the selected candidate is stale", () => {
  const { context, accepted, clears } = createContext({
    stateRef: {
      current: {
        suggestions: [suggestion("show version")],
        selectedIndex: 0,
        popupVisible: true,
        popupAnchorViewport: { left: 0, top: 0, bottom: 0 },
        expandUpward: false,
        subDirPanels: [],
        subDirFocusLevel: -1,
      },
    },
    acceptPreviewlessSelection(index: number) {
      accepted.push(index);
      return false;
    },
  });
  const event = keyEvent("Enter");

  const result = handleTerminalAutocompleteKeyEvent(event, context);

  assert.equal(result, true);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(accepted, [0]);
  assert.deepEqual(clears, [1]);
});

test("serial-style popup Shift+Enter is not treated as candidate confirmation", () => {
  const { context, accepted, clears } = createContext({
    stateRef: {
      current: {
        suggestions: [suggestion("show version")],
        selectedIndex: 0,
        popupVisible: true,
        popupAnchorViewport: { left: 0, top: 0, bottom: 0 },
        expandUpward: false,
        subDirPanels: [],
        subDirFocusLevel: -1,
      },
    },
  });
  const event = shiftKeyEvent("Enter");

  const result = handleTerminalAutocompleteKeyEvent(event, context);

  assert.equal(result, true);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(accepted, []);
  assert.deepEqual(clears, []);
});

test("serial-style popup Shift+Enter confirms candidate when terminal shortcut is disabled", () => {
  const { context, accepted, clears } = createContext({
    stateRef: {
      current: {
        suggestions: [suggestion("show version")],
        selectedIndex: 0,
        popupVisible: true,
        popupAnchorViewport: { left: 0, top: 0, bottom: 0 },
        expandUpward: false,
        subDirPanels: [],
        subDirFocusLevel: -1,
      },
    },
  });
  context.settingsRef.current.shiftEnterNewlineEnabled = false;
  const event = shiftKeyEvent("Enter");

  const result = handleTerminalAutocompleteKeyEvent(event, context);

  assert.equal(result, false);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(accepted, [0]);
  assert.deepEqual(clears, []);
});
