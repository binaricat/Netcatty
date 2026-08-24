import test from "node:test";
import assert from "node:assert/strict";

import type { AutocompleteSettings } from "./autocomplete/useTerminalAutocomplete.ts";
import type { AutocompleteState } from "./autocomplete/useTerminalAutocomplete.ts";
import type { CompletionSuggestion } from "./autocomplete/completionEngine.ts";

const { handleTerminalAutocompleteInput } = await import(
  "./autocomplete/terminalAutocompleteInput.ts"
);
const { reconcileAutocompletePopupState } = await import(
  "./autocomplete/useTerminalAutocomplete.ts"
);

const ref = <T>(current: T) => ({ current });

function createContext(input: string) {
  const syncInputs: Array<string | null> = [];
  let clearCount = 0;
  let fetchCount = 0;
  const settings: AutocompleteSettings = {
    enabled: true,
    showGhostText: false,
    showPopupMenu: true,
    livePreview: true,
    allowLineReplacement: true,
    debounceMs: 10_000,
    minChars: 1,
    maxSuggestions: 50,
    fastTypingThresholdMs: 40,
    shiftEnterNewlineEnabled: true,
    historyScope: "host",
  };
  const context = {
    settingsRef: ref(settings),
    lastKeystrokeRef: ref(Date.now()),
    suppressNextEnterRecordRef: ref(false),
    lastAcceptedCommandRef: ref<string | null>(null),
    typedInputBufferRef: ref(input),
    typedBufferReliableRef: ref(true),
    previewBaselineRef: ref(input),
    previewActiveRef: ref(false),
    termRef: ref(null),
    hostIdRef: ref("host-1"),
    hostOsRef: ref<"linux" | "windows" | "macos">("linux"),
    ghostAddonRef: ref(null),
    debounceTimerRef: ref<ReturnType<typeof setTimeout> | null>(null),
    clearState: () => { clearCount++; },
    syncPopupToInput: (nextInput: string | null) => { syncInputs.push(nextInput); },
    fetchSuggestions: () => { fetchCount++; },
  };
  return {
    context,
    syncInputs,
    getClearCount: () => clearCount,
    getFetchCount: () => fetchCount,
    cleanup: () => {
      if (context.debounceTimerRef.current) clearTimeout(context.debounceTimerRef.current);
    },
  };
}

test("rapid edits reconcile the popup before the debounced refresh", () => {
  const harness = createContext("python3.14 -m r");
  try {
    handleTerminalAutocompleteInput("\x7f", harness.context);
    handleTerminalAutocompleteInput("p", harness.context);

    assert.deepEqual(harness.syncInputs, ["python3.14 -m ", "python3.14 -m p"]);
    assert.equal(harness.getFetchCount(), 0);
  } finally {
    harness.cleanup();
  }
});

test("cursor movement clears the popup and marks the typed buffer unreliable", () => {
  const harness = createContext("python3.14 -m r");
  try {
    handleTerminalAutocompleteInput("\x1b[D", harness.context);

    assert.equal(harness.context.typedBufferReliableRef.current, false);
    assert.equal(harness.getClearCount(), 1);
    assert.deepEqual(harness.syncInputs, []);
  } finally {
    harness.cleanup();
  }
});

test("deleting below the minimum input length clears visible popup rows", () => {
  const harness = createContext("r");
  try {
    handleTerminalAutocompleteInput("\x7f", harness.context);

    assert.deepEqual(harness.syncInputs, [null]);
    assert.equal(harness.getFetchCount(), 0);
  } finally {
    harness.cleanup();
  }
});

const historySuggestion = (text: string): CompletionSuggestion => ({
  text,
  displayText: text,
  source: "history",
  score: 1000,
});

const popupState = (
  suggestions: CompletionSuggestion[],
  selectedIndex = 0,
): AutocompleteState => ({
  suggestions,
  selectedIndex,
  popupVisible: true,
  popupAnchorViewport: { left: 0, top: 0, bottom: 0 },
  expandUpward: false,
  subDirPanels: [{
    entries: [{ name: "old", type: "directory" }],
    selectedIndex: 0,
    dirPath: "/tmp/",
  }],
  subDirFocusLevel: 0,
});

test("edited arguments immediately discard incompatible history rows and selection", () => {
  const next = reconcileAutocompletePopupState(
    popupState([
      historySuggestion("python3.14 -m robot -d /home/user/Desktop/suite9"),
      historySuggestion("python3.14 -m pip list --outdated"),
    ]),
    "python3.14 -m p",
  );

  assert.deepEqual(next.suggestions.map((suggestion) => suggestion.text), [
    "python3.14 -m pip list --outdated",
  ]);
  assert.equal(next.selectedIndex, -1);
  assert.deepEqual(next.subDirPanels, []);
  assert.equal(next.subDirFocusLevel, -1);
});

test("rapid command-name input keeps a valid fuzzy history row", () => {
  const suggestion = historySuggestion("docker compose up");
  let state = popupState([suggestion], -1);

  for (const input of ["d", "dc", "dcu"]) {
    state = reconcileAutocompletePopupState(state, input);
    assert.deepEqual(state.suggestions, [suggestion]);
  }
});

test("deleting below the fuzzy-history threshold removes a non-prefix row", () => {
  const state = popupState([historySuggestion("docker compose up")], -1);

  const fuzzyMatch = reconcileAutocompletePopupState(state, "oc");
  assert.equal(fuzzyMatch.suggestions.length, 1);

  const singleCharacter = reconcileAutocompletePopupState(fuzzyMatch, "o");
  assert.deepEqual(singleCharacter.suggestions, []);
  assert.equal(singleCharacter.popupVisible, false);
});

test("path history follows the current argument instead of the whole line", () => {
  const suggestion: CompletionSuggestion = {
    ...historySuggestion("cat package.json"),
    historyMatch: "path-argument",
  };

  const matching = reconcileAutocompletePopupState(
    popupState([suggestion], -1),
    "cat --number pack",
  );
  assert.deepEqual(matching.suggestions, [suggestion]);

  const changedArgument = reconcileAutocompletePopupState(matching, "cat src");
  assert.deepEqual(changedArgument.suggestions, []);
  assert.equal(changedArgument.popupVisible, false);
});

test("provider-specific non-history rows remain until their debounced refresh", () => {
  const snippet: CompletionSuggestion = {
    text: "deploy production",
    displayText: "deploy production",
    source: "snippet",
    score: 2000,
  };

  const next = reconcileAutocompletePopupState(popupState([snippet]), "dp");
  assert.deepEqual(next.suggestions, [snippet]);
  assert.equal(next.selectedIndex, -1);
});

test("editing a live preview advances the restore baseline", () => {
  const harness = createContext("docker compose up");
  harness.context.previewBaselineRef.current = "dc";
  harness.context.previewActiveRef.current = true;
  try {
    handleTerminalAutocompleteInput(" ", harness.context);

    assert.equal(harness.context.previewActiveRef.current, false);
    assert.equal(harness.context.previewBaselineRef.current, "docker compose up ");
  } finally {
    harness.cleanup();
  }
});
