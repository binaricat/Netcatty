import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../application/i18n/I18nProvider.tsx";
import { STORAGE_KEY_VAULT_KEYS_VIEW_MODE } from "../infrastructure/config/storageKeys.ts";
import type { Identity, SSHKey } from "../types.ts";
import KeychainManager from "./KeychainManager.tsx";
import { IdentityCard } from "./keychain/IdentityCard.tsx";
import { KeyCard } from "./keychain/KeyCard.tsx";

const longLabel =
  "sdakdjkasjakjskajskaijssdakdjkasjakjskajskaijssdakdjkasjakjskajskaijssdakdjkasjakjskajskaijs";

const renderWithI18n = (node: React.ReactElement) =>
  renderToStaticMarkup(
    React.createElement(I18nProvider, { locale: "en" }, node),
  );

const installStorageStub = (viewMode: string | null = null) => {
  const values = new Map<string, string>();
  if (viewMode) {
    values.set(STORAGE_KEY_VAULT_KEYS_VIEW_MODE, viewMode);
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

const installNavigatorStub = () => {
  const currentNavigator = globalThis.navigator;
  if (
    typeof currentNavigator?.platform === "string" &&
    typeof currentNavigator?.userAgent === "string"
  ) {
    return;
  }

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      platform: "MacIntel",
      userAgent: "Mac OS",
    },
  });
};

const identity: Identity = {
  id: "identity-1",
  label: longLabel,
  username: "root",
  authMethod: "password",
  password: "pw",
  created: 1,
};

const keyItem: SSHKey = {
  id: "key-1",
  label: longLabel,
  type: "ED25519",
  privateKey: "",
  publicKey: "",
  source: "imported",
  category: "key",
  created: 1,
};

test("IdentityCard list layout constrains long labels", () => {
  const markup = renderWithI18n(
    React.createElement(IdentityCard, {
      identity,
      viewMode: "list",
      isSelected: false,
      onClick: () => {},
    }),
  );

  assert.match(markup, /group cursor-pointer min-w-0 w-full max-w-full/);
  assert.doesNotMatch(markup, /group cursor-pointer min-w-0 w-full max-w-full overflow-hidden/);
  assert.match(markup, /flex items-center gap-3 h-full min-w-0/);
  assert.doesNotMatch(markup, /flex items-center gap-3 h-full min-w-0 overflow-hidden/);
  assert.match(markup, /min-w-0 flex-1 basis-0 overflow-hidden/);
  assert.match(markup, /block max-w-full truncate text-sm font-semibold/);
});

test("KeyCard list layout constrains long labels", () => {
  const markup = renderWithI18n(
    React.createElement(KeyCard, {
      keyItem,
      viewMode: "list",
      isSelected: false,
      isMac: false,
      onClick: () => {},
      onEdit: () => {},
      onExport: () => {},
      onCopyPublicKey: () => {},
      onDelete: () => {},
    }),
  );

  assert.match(markup, /group cursor-pointer min-w-0 w-full max-w-full/);
  assert.doesNotMatch(markup, /group cursor-pointer min-w-0 w-full max-w-full overflow-hidden/);
  assert.match(markup, /flex items-center gap-3 h-full min-w-0/);
  assert.doesNotMatch(markup, /flex items-center gap-3 h-full min-w-0 overflow-hidden/);
  assert.match(markup, /min-w-0 flex-1 basis-0 overflow-hidden/);
  assert.match(markup, /block max-w-full truncate text-sm font-semibold/);
});

test("KeychainManager list layout constrains long key and identity rows", () => {
  installNavigatorStub();
  installStorageStub("list");

  const markup = renderWithI18n(
    React.createElement(KeychainManager, {
      keys: [keyItem],
      identities: [identity],
      hosts: [],
      proxyProfiles: [],
      customGroups: [],
      groupConfigs: [],
      managedSources: [],
      onSave: () => {},
      onUpdate: () => {},
      onReorderKeys: () => {},
      onDelete: () => {},
      onSaveIdentity: () => {},
      onReorderIdentities: () => {},
      onDeleteIdentity: () => {},
    }),
  );

  assert.match(markup, /h-full min-w-0 w-full overflow-hidden flex relative/);
  assert.match(markup, /flex-1 min-w-0 w-full overflow-y-auto/);
  assert.doesNotMatch(markup, /flex-1 min-w-0 w-full overflow-y-auto overflow-x-hidden/);
  assert.match(markup, /flex min-w-0 w-full max-w-full flex-col gap-0/);
  assert.match(markup, /block min-w-0 w-full max-w-full/);
  assert.match(markup, /Keys/);
  assert.match(markup, /Identities/);
});
