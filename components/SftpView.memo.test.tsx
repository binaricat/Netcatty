import test from "node:test";
import assert from "node:assert/strict";

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
