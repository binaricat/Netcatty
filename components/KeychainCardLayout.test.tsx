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
import {
  resolvePreferredKeySection,
  shouldShowIdentitySection,
  shouldShowKeySection,
  shouldShowSearchNoResults,
} from "./keychain/utils.ts";

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

test("KeychainManager shows identities without the keys section when identities exist", () => {
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
  assert.match(markup, /data-section="keychain-identities"/);
  assert.doesNotMatch(markup, /data-section="keychain-keys"/);
  assert.doesNotMatch(markup, /data-section="keychain-empty"/);
});

test("KeychainManager shows keys without the identities section when no identities exist", () => {
  installNavigatorStub();
  installStorageStub();

  const markup = renderWithI18n(
    React.createElement(KeychainManager, {
      keys: [keyItem],
      identities: [],
      onSave: () => {},
      onUpdate: () => {},
      onDelete: () => {},
      onSaveIdentity: () => {},
    }),
  );

  assert.match(markup, /data-section="keychain-keys"/);
  assert.doesNotMatch(markup, /data-section="keychain-identities"/);
  assert.doesNotMatch(markup, /data-section="keychain-empty"/);
});

test("KeychainManager shows the empty prompt only when keys and identities are absent", () => {
  installNavigatorStub();
  installStorageStub();

  const markup = renderWithI18n(
    React.createElement(KeychainManager, {
      keys: [],
      identities: [],
      onSave: () => {},
      onUpdate: () => {},
      onDelete: () => {},
      onSaveIdentity: () => {},
    }),
  );

  assert.match(markup, /data-section="keychain-keys"/);
  assert.match(markup, /data-section="keychain-empty"/);
  assert.doesNotMatch(markup, /data-section="keychain-identities"/);
});

test("KeychainManager exposes the new identity action in the header", () => {
  installNavigatorStub();
  installStorageStub();

  const markup = renderWithI18n(
    React.createElement(KeychainManager, {
      keys: [],
      identities: [],
      onSave: () => {},
      onUpdate: () => {},
      onDelete: () => {},
      onSaveIdentity: () => {},
    }),
  );

  assert.match(markup, />New Identity<\/button>/);
});

test("keychain search reveals matching keys when identities do not match", () => {
  assert.equal(shouldShowIdentitySection({
    activeFilter: "key",
    identityCount: 1,
    filteredIdentityCount: 0,
    filteredKeyCount: 1,
    search: "matching-key",
  }), false);
});

test("keychain search keeps identities for identity matches or no results", () => {
  assert.equal(shouldShowIdentitySection({
    activeFilter: "key",
    identityCount: 1,
    filteredIdentityCount: 1,
    filteredKeyCount: 0,
    search: "matching-identity",
  }), true);
  assert.equal(shouldShowIdentitySection({
    activeFilter: "key",
    identityCount: 1,
    filteredIdentityCount: 0,
    filteredKeyCount: 0,
    search: "no-results",
  }), true);
});

test("keychain search shows both sections when both kinds match", () => {
  const state = {
    activeFilter: "key" as const,
    identityCount: 1,
    filteredIdentityCount: 1,
    filteredKeyCount: 1,
    search: "shared-label",
  };

  assert.equal(shouldShowIdentitySection(state), true);
  assert.equal(shouldShowKeySection(state), true);
});

test("keychain browsing keeps sections exclusive outside search", () => {
  assert.equal(shouldShowKeySection({
    activeFilter: "key",
    identityCount: 1,
    filteredKeyCount: 1,
    search: "",
  }), false);
  assert.equal(shouldShowKeySection({
    activeFilter: "key",
    identityCount: 0,
    filteredKeyCount: 1,
    search: "",
  }), true);
});

test("keychain browsing can switch back to the full key section", () => {
  const state = {
    activeFilter: "key" as const,
    identityCount: 1,
    filteredIdentityCount: 1,
    filteredKeyCount: 1,
    preferredSection: "key" as const,
    search: "",
  };

  assert.equal(shouldShowIdentitySection(state), false);
  assert.equal(shouldShowKeySection(state), true);
});

test("keychain default follows identities until the user chooses a section", () => {
  assert.equal(resolvePreferredKeySection(null, 0), "key");
  assert.equal(resolvePreferredKeySection(null, 1), "identity");
  assert.equal(resolvePreferredKeySection("key", 1), "key");
  assert.equal(resolvePreferredKeySection("identity", 0), "key");
});

test("keychain distinguishes search misses from an empty vault", () => {
  assert.equal(shouldShowSearchNoResults("missing", 0, 1), true);
  assert.equal(shouldShowSearchNoResults("", 0, 1), false);
  assert.equal(shouldShowSearchNoResults("missing", 0, 0), false);
});
