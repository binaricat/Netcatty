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
