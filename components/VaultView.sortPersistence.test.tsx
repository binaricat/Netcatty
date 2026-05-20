import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../application/i18n/I18nProvider.tsx";
import { STORAGE_KEY_VAULT_HOSTS_SORT_MODE } from "../infrastructure/config/storageKeys.ts";
import type { Host, SSHKey } from "../types.ts";
import { VaultView } from "./VaultView.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";

const installStorageStub = (sortMode: string | null) => {
  const values = new Map<string, string>();
  if (sortMode !== null) {
    values.set(STORAGE_KEY_VAULT_HOSTS_SORT_MODE, sortMode);
  }

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  });
};

const host = (id: string, label: string, createdAt: number, group = ""): Host => ({
  id,
  label,
  hostname: `${id}.example.com`,
  username: "root",
  tags: [],
  os: "linux",
  port: 22,
  protocol: "ssh",
  authMethod: "password",
  createdAt,
  group,
});

const fallbackKey: SSHKey = {
  id: "key-1",
  label: "Fallback key",
  type: "ED25519",
  privateKey: "",
  source: "generated",
  category: "key",
  created: 1,
};

const renderVault = (sortMode: string | null, hosts: Host[]) => {
  installStorageStub(sortMode);
  const noop = () => {};

  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(VaultView, {
          hosts,
          keys: [],
          identities: [],
          proxyProfiles: [],
          snippets: [],
          snippetPackages: [],
          customGroups: [],
          knownHosts: [],
          shellHistory: [],
          connectionLogs: [],
          managedSources: [],
          sessionCount: 0,
          hotkeyScheme: "mac",
          keyBindings: [],
          terminalThemeId: "default",
          terminalFontSize: 14,
          onOpenSettings: noop,
          onOpenQuickSwitcher: noop,
          onCreateLocalTerminal: noop,
          onDeleteHost: noop,
          onConnect: noop,
          onUpdateHosts: noop,
          onUpdateKeys: noop,
          onImportOrReuseKey: () => fallbackKey,
          onUpdateIdentities: noop,
          onUpdateProxyProfiles: noop,
          onUpdateSnippets: noop,
          onUpdateSnippetPackages: noop,
          onUpdateCustomGroups: noop,
          onUpdateKnownHosts: noop,
          onUpdateManagedSources: noop,
          onConvertKnownHost: noop,
          onToggleConnectionLogSaved: noop,
          onDeleteConnectionLog: noop,
          onClearUnsavedConnectionLogs: noop,
          onOpenLogView: noop,
          groupConfigs: [],
          onUpdateGroupConfigs: noop,
          showRecentHosts: false,
          showOnlyUngroupedHostsInRoot: false,
        }),
      ),
    ),
  );
};

test("Hosts sort mode is restored from storage", () => {
  const markup = renderVault("za", [
    host("alpha", "Alpha Host", 1),
    host("zulu", "Zulu Host", 2),
  ]);

  assert.ok(markup.indexOf("Zulu Host") < markup.indexOf("Alpha Host"));
});

test("Hosts grouped sort mode is restored from storage", () => {
  const markup = renderVault("group", [
    host("beta", "Beta Host", 1, "Beta Group"),
    host("alpha", "Alpha Host", 2, "Alpha Group"),
  ]);

  assert.match(
    markup,
    /<span class="text-sm font-medium text-muted-foreground">Alpha Group<\/span><span class="text-xs text-muted-foreground\/60">\(1\)<\/span>/,
  );
});

test("Hosts sort mode falls back safely when storage contains an invalid value", () => {
  const markup = renderVault("unknown-sort", [
    host("zulu", "Zulu Host", 2),
    host("alpha", "Alpha Host", 1),
  ]);

  assert.ok(markup.indexOf("Alpha Host") < markup.indexOf("Zulu Host"));
});
