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
        autocompleteHistoryScope: "global",
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
      historyScope: "global",
      shiftEnterNewlineEnabled: false,
    },
  );
});

test("keeps network-device autocomplete popup but disables live preview (#1193)", () => {
  assert.deepEqual(
    resolveTerminalAutocompleteSettings({
      protocol: "ssh",
      isNetworkDevice: true,
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
      livePreview: false,
      allowLineReplacement: true,
      debounceMs: 100,
      minChars: 1,
      maxSuggestions: 8,
      historyScope: "host",
      shiftEnterNewlineEnabled: true,
    },
  );
  assert.deepEqual(
    resolveTerminalAutocompleteSettings({
      protocol: "ssh",
      isNetworkDevice: true,
    }),
    { livePreview: false },
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
      historyScope: "host",
      livePreview: false,
      allowLineReplacement: false,
      shiftEnterNewlineEnabled: true,
    },
  );
});

test("defaults autocomplete history scope to host when unset", () => {
  assert.equal(
    resolveTerminalAutocompleteSettings({
      protocol: "ssh",
      terminalSettings: {
        autocompleteEnabled: true,
      },
    })?.historyScope,
    "host",
  );
});

test("falls back to raised maxSuggestions default when unset", () => {
  assert.equal(
    resolveTerminalAutocompleteSettings({
      protocol: "ssh",
      terminalSettings: {
        autocompleteEnabled: true,
      },
    })?.maxSuggestions,
    50,
  );
  assert.equal(
    resolveTerminalAutocompleteSettings({
      protocol: "serial",
    })?.maxSuggestions,
    50,
  );
});

test('unknown systems do not rewrite the command line while retaining suggestions', () => {
  for (const terminalSettings of [undefined, { autocompleteEnabled: true }]) {
    const settings = resolveTerminalAutocompleteSettings({protocol:'ssh', systemUnknown:true, terminalSettings});
    assert.equal(settings?.enabled, true);
    assert.equal(settings?.livePreview, false);
    assert.equal(settings?.allowLineReplacement, false);
  }
});
