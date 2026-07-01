import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../application/i18n/I18nProvider.tsx";
import { isValidProxyPort } from "../domain/proxyProfiles.ts";
import { STORAGE_KEY_VAULT_PROXY_PROFILES_VIEW_MODE } from "../infrastructure/config/storageKeys.ts";
import type { Identity, ProxyProfile } from "../types.ts";
import { prepareProxyProfileForSave, ProxyProfilesManager } from "./ProxyProfilesManager.tsx";

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

const proxyIdentity: Identity = {
  id: "identity-1",
  label: "Proxy login",
  username: "proxy-user",
  authMethod: "password",
  password: "proxy-secret",
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
        identities: [proxyIdentity],
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

test("prepareProxyProfileForSave saves identity auth without stale manual credentials", () => {
  const result = prepareProxyProfileForSave(
    {
      ...proxyProfile,
      label: " Office Proxy ",
      config: {
        type: "http",
        host: " proxy.example.com ",
        port: 3128,
        identityId: proxyIdentity.id,
        username: "stale-user",
        password: "stale-secret",
      },
    },
    [proxyIdentity],
    2,
  );

  assert.deepEqual(result.saved?.config, {
    type: "http",
    host: "proxy.example.com",
    port: 3128,
    identityId: proxyIdentity.id,
  });
  assert.equal(result.saved?.label, "Office Proxy");
  assert.equal(result.saved?.updatedAt, 2);
});

test("prepareProxyProfileForSave rejects missing and incomplete proxy identities", () => {
  assert.equal(
    prepareProxyProfileForSave(
      {
        ...proxyProfile,
        config: {
          type: "http",
          host: "proxy.example.com",
          port: 3128,
          identityId: "missing-identity",
        },
      },
      [proxyIdentity],
    ).error,
    "missingIdentity",
  );

  assert.equal(
    prepareProxyProfileForSave(
      {
        ...proxyProfile,
        config: {
          type: "http",
          host: "proxy.example.com",
          port: 3128,
          identityId: proxyIdentity.id,
        },
      },
      [{ ...proxyIdentity, password: undefined }],
    ).error,
    "incompleteIdentity",
  );
});

test("prepareProxyProfileForSave rejects unreadable proxy identity passwords", () => {
  assert.equal(
    prepareProxyProfileForSave(
      {
        ...proxyProfile,
        config: {
          type: "http",
          host: "proxy.example.com",
          port: 3128,
          identityId: proxyIdentity.id,
        },
      },
      [{ ...proxyIdentity, password: "enc:v1:djEwAAAA" }],
    ).error,
    "unreadableIdentity",
  );
});

test("prepareProxyProfileForSave strips stale ProxyCommand data from HTTP/SOCKS profiles", () => {
  const result = prepareProxyProfileForSave(
    {
      ...proxyProfile,
      config: {
        type: "socks5",
        host: "proxy.example.com",
        port: 1080,
        command: "cloudflared access ssh --hostname %h --token secret",
        username: "proxy-user",
        password: "proxy-secret",
      },
    },
    [],
  );

  assert.deepEqual(result.saved?.config, {
    type: "socks5",
    host: "proxy.example.com",
    port: 1080,
    username: "proxy-user",
    password: "proxy-secret",
  });
});
