import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("main SftpView keeps browse sessions across top-tab switches", () => {
  const source = readFileSync(new URL("./SftpView.tsx", import.meta.url), "utf8");
  // Mount stays alive after first visit; parking on isActive caused every
  // remote tab to reconnect when leaving SFTP for Terminal and coming back.
  assert.match(source, /interactive:\s*true/);
  assert.doesNotMatch(source, /interactive:\s*isActive/);
});

test("SftpView re-renders when host-key verification setting changes", async () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  });
  const { sftpViewAreEqual } = await import("./SftpView.tsx");

  const baseProps = {
    hosts: [],
    keys: [],
    identities: [],
    knownHosts: [],
    groupConfigs: [],
    proxyProfiles: [],
    updateHosts: () => {},
    onAddKnownHost: () => {},
    sftpDefaultViewMode: "list",
    sftpDoubleClickBehavior: "open",
    sftpAutoSync: false,
    sftpShowHiddenFiles: false,
    sftpUseCompressedUpload: false,
    hotkeyScheme: {},
    keyBindings: [],
    editorWordWrap: false,
    setEditorWordWrap: () => {},
    terminalSettings: {
      verifyHostKeys: true,
      keepaliveInterval: 30,
      keepaliveCountMax: 10,
    },
  };

  assert.equal(
    sftpViewAreEqual(
      baseProps as never,
      {
        ...baseProps,
        terminalSettings: {
          ...baseProps.terminalSettings,
          verifyHostKeys: false,
        },
      } as never,
    ),
    false,
  );
});

test("SftpView ignores session title-only updates for memoization", async () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  });
  const { sftpViewAreEqual } = await import("./SftpView.tsx");

  const baseProps = {
    hosts: [],
    sessions: [{
      id: "s1",
      hostId: "h1",
      hostLabel: "Host",
      username: "alice",
      hostname: "h1.example.test",
      protocol: "ssh",
      status: "connected",
      dynamicTitle: "old",
    }],
    keys: [],
    identities: [],
    knownHosts: [],
    groupConfigs: [],
    proxyProfiles: [],
    updateHosts: () => {},
    onAddKnownHost: () => {},
    sftpDefaultViewMode: "list",
    sftpDoubleClickBehavior: "open",
    sftpAutoSync: false,
    sftpShowHiddenFiles: false,
    sftpUseCompressedUpload: false,
    hotkeyScheme: {},
    keyBindings: [],
    editorWordWrap: false,
    setEditorWordWrap: () => {},
    terminalSettings: {
      verifyHostKeys: true,
      keepaliveInterval: 30,
      keepaliveCountMax: 10,
    },
  };

  assert.equal(
    sftpViewAreEqual(
      baseProps as never,
      {
        ...baseProps,
        sessions: [{
          ...baseProps.sessions[0],
          dynamicTitle: "new title from OSC",
        }],
      } as never,
    ),
    true,
  );

  assert.equal(
    sftpViewAreEqual(
      baseProps as never,
      {
        ...baseProps,
        sessions: [{
          ...baseProps.sessions[0],
          status: "connecting",
        }],
      } as never,
    ),
    false,
  );
});
