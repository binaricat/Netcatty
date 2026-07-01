import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../application/i18n/I18nProvider.tsx";
import type { Identity, ProxyProfile } from "../types.ts";
import { ProxyPanel } from "./host-details/ProxyPanel.tsx";

const proxyProfile: ProxyProfile = {
  id: "proxy-1",
  label: "Office Proxy",
  config: {
    type: "socks5",
    host: "office-proxy.example.com",
    port: 1080,
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

const renderPanel = (props: Partial<React.ComponentProps<typeof ProxyPanel>> = {}) =>
  renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(ProxyPanel, {
        proxyConfig: undefined,
        proxyProfiles: [],
        identities: [],
        selectedProxyProfileId: undefined,
        onUpdateProxy: () => {},
        onSelectProxyProfile: () => {},
        onClearProxy: () => {},
        onBack: () => {},
        onCancel: () => {},
        layout: "inline",
        ...props,
      }),
    ),
  );

test("ProxyPanel shows saved proxy selection when reusable profiles exist", () => {
  const markup = renderPanel({
    proxyProfiles: [proxyProfile],
    selectedProxyProfileId: proxyProfile.id,
  });

  assert.match(markup, /Saved proxy/);
  assert.match(markup, /office-proxy\.example\.com:1080/);
  assert.doesNotMatch(markup, /Proxy host/);
});

test("ProxyPanel labels saved ProxyCommand profiles without showing command contents", () => {
  const commandProxy: ProxyProfile = {
    id: "proxy-command-1",
    label: "Cloudflare Access",
    config: {
      type: "command",
      host: "",
      port: 0,
      command: "cloudflared access ssh --hostname %h --token secret",
    },
    createdAt: 1,
  };
  const markup = renderPanel({
    proxyProfiles: [commandProxy],
    selectedProxyProfileId: commandProxy.id,
  });

  assert.match(markup, /ProxyCommand/);
  assert.doesNotMatch(markup, /COMMAND/);
  assert.doesNotMatch(markup, /cloudflared access ssh/);
  assert.doesNotMatch(markup, /secret/);
});

test("ProxyPanel keeps manual proxy fields available without a saved profile selection", () => {
  const markup = renderPanel({
    proxyProfiles: [proxyProfile],
    proxyConfig: { type: "http", host: "manual-proxy.example.com", port: 3128 },
  });

  assert.match(markup, /Saved proxy/);
  assert.match(markup, /Proxy host/);
  assert.match(markup, /manual-proxy\.example\.com/);
});

test("ProxyPanel shows a clear missing state for stale saved proxy selections", () => {
  const markup = renderPanel({
    proxyProfiles: [proxyProfile],
    selectedProxyProfileId: "missing-proxy",
  });

  assert.match(markup, /Missing saved proxy/);
  assert.match(markup, /Proxy host/);
});

test("ProxyPanel disables saving invalid manual proxy ports", () => {
  const markup = renderPanel({
    proxyConfig: { type: "http", host: "manual-proxy.example.com", port: 65536 },
  });

  assert.match(markup, /Port must be between 1 and 65535/);
  assert.match(markup, /disabled=""/);
});

test("ProxyPanel shows a clear missing state for stale proxy identities", () => {
  const markup = renderPanel({
    proxyConfig: {
      type: "http",
      host: "manual-proxy.example.com",
      port: 3128,
      identityId: "missing-identity",
    },
    identities: [proxyIdentity],
  });

  assert.match(markup, /Missing keychain identity/);
  assert.match(markup, /Username/);
  assert.match(markup, /disabled=""/);
});

test("ProxyPanel warns when a saved proxy profile has a stale identity", () => {
  const markup = renderPanel({
    proxyProfiles: [{
      ...proxyProfile,
      config: {
        type: "http",
        host: "office-proxy.example.com",
        port: 8080,
        identityId: "missing-identity",
      },
    }],
    selectedProxyProfileId: proxyProfile.id,
    identities: [proxyIdentity],
  });

  assert.match(markup, /Missing keychain identity/);
  assert.match(markup, /disabled=""/);
});

test("ProxyPanel warns when a saved proxy profile has an incomplete identity", () => {
  const markup = renderPanel({
    proxyProfiles: [{
      ...proxyProfile,
      config: {
        type: "http",
        host: "office-proxy.example.com",
        port: 8080,
        identityId: proxyIdentity.id,
      },
    }],
    selectedProxyProfileId: proxyProfile.id,
    identities: [{ ...proxyIdentity, password: undefined }],
  });

  assert.match(markup, /Proxy identity needs a username and password/);
  assert.match(markup, /disabled=""/);
});

test("ProxyPanel warns when a saved proxy profile has an unreadable identity password", () => {
  const markup = renderPanel({
    proxyProfiles: [{
      ...proxyProfile,
      config: {
        type: "http",
        host: "office-proxy.example.com",
        port: 8080,
        identityId: proxyIdentity.id,
      },
    }],
    selectedProxyProfileId: proxyProfile.id,
    identities: [{ ...proxyIdentity, password: "enc:v1:djEwAAAA" }],
  });

  assert.match(markup, /Proxy identity password cannot be read/);
  assert.match(markup, /disabled=""/);
});

test("ProxyPanel supports custom ProxyCommand settings", () => {
  const markup = renderPanel({
    proxyConfig: {
      type: "command",
      host: "",
      port: 0,
      command: "cloudflared access ssh --hostname %h",
    },
  });

  assert.match(markup, /Command/);
  assert.match(markup, /cloudflared access ssh --hostname %h/);
  assert.match(markup, /Use %h for the target host/);
  assert.doesNotMatch(markup, /Proxy host/);
  assert.doesNotMatch(markup, /Credentials/);
});

test("ProxyPanel uses a dropdown for proxy type selection", () => {
  const markup = renderPanel({
    proxyConfig: { type: "http", host: "manual-proxy.example.com", port: 3128 },
  });

  assert.match(markup, /role="combobox"/);
  assert.match(markup, /aria-label="Type"/);
});

test("ProxyPanel offers keychain identities for HTTP and SOCKS5 proxy credentials", () => {
  const markup = renderPanel({
    proxyConfig: {
      type: "socks5",
      host: "manual-proxy.example.com",
      port: 1080,
      identityId: proxyIdentity.id,
    },
    identities: [proxyIdentity],
  });

  assert.match(markup, /Keychain identity/);
  assert.match(markup, /Proxy login/);
  assert.match(markup, /proxy-user/);
});
