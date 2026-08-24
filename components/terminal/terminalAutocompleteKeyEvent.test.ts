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
      escMetaPrefixUntilRef: { current: 0 },
      now: () => 1_000,
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

test("Esc dismisses the popup and arms Meta prefix so Esc+. can yank-last-arg", () => {
  const { context, clears } = createContext();
  const event = keyEvent("Escape");

  const result = handleTerminalAutocompleteKeyEvent(event, context);

  assert.equal(result, false);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(clears, [1]);
  assert.ok(context.escMetaPrefixUntilRef.current > 1_000);
});

test("Esc+. after dismissing the popup sends ESC+. to the shell", () => {
  const { context, writes } = createContext();
  handleTerminalAutocompleteKeyEvent(keyEvent("Escape"), context);
  context.stateRef.current = {
    ...context.stateRef.current,
    popupVisible: false,
    suggestions: [],
  };

  const period = keyEvent(".");
  const result = handleTerminalAutocompleteKeyEvent(period, context);

  assert.equal(result, false);
  assert.equal(period.defaultPrevented, true);
  assert.deepEqual(writes, ["\x1b."]);
  assert.equal(context.typedInputBufferRef.current, "");
  assert.equal(context.typedBufferReliableRef.current, false);
  assert.equal(context.lastAcceptedCommandRef.current, null);
});

test("Esc then Shift+. does not yank (Shift+. is >)", () => {
  const { context, writes } = createContext();
  handleTerminalAutocompleteKeyEvent(keyEvent("Escape"), context);
  context.stateRef.current = {
    ...context.stateRef.current,
    popupVisible: false,
    suggestions: [],
  };

  const greaterThan = shiftKeyEvent(">");
  const result = handleTerminalAutocompleteKeyEvent(greaterThan, context);

  assert.equal(result, true);
  assert.deepEqual(writes, []);
});

test("Esc+_ after dismissing the popup sends ESC+_ to the shell", () => {
  const { context, writes } = createContext();
  handleTerminalAutocompleteKeyEvent(keyEvent("Escape"), context);
  context.stateRef.current = {
    ...context.stateRef.current,
    popupVisible: false,
    suggestions: [],
  };

  const underscore = shiftKeyEvent("_");
  const result = handleTerminalAutocompleteKeyEvent(underscore, context);

  assert.equal(result, false);
  assert.deepEqual(writes, ["\x1b_"]);
});

test("Esc then Shift keydown then _ still yanks (Shift is a separate event)", () => {
  const { context, writes } = createContext();
  handleTerminalAutocompleteKeyEvent(keyEvent("Escape"), context);
  context.stateRef.current = {
    ...context.stateRef.current,
    popupVisible: false,
    suggestions: [],
  };

  const shiftDown = shiftKeyEvent("Shift");
  assert.equal(handleTerminalAutocompleteKeyEvent(shiftDown, context), true);
  assert.ok(context.escMetaPrefixUntilRef.current > 1_000);

  const underscore = shiftKeyEvent("_");
  const result = handleTerminalAutocompleteKeyEvent(underscore, context);

  assert.equal(result, false);
  assert.deepEqual(writes, ["\x1b_"]);
});

test("Esc then a non-Meta follow-up does not inject ESC and lets the key through", () => {
  const { context, writes } = createContext();
  handleTerminalAutocompleteKeyEvent(keyEvent("Escape"), context);
  context.stateRef.current = {
    ...context.stateRef.current,
    popupVisible: false,
    suggestions: [],
  };

  const letter = keyEvent("l");
  const result = handleTerminalAutocompleteKeyEvent(letter, context);

  assert.equal(result, true);
  assert.deepEqual(writes, []);
  assert.equal(context.escMetaPrefixUntilRef.current, 0);
});

test("Esc+. after the Meta prefix timeout does not yank", () => {
  let now = 1_000;
  const { context, writes } = createContext({ now: () => now });
  handleTerminalAutocompleteKeyEvent(keyEvent("Escape"), context);
  context.stateRef.current = {
    ...context.stateRef.current,
    popupVisible: false,
    suggestions: [],
  };
  now = 1_000 + 501;

  const period = keyEvent(".");
  const result = handleTerminalAutocompleteKeyEvent(period, context);

  assert.equal(result, true);
  assert.deepEqual(writes, []);
});

test("subdir Escape does not arm Meta prefix", () => {
  const { context, clears } = createContext({
    stateRef: {
      current: {
        suggestions: [suggestion("show version")],
        selectedIndex: 0,
        popupVisible: true,
        popupAnchorViewport: { left: 0, top: 0, bottom: 0 },
        expandUpward: false,
        subDirPanels: [{ entries: [{ name: "src", type: "directory" }], selectedIndex: 0, dirPath: "/src" }],
        subDirFocusLevel: 0,
      },
    },
  });
  const event = keyEvent("Escape");

  const result = handleTerminalAutocompleteKeyEvent(event, context);

  assert.equal(result, false);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(clears, []);
  assert.equal(context.escMetaPrefixUntilRef.current, 0);
});

