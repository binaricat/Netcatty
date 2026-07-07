import test from "node:test";
import assert from "node:assert/strict";

import { resolveTerminalAutocompleteSettings } from "./autocomplete/terminalAutocompleteSettings.ts";

test("keeps autocomplete enabled for shell-like terminal protocols", () => {
  assert.deepEqual(
    resolveTerminalAutocompleteSettings({
      protocol: "ssh",
      terminalSettings: {
        autocompleteEnabled: true,
        autocompleteGhostText: false,
        autocompletePopupMenu: true,
        autocompleteDebounceMs: 120,
        autocompleteMinChars: 2,
        autocompleteMaxSuggestions: 6,
        shiftEnterNewlineEnabled: false,
      },
    }),
    {
      enabled: true,
      showGhostText: false,
      showPopupMenu: true,
      livePreview: true,
      allowLineReplacement: true,
      debounceMs: 120,
      minChars: 2,
      maxSuggestions: 6,
      shiftEnterNewlineEnabled: false,
    },
  );
});

test("keeps serial autocomplete available but disables input-line preview and replacement", () => {
  assert.deepEqual(
    resolveTerminalAutocompleteSettings({
      protocol: "serial",
      terminalSettings: {
        autocompleteEnabled: true,
        autocompleteGhostText: false,
        autocompletePopupMenu: true,
        autocompleteDebounceMs: 100,
        autocompleteMinChars: 1,
        autocompleteMaxSuggestions: 8,
      },
    }),
    {
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
  );
});
