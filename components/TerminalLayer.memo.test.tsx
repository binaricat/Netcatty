import test from "node:test";
import assert from "node:assert/strict";

import { terminalLayerAreEqual } from "./terminalLayerMemo.ts";

const baseProps = {
  hosts: [],
  customGroups: [],
  groupConfigs: [],
  proxyProfiles: [],
  keys: [],
  identities: [],
  snippets: [],
  snippetPackages: [],
  sessions: [],
  workspaces: [],
  knownHosts: [],
  draggingSessionId: null,
  terminalTheme: {},
  terminalThemeId: "midnight",
  followAppTerminalTheme: false,
  accentMode: "theme",
  customAccent: null,
  terminalSettings: {},
  fontSize: 14,
  hotkeyScheme: "default",
  keyBindings: [],
  sftpDefaultViewMode: "list",
  sftpDoubleClickBehavior: "open",
  sftpAutoSync: false,
  sftpShowHiddenFiles: false,
  sftpUseCompressedUpload: false,
  sftpAutoOpenSidebar: false,
  terminalSidePanelAutoOpen: false,
  terminalSidePanelAutoOpenTab: "scripts",
  sftpFollowTerminalCwd: false,
  setSftpFollowTerminalCwd: () => {},
  editorWordWrap: false,
  sshDebugLogsEnabled: false,
  setEditorWordWrap: () => {},
  onHotkeyAction: () => {},
  onUpdateHost: () => {},
  onUpdateFollowAppTerminalThemeId: () => {},
  onAddKnownHost: () => {},
  onToggleWorkspaceViewMode: () => {},
  onSetWorkspaceFocusedSession: () => {},
  isBroadcastEnabled: () => false,
  onToggleBroadcast: () => {},
  isGlobalBroadcastEnabled: false,
  canUseGlobalBroadcast: false,
  onToggleGlobalBroadcast: () => {},
  updateSnippets: () => {},
  updateSnippetPackages: () => {},
  onSplitSession: () => {},
  onConnectToHost: () => {},
  toggleScriptsSidePanelRef: { current: null },
};

test("TerminalLayer re-renders when group configs change", () => {
  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      { ...baseProps, groupConfigs: [{ path: "prod", proxyProfileId: "proxy-1" }] } as never,
    ),
    false,
  );
});

test("TerminalLayer re-renders when known hosts change", () => {
  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      {
        ...baseProps,
        knownHosts: [{
          id: "kh-1",
          hostname: "switch.local",
          port: 22,
          keyType: "ssh-ed25519",
          fingerprint: "fingerprint",
          discoveredAt: 1,
        }],
      } as never,
    ),
    false,
  );
});

test("TerminalLayer re-renders when the known host save handler changes", () => {
  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      { ...baseProps, onAddKnownHost: () => {} } as never,
    ),
    false,
  );
});

test("TerminalLayer re-renders when proxy profiles change", () => {
  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      {
        ...baseProps,
        proxyProfiles: [{
          id: "proxy-1",
          label: "Office Proxy",
          config: { type: "http", host: "proxy.example.com", port: 3128 },
          createdAt: 1,
        }],
      } as never,
    ),
    false,
  );
});

test("TerminalLayer re-renders when broadcast state changes", () => {
  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      { ...baseProps, isBroadcastEnabled: () => true } as never,
    ),
    false,
  );
});

test("TerminalLayer re-renders when global broadcast state changes", () => {
  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      { ...baseProps, isGlobalBroadcastEnabled: true } as never,
    ),
    false,
  );
  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      { ...baseProps, canUseGlobalBroadcast: true } as never,
    ),
    false,
  );
});

test("TerminalLayer re-renders when terminal side panel auto-open settings change", () => {
  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      { ...baseProps, terminalSidePanelAutoOpen: true } as never,
    ),
    false,
  );

  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      { ...baseProps, terminalSidePanelAutoOpenTab: "history" } as never,
    ),
    false,
  );
});

test("TerminalLayer re-renders when broadcast toggle handler changes", () => {
  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      { ...baseProps, onToggleBroadcast: () => {} } as never,
    ),
    false,
  );
});

test("TerminalLayer re-renders when snippet save handlers change", () => {
  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      { ...baseProps, updateSnippets: () => {} } as never,
    ),
    false,
  );

  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      { ...baseProps, updateSnippetPackages: () => {} } as never,
    ),
    false,
  );
});

test("TerminalLayer re-renders when SSH debug logging changes", () => {
  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      { ...baseProps, sshDebugLogsEnabled: true } as never,
    ),
    false,
  );
});

test("TerminalLayer re-renders when follow-app terminal theme mode changes", () => {
  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      { ...baseProps, followAppTerminalTheme: true } as never,
    ),
    false,
  );
});

test("TerminalLayer re-renders when the visible terminal theme id changes", () => {
  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      { ...baseProps, terminalThemeId: "snow" } as never,
    ),
    false,
  );
});

test("TerminalLayer re-renders when a note open request changes", () => {
  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      { ...baseProps, openNoteRequest: { tabId: "session-1", noteId: "note-1", requestId: 1 } } as never,
    ),
    false,
  );
});

test("TerminalLayer ignores shellHistory prop churn (reads shellHistoryStore instead)", () => {
  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      { ...baseProps, shellHistory: [{ id: "1", command: "ls", hostId: "h", hostLabel: "h", sessionId: "s", timestamp: 1 }] } as never,
    ),
    true,
  );
});

test("TerminalLayer ignores notes prop churn (reads notesStore instead)", () => {
  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      {
        ...baseProps,
        notes: [{ id: "n1", title: "One", content: "body", tags: [], createdAt: 1, updatedAt: 1, order: 1000 }],
        noteGroups: ["Ops"],
        updateNotes: () => {},
        updateNoteGroups: () => {},
      } as never,
    ),
    true,
  );
});

test("TerminalLayer ignores customAccent prop churn (reads appearanceChromeStore instead)", () => {
  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      { ...baseProps, accentMode: "custom", customAccent: "#ff00aa" } as never,
    ),
    true,
  );
});

test("TerminalLayer ignores sessions dynamicTitle-only updates", () => {
  const sessionsA = [{
    id: "s1",
    hostId: "h1",
    hostLabel: "host",
    username: "root",
    hostname: "example.test",
    status: "connected",
    dynamicTitle: "old",
  }];
  const sessionsB = [{
    ...sessionsA[0],
    dynamicTitle: "new",
    codingCliProviderId: "claude",
  }];
  assert.equal(
    terminalLayerAreEqual(
      { ...baseProps, sessions: sessionsA } as never,
      { ...baseProps, sessions: sessionsB } as never,
    ),
    true,
  );
});

test("TerminalLayer re-renders when portForwardingRules change", () => {
  assert.equal(
    terminalLayerAreEqual(
      baseProps as never,
      { ...baseProps, portForwardingRules: [{ id: "pf-1" }] } as never,
    ),
    false,
  );
});

test("TerminalLayer re-renders when terminalFontFamilyId changes", () => {
  assert.equal(
    terminalLayerAreEqual(
      { ...baseProps, terminalFontFamilyId: "jetbrain-mono" } as never,
      { ...baseProps, terminalFontFamilyId: "sf-mono" } as never,
    ),
    false,
  );
});
