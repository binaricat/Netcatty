import test from "node:test";
import assert from "node:assert/strict";

import { vaultViewAreEqual } from "./VaultView.tsx";

test("VaultView re-renders when an external section navigation request changes", () => {
  const baseProps = {
    hosts: [],
    keys: [],
    identities: [],
    snippets: [],
    snippetPackages: [],
    customGroups: [],
    knownHosts: [],
    shellHistory: [],
    connectionLogs: [],
    sessions: [],
    managedSources: [],
    groupConfigs: {},
    terminalThemeId: "default",
    terminalFontSize: 14,
    navigateToSection: null,
  };

  assert.equal(
    vaultViewAreEqual(
      baseProps as never,
      { ...baseProps, navigateToSection: "snippets" } as never,
    ),
    false,
  );
});
