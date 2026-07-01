import test from "node:test";
import assert from "node:assert/strict";

import type { Host, Identity, ProxyProfile } from "./models.ts";
import {
  formatProxyConfigEndpoint,
  formatProxyConfigType,
  findIncompleteProxyIdentityId,
  isCompleteProxyConfig,
  normalizeManualProxyConfig,
  materializeHostProxyProfile,
  findMissingProxyIdentityId,
  removeProxyProfileReferences,
  resolveProxyConfigAuth,
  updateProxyConfigField,
} from "./proxyProfiles.ts";

const profile = (overrides: Partial<ProxyProfile> = {}): ProxyProfile => ({
  id: "proxy-1",
  label: "Office Proxy",
  config: {
    type: "socks5",
    host: "proxy.example.com",
    port: 1080,
    username: "alice",
    password: "secret",
  },
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Server",
  hostname: "server.example.com",
  username: "root",
  os: "linux",
  tags: [],
  protocol: "ssh",
  ...overrides,
});

test("materializeHostProxyProfile resolves a selected proxy profile", () => {
  const resolved = materializeHostProxyProfile(
    host({ proxyProfileId: "proxy-1" }),
    [profile()],
  );

  assert.deepEqual(resolved.proxyConfig, profile().config);
});

test("materializeHostProxyProfile keeps explicit custom proxy ahead of profile reference", () => {
  const customProxy = {
    type: "http" as const,
    host: "custom.example.com",
    port: 3128,
  };

  const resolved = materializeHostProxyProfile(
    host({ proxyProfileId: "proxy-1", proxyConfig: customProxy }),
    [profile()],
  );

  assert.deepEqual(resolved.proxyConfig, customProxy);
});

test("removeProxyProfileReferences clears hosts and group configs that use a deleted profile", () => {
  const result = removeProxyProfileReferences("proxy-1", {
    hosts: [
      host({ id: "host-1", proxyProfileId: "proxy-1" }),
      host({ id: "host-2", proxyProfileId: "proxy-2" }),
    ],
    groupConfigs: [
      { path: "prod", proxyProfileId: "proxy-1" },
      { path: "dev", proxyProfileId: "proxy-2" },
    ],
  });

  assert.equal(result.hosts[0].proxyProfileId, undefined);
  assert.equal(result.hosts[1].proxyProfileId, "proxy-2");
  assert.equal(result.groupConfigs[0].proxyProfileId, undefined);
  assert.equal(result.groupConfigs[1].proxyProfileId, "proxy-2");
});

test("normalizeManualProxyConfig clears empty proxy drafts", () => {
  assert.equal(
    normalizeManualProxyConfig({ type: "http", host: "", port: 8080 }),
    undefined,
  );
});

test("normalizeManualProxyConfig trims command proxy drafts", () => {
  assert.deepEqual(
    normalizeManualProxyConfig({
      type: "command",
      host: "ignored.example.com",
      port: 8080,
      command: "  cloudflared access ssh --hostname %h  ",
      username: "ignored",
      password: "ignored",
    }),
    {
      type: "command",
      host: "",
      port: 0,
      command: "cloudflared access ssh --hostname %h",
    },
  );
});

test("normalizeManualProxyConfig strips stale command data from direct proxy configs", () => {
  assert.deepEqual(
    normalizeManualProxyConfig({
      type: "http",
      host: " proxy.example.com ",
      port: "3128" as never,
      command: "cloudflared access ssh --hostname %h --token secret",
      username: " proxy-user ",
      password: "proxy-secret",
    }),
    {
      type: "http",
      host: "proxy.example.com",
      port: 3128,
      username: "proxy-user",
      password: "proxy-secret",
    },
  );
});

test("normalizeManualProxyConfig keeps identity proxy auth without stale manual credentials", () => {
  assert.deepEqual(
    normalizeManualProxyConfig({
      type: "socks5",
      host: "proxy.example.com",
      port: 1080,
      identityId: "identity-1",
      username: "stale-user",
      password: "stale-secret",
    }),
    {
      type: "socks5",
      host: "proxy.example.com",
      port: 1080,
      identityId: "identity-1",
    },
  );
});

test("updateProxyConfigField clears conflicting proxy credential fields", () => {
  assert.deepEqual(
    updateProxyConfigField(
      {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        username: "manual-user",
        password: "manual-secret",
      },
      "identityId",
      "identity-1",
    ),
    {
      type: "http",
      host: "proxy.example.com",
      port: 3128,
      identityId: "identity-1",
    },
  );

  assert.deepEqual(
    updateProxyConfigField(
      {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "identity-1",
      },
      "username",
      "manual-user",
    ),
    {
      type: "http",
      host: "proxy.example.com",
      port: 3128,
      username: "manual-user",
    },
  );
});

test("updateProxyConfigField clears stale command when switching back to direct proxy types", () => {
  assert.deepEqual(
    updateProxyConfigField(
      {
        type: "command",
        host: "",
        port: 0,
        command: "cloudflared access ssh --hostname %h --token secret",
      },
      "type",
      "http",
    ),
    {
      type: "http",
      host: "",
      port: 0,
    },
  );
});

test("isCompleteProxyConfig requires host and a valid port", () => {
  assert.equal(isCompleteProxyConfig({ type: "http", host: "", port: 8080 }), false);
  assert.equal(isCompleteProxyConfig({ type: "http", host: "proxy.example.com", port: 0 }), false);
  assert.equal(isCompleteProxyConfig({ type: "http", host: "proxy.example.com", port: 3128 }), true);
});

test("isCompleteProxyConfig accepts a non-empty command proxy", () => {
  assert.equal(isCompleteProxyConfig({ type: "command", host: "", port: 0, command: "" }), false);
  assert.equal(
    isCompleteProxyConfig({
      type: "command",
      host: "",
      port: 0,
      command: "cloudflared access ssh --hostname %h",
    }),
    true,
  );
});

test("formatProxyConfigEndpoint hides command proxy contents in summaries", () => {
  assert.equal(
    formatProxyConfigEndpoint({
      type: "command",
      host: "",
      port: 0,
      command: "cloudflared access ssh --hostname %h --token secret",
    }),
    "ProxyCommand",
  );
});

test("formatProxyConfigType labels command proxies without uppercasing", () => {
  assert.equal(formatProxyConfigType({ type: "http", host: "proxy.example.com", port: 3128 }), "HTTP");
  assert.equal(
    formatProxyConfigType({
      type: "command",
      host: "",
      port: 0,
      command: "cloudflared access ssh --hostname %h",
    }),
    "ProxyCommand",
  );
});

test("resolveProxyConfigAuth uses a selected identity for proxy credentials", () => {
  const identities: Identity[] = [{
    id: "identity-1",
    label: "Proxy login",
    username: "proxy-user",
    authMethod: "password",
    password: "proxy-secret",
    created: 1,
  }];

  assert.deepEqual(
    resolveProxyConfigAuth(
      {
        type: "socks5",
        host: "proxy.example.com",
        port: 1080,
        identityId: "identity-1",
      },
      identities,
    ),
    {
      type: "socks5",
      host: "proxy.example.com",
      port: 1080,
      username: "proxy-user",
      password: "proxy-secret",
    },
  );
});

test("findMissingProxyIdentityId reports stale proxy identity references", () => {
  assert.equal(
    findMissingProxyIdentityId(
      {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "missing-identity",
      },
      [],
    ),
    "missing-identity",
  );
});

test("findIncompleteProxyIdentityId reports proxy identities without username or password", () => {
  assert.equal(
    findIncompleteProxyIdentityId(
      {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "identity-1",
      },
      [{
        id: "identity-1",
        label: "Proxy login",
        username: "proxy-user",
        authMethod: "password",
        created: 1,
      }],
    ),
    "identity-1",
  );
  assert.equal(
    findIncompleteProxyIdentityId(
      {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "identity-1",
      },
      [{
        id: "identity-1",
        label: "Proxy login",
        username: "proxy-user",
        authMethod: "password",
        password: "proxy-secret",
        created: 1,
      }],
    ),
    undefined,
  );
});

test("findIncompleteProxyIdentityId treats blank usernames as incomplete even with encrypted passwords", () => {
  assert.equal(
    findIncompleteProxyIdentityId(
      {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "identity-1",
      },
      [{
        id: "identity-1",
        label: "Proxy login",
        username: " ",
        authMethod: "password",
        password: "enc:v1:djEwAAAA",
        created: 1,
      }],
    ),
    "identity-1",
  );
});

test("resolveProxyConfigAuth keeps manual proxy credentials without an identity", () => {
  assert.deepEqual(
    resolveProxyConfigAuth(
      {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        username: "manual-user",
        password: "manual-secret",
      },
      [],
    ),
    {
      type: "http",
      host: "proxy.example.com",
      port: 3128,
      username: "manual-user",
      password: "manual-secret",
    },
  );
});
