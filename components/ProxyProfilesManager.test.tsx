import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../application/i18n/I18nProvider.tsx";
import { isValidProxyPort } from "../domain/proxyProfiles.ts";
import { STORAGE_KEY_VAULT_PROXY_PROFILES_VIEW_MODE } from "../infrastructure/config/storageKeys.ts";
import type { Identity, ProxyProfile } from "../types.ts";
import {
  getProxyProfileCredentialIdentities,
  hasUnavailableProxyProfileDraftIdentity,
  ProxyProfilesManager,
  updateProxyProfileDraftConfig,
} from "./ProxyProfilesManager.tsx";

const proxyProfile: ProxyProfile = {
  id: "proxy-1",
  label: "Office Proxy",
  config: {
    type: "http",
    host: "127.0.0.1",
    port: 8080,
  },
  createdAt: 1,
};

const identity: Identity = {
  id: "identity-1",
  label: "Proxy Login",
  username: "proxy-user",
  authMethod: "password",
  password: "proxy-secret",
  created: 1,
};

const keyOnlyIdentity: Identity = {
  id: "identity-key-only",
  label: "Key Only",
  username: "key-user",
  authMethod: "key",
  created: 1,
};

const installStorageStub = (viewMode: string | null = null) => {
  const values = new Map<string, string>();
  if (viewMode) {
    values.set(STORAGE_KEY_VAULT_PROXY_PROFILES_VIEW_MODE, viewMode);
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

const renderManager = (
  viewMode: string | null = null,
  profiles: ProxyProfile[] = [proxyProfile],
) => {
  installStorageStub(viewMode);
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(ProxyProfilesManager, {
        proxyProfiles: profiles,
        hosts: [],
        groupConfigs: [],
        onUpdateProxyProfiles: () => {},
        onUpdateHosts: () => {},
        onUpdateGroupConfigs: () => {},
      }),
    ),
  );
};

test("ProxyProfilesManager uses the shared Vault grid card style by default", () => {
  const markup = renderManager();

  assert.match(markup, /Add Proxy/);
  assert.match(markup, /aria-label="Search proxies…"/);
  assert.match(markup, /aria-label="Office Proxy, HTTP, 127\.0\.0\.1:8080, 0 linked"/);
  assert.match(markup, /Office Proxy/);
  assert.match(markup, /127\.0\.0\.1:8080/);
});

test("ProxyProfilesManager uses the shared Vault list row style when persisted", () => {
  const markup = renderManager("list");

  assert.match(markup, /aria-label="Office Proxy, HTTP, 127\.0\.0\.1:8080, 0 linked"/);
  assert.match(markup, /Office Proxy/);
  assert.match(markup, /127\.0\.0\.1:8080/);
});

test("ProxyProfilesManager validates proxy ports", () => {
  assert.equal(isValidProxyPort(1), true);
  assert.equal(isValidProxyPort(65535), true);
  assert.equal(isValidProxyPort(0), false);
  assert.equal(isValidProxyPort(65536), false);
  assert.equal(isValidProxyPort(10.5), false);
});

test("ProxyProfilesManager hides ProxyCommand contents in profile summaries", () => {
  const markup = renderManager(null, [
    {
      id: "proxy-command-1",
      label: "Cloudflare Access",
      config: {
        type: "command",
        host: "",
        port: 0,
        command: "cloudflared access ssh --hostname %h --token secret",
      },
      createdAt: 1,
    },
  ]);

  assert.match(markup, /aria-label="Cloudflare Access, ProxyCommand, ProxyCommand, 0 linked"/);
  assert.match(markup, /Cloudflare Access/);
  assert.match(markup, /ProxyCommand/);
  assert.doesNotMatch(markup, /cloudflared access ssh/);
  assert.doesNotMatch(markup, /secret/);
});

test("ProxyProfilesManager only offers keychain identities with saved passwords", () => {
  assert.deepEqual(getProxyProfileCredentialIdentities([identity, keyOnlyIdentity]), [identity]);
});

test("ProxyProfilesManager clears manual proxy credentials when selecting a keychain identity", () => {
  const config = updateProxyProfileDraftConfig(
    {
      type: "http",
      host: "proxy.example.com",
      port: 3128,
      username: "manual-user",
      password: "manual-secret",
    },
    "identityId",
    identity.id,
  );

  assert.equal(config.identityId, identity.id);
  assert.equal(config.username, undefined);
  assert.equal(config.password, undefined);
});

test("ProxyProfilesManager clears a selected keychain identity when manual credentials are entered", () => {
  const config = updateProxyProfileDraftConfig(
    {
      type: "http",
      host: "proxy.example.com",
      port: 3128,
      identityId: identity.id,
    },
    "username",
    "manual-user",
  );

  assert.equal(config.identityId, undefined);
  assert.equal(config.username, "manual-user");
});

test("ProxyProfilesManager blocks saving proxy profiles with stale keychain identities", () => {
  assert.equal(
    hasUnavailableProxyProfileDraftIdentity({
      ...proxyProfile,
      config: {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: keyOnlyIdentity.id,
      },
    }, [keyOnlyIdentity]),
    true,
  );
  assert.equal(
    hasUnavailableProxyProfileDraftIdentity({
      ...proxyProfile,
      config: {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: identity.id,
      },
    }, [identity]),
    false,
  );
});
