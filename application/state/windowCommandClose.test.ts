import test from "node:test";
import assert from "node:assert/strict";

import { matchesKeyBinding } from "../../domain/models.ts";
import { isPrimaryModifierWBinding, resolveWindowCommandCloseIntent } from "./windowCommandClose.ts";

test("primary-modifier W only belongs to the matching close-tab binding", () => {
  assert.equal(isPrimaryModifierWBinding("⌘ + W", matchesKeyBinding, true), true);
  assert.equal(isPrimaryModifierWBinding("⌘ + E", matchesKeyBinding, true), false);
  assert.equal(isPrimaryModifierWBinding("Ctrl + W", matchesKeyBinding, false), true);
  assert.equal(isPrimaryModifierWBinding("Disabled", matchesKeyBinding, true), false);
  assert.equal(isPrimaryModifierWBinding(null, matchesKeyBinding, true), false);
});

test("Cmd+W closes the active closable tab first", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "s1",
      editorTabIds: [],
      sessionIds: ["s1", "s2"],
      workspaceIds: [],
      logViewIds: [],
    }),
    { kind: "closeTab" },
  );
});

test("disabled close-tab binding forwards native Cmd+W to other custom shortcuts", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "s1",
      editorTabIds: [],
      sessionIds: ["s1"],
      workspaceIds: [],
      logViewIds: [],
      closeTabShortcutEnabled: false,
    }),
    { kind: "forwardShortcut" },
  );
});

test("disabled close-tab binding forwards native Cmd+W while a dialog is open", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "s1",
      editorTabIds: [],
      sessionIds: ["s1"],
      workspaceIds: [],
      logViewIds: [],
      closeTabShortcutEnabled: false,
      hasOpenDialog: true,
    }),
    { kind: "forwardShortcut" },
  );
});

test("enabled close-tab binding closes the topmost dialog before the active tab", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "s1",
      editorTabIds: [],
      sessionIds: ["s1"],
      workspaceIds: [],
      logViewIds: [],
      closeTabShortcutEnabled: true,
      hasOpenDialog: true,
    }),
    { kind: "closeDialog" },
  );
});

test("disabled close-tab binding also forwards native Cmd+W on a log tab", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "log-1",
      editorTabIds: [],
      sessionIds: [],
      workspaceIds: [],
      logViewIds: ["log-1"],
      closeTabShortcutEnabled: false,
    }),
    { kind: "forwardShortcut" },
  );
});

test("disabled close-tab binding forwards native Cmd+W instead of closing the window", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "vault",
      editorTabIds: [],
      sessionIds: [],
      workspaceIds: [],
      logViewIds: [],
      closeTabShortcutEnabled: false,
    }),
    { kind: "forwardShortcut" },
  );
});

test("disabled close-tab binding forwards native Cmd+W when nothing is active", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: null,
      editorTabIds: [],
      sessionIds: [],
      workspaceIds: [],
      logViewIds: [],
      closeTabShortcutEnabled: false,
    }),
    { kind: "forwardShortcut" },
  );
});

test("Cmd+W on a log view closes the log view", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "log-1",
      editorTabIds: [],
      sessionIds: ["s1", "s2"],
      workspaceIds: [],
      logViewIds: ["log-1"],
    }),
    { kind: "closeLogView", tabId: "log-1" },
  );
});

test("Cmd+W closes an editor tab through the existing close flow", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "editor:1",
      editorTabIds: ["editor:1"],
      sessionIds: [],
      workspaceIds: [],
      logViewIds: [],
    }),
    { kind: "closeTab" },
  );
});

test("Cmd+W closes a native plugin view tab before the window", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "plugin-view:com.example.view:com.example.view.panel",
      editorTabIds: [],
      sessionIds: [],
      workspaceIds: [],
      logViewIds: [],
      pluginViewTabIds: ["plugin-view:com.example.view:com.example.view.panel"],
    }),
    { kind: "closeTab" },
  );
});

test("Cmd+W closes the window from the Vault page", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "vault",
      editorTabIds: [],
      sessionIds: [],
      workspaceIds: [],
      logViewIds: [],
    }),
    { kind: "closeWindow" },
  );
});

test("Cmd+W closes the window when nothing else is active", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: null,
      editorTabIds: [],
      sessionIds: [],
      workspaceIds: [],
      logViewIds: [],
    }),
    { kind: "closeWindow" },
  );
});
