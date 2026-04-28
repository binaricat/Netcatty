import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveScriptsSidePanelShortcutIntent,
  resolveSnippetsShortcutIntent,
} from "./resolveSnippetsShortcutIntent.ts";

test("active single terminal tab toggles the terminal scripts panel", () => {
  const result = resolveSnippetsShortcutIntent({
    activeTabId: "s1",
    sessionForTab: { id: "s1" },
    workspaceForTab: null,
  });

  assert.deepEqual(result, { kind: "toggleTerminalScripts" });
});

test("active workspace tab toggles the terminal scripts panel", () => {
  const result = resolveSnippetsShortcutIntent({
    activeTabId: "w1",
    sessionForTab: null,
    workspaceForTab: { id: "w1" },
  });

  assert.deepEqual(result, { kind: "toggleTerminalScripts" });
});

test("non-terminal tabs navigate to the vault snippets section", () => {
  for (const activeTabId of ["vault", "sftp", "editor:notes", "log1", null]) {
    const result = resolveSnippetsShortcutIntent({
      activeTabId,
      sessionForTab: null,
      workspaceForTab: null,
    });

    assert.deepEqual(result, { kind: "openVaultSnippets" });
  }
});

test("terminal tabs fall back to vault snippets when terminal toggle is unavailable", () => {
  const result = resolveSnippetsShortcutIntent({
    activeTabId: "s1",
    sessionForTab: { id: "s1" },
    workspaceForTab: null,
    terminalScriptsToggleAvailable: false,
  });

  assert.deepEqual(result, { kind: "openVaultSnippets" });
});

test("scripts panel shortcut closes when scripts is already open", () => {
  const result = resolveScriptsSidePanelShortcutIntent("scripts");

  assert.deepEqual(result, { kind: "closeTerminalSidePanel" });
});

test("scripts panel shortcut opens scripts from closed or other panel states", () => {
  for (const activePanel of [null, "sftp", "theme", "ai"]) {
    const result = resolveScriptsSidePanelShortcutIntent(activePanel);

    assert.deepEqual(result, { kind: "openTerminalScripts" });
  }
});
