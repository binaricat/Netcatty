import test from "node:test";
import assert from "node:assert/strict";
import { applyGroupDefaults, resolveGroupDefaults, sanitizeGroupConfig } from "./groupConfig.ts";
import { resolveTelnetPassword, resolveTelnetUsername } from "./host.ts";
import type { GroupConfig, Host } from "./models.ts";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  username: "root",
  tags: [],
  os: "linux",
  ...overrides,
});

test("applyGroupDefaults lets a host proxy profile override a group custom proxy", () => {
  const groupDefaults: Partial<GroupConfig> = {
    proxyConfig: { type: "http", host: "group-proxy.example.com", port: 3128 },
  };

  const result = applyGroupDefaults(host({ proxyProfileId: "proxy-1" }), groupDefaults);

  assert.equal(result.proxyProfileId, "proxy-1");
  assert.equal(result.proxyConfig, undefined);
});

test("applyGroupDefaults lets a host custom proxy override a group proxy profile", () => {
  const groupDefaults: Partial<GroupConfig> = {
    proxyProfileId: "group-proxy",
  };
  const customProxy = { type: "socks5" as const, host: "host-proxy.example.com", port: 1080 };

  const result = applyGroupDefaults(host({ proxyConfig: customProxy }), groupDefaults);

  assert.equal(result.proxyProfileId, undefined);
  assert.deepEqual(result.proxyConfig, customProxy);
});

test("applyGroupDefaults inherits group device type when host does not set one", () => {
  const result = applyGroupDefaults(host(), { deviceType: "network" });

  assert.equal(result.deviceType, "network");
});

test("applyGroupDefaults lets host device type override group device type", () => {
  const result = applyGroupDefaults(host({ deviceType: "general" }), { deviceType: "network" });

  assert.equal(result.deviceType, "general");
});

test("applyGroupDefaults inherits startup command run mode", () => {
  const result = applyGroupDefaults(host(), { startupCommandRunMode: "paste" });

  assert.equal(result.startupCommandRunMode, "paste");
});

test("resolveGroupDefaults lets child group device type override parent device type", () => {
  const resolved = resolveGroupDefaults("prod/access", [
    {
      path: "prod",
      deviceType: "network",
    },
    {
      path: "prod/access",
      deviceType: "general",
    },
  ]);

  assert.equal(resolved.deviceType, "general");
});

test("resolveGroupDefaults treats saved and custom proxies as one inherited setting", () => {
  const resolved = resolveGroupDefaults("prod/api", [
    {
      path: "prod",
      proxyConfig: { type: "http", host: "parent-proxy.example.com", port: 3128 },
    },
    {
      path: "prod/api",
      proxyProfileId: "child-proxy",
    },
  ]);

  assert.equal(resolved.proxyProfileId, "child-proxy");
  assert.equal(resolved.proxyConfig, undefined);
});

test("applyGroupDefaults keeps a missing host proxy profile instead of using group proxy", () => {
  const groupDefaults: Partial<GroupConfig> = {
    proxyProfileId: "group-proxy",
  };

  const result = applyGroupDefaults(
    host({ proxyProfileId: "missing-proxy" }),
    groupDefaults,
    { validProxyProfileIds: new Set(["group-proxy"]) },
  );

  assert.equal(result.proxyProfileId, "missing-proxy");
  assert.equal(result.proxyConfig, undefined);
});

test("applyGroupDefaults keeps a missing host proxy profile when no group fallback exists", () => {
  const result = applyGroupDefaults(
    host({ proxyProfileId: "missing-proxy" }),
    {},
    { validProxyProfileIds: new Set(["group-proxy"]) },
  );

  assert.equal(result.proxyProfileId, "missing-proxy");
  assert.equal(result.proxyConfig, undefined);
});

test("applyGroupDefaults keeps a missing host proxy profile instead of using group custom proxy", () => {
  const groupProxy = { type: "http" as const, host: "group-proxy.example.com", port: 3128 };
  const result = applyGroupDefaults(
    host({ proxyProfileId: "missing-proxy" }),
    { proxyConfig: groupProxy },
    { validProxyProfileIds: new Set(["group-proxy"]) },
  );

  assert.equal(result.proxyProfileId, "missing-proxy");
  assert.equal(result.proxyConfig, undefined);
});

test("resolveGroupDefaults keeps a missing group proxy marker when there is no fallback", () => {
  const resolved = resolveGroupDefaults(
    "prod",
    [{ path: "prod", proxyProfileId: "missing-proxy" }],
    { validProxyProfileIds: new Set(["group-proxy"]) },
  );

  assert.equal(resolved.proxyProfileId, "missing-proxy");
});

test("applyGroupDefaults inherits a missing group proxy marker so connect paths can fail", () => {
  const result = applyGroupDefaults(
    host({ group: "prod" }),
    { proxyProfileId: "missing-proxy" },
    { validProxyProfileIds: new Set(["group-proxy"]) },
  );

  assert.equal(result.proxyProfileId, "missing-proxy");
  assert.equal(result.proxyConfig, undefined);
});

test("resolveGroupDefaults keeps missing child proxy profiles instead of using parent proxy", () => {
  const resolved = resolveGroupDefaults(
    "prod/api",
    [
      {
        path: "prod",
        proxyConfig: { type: "http", host: "parent-proxy.example.com", port: 3128 },
      },
      {
        path: "prod/api",
        proxyProfileId: "missing-proxy",
      },
    ],
    { validProxyProfileIds: new Set(["group-proxy"]) },
  );

  assert.equal(resolved.proxyProfileId, "missing-proxy");
  assert.equal(resolved.proxyConfig, undefined);
});

test("applyGroupDefaults preserves explicitly cleared telnet credentials", () => {
  const result = applyGroupDefaults(
    host({
      username: "ssh-user",
      password: "ssh-password",
      telnetUsername: "",
      telnetPassword: "",
    }),
    {
      telnetUsername: "group-telnet-user",
      telnetPassword: "group-telnet-password",
    },
  );

  assert.equal(result.telnetUsername, "");
  assert.equal(result.telnetPassword, "");
  assert.equal(resolveTelnetUsername(result), "");
  assert.equal(resolveTelnetPassword(result), "");
});

test("applyGroupDefaults still inherits telnet credentials when host fields are unset", () => {
  const result = applyGroupDefaults(
    host({
      username: "ssh-user",
      password: "ssh-password",
    }),
    {
      telnetUsername: "group-telnet-user",
      telnetPassword: "group-telnet-password",
    },
  );

  assert.equal(result.telnetUsername, "group-telnet-user");
  assert.equal(result.telnetPassword, "group-telnet-password");
  assert.equal(resolveTelnetUsername(result), "group-telnet-user");
  assert.equal(resolveTelnetPassword(result), "group-telnet-password");
});

test("applyGroupDefaults inherits a reusable Telnet identity from the group", () => {
  const result = applyGroupDefaults(
    host({ telnetIdentityId: undefined }),
    { telnetIdentityId: "group-telnet-identity" },
  );

  assert.equal(result.telnetIdentityId, "group-telnet-identity");
});

test("applyGroupDefaults preserves an explicitly cleared Telnet identity", () => {
  const result = applyGroupDefaults(
    host({ telnetIdentityId: "" }),
    { telnetIdentityId: "group-telnet-identity" },
  );

  assert.equal(result.telnetIdentityId, "");
});

test("resolveGroupDefaults lets child manual SSH credentials replace a parent identity", () => {
  const resolved = resolveGroupDefaults("prod/manual", [
    { path: "prod", identityId: "parent-identity", username: "parent-user" },
    { path: "prod/manual", username: "child-user", password: "child-password" },
  ]);

  assert.equal(resolved.identityId, undefined);
  assert.equal(resolved.username, "child-user");
  assert.equal(resolved.password, "child-password");
});

test("resolveGroupDefaults lets child manual Telnet credentials replace a parent identity", () => {
  const resolved = resolveGroupDefaults("prod/manual", [
    { path: "prod", telnetIdentityId: "parent-identity" },
    { path: "prod/manual", telnetUsername: "child-user", telnetPassword: "child-password" },
  ]);

  assert.equal(resolved.telnetIdentityId, undefined);
  assert.equal(resolved.telnetUsername, "child-user");
  assert.equal(resolved.telnetPassword, "child-password");
});

test("resolveGroupDefaults clears a parent key identity bundle for a child password opt-out", () => {
  const resolved = resolveGroupDefaults("prod/manual", [
    {
      path: "prod",
      identityId: "parent-identity",
      username: "parent-user",
      authMethod: "key",
      identityFileId: "parent-key",
    },
    {
      path: "prod/manual",
      identityId: "",
      username: "child-user",
      password: "child-password",
      authMethod: "password",
    },
  ]);

  assert.equal(resolved.identityId, "");
  assert.equal(resolved.username, "child-user");
  assert.equal(resolved.password, "child-password");
  assert.equal(resolved.authMethod, "password");
  assert.equal(resolved.identityFileId, undefined);
});

test("resolveGroupDefaults clears parent identity credentials for an empty child marker", () => {
  const resolved = resolveGroupDefaults("prod/manual", [
    {
      path: "prod",
      identityId: "parent-identity",
      username: "parent-user",
      authMethod: "key",
      telnetIdentityId: "parent-telnet-identity",
      telnetUsername: "parent-telnet-user",
    },
    {
      path: "prod/manual",
      identityId: "",
      telnetIdentityId: "",
    },
  ]);

  assert.equal(resolved.identityId, "");
  assert.equal(resolved.username, undefined);
  assert.equal(resolved.authMethod, undefined);
  assert.equal(resolved.telnetIdentityId, "");
  assert.equal(resolved.telnetUsername, undefined);
});

test("applyGroupDefaults keeps host manual SSH credentials instead of a group identity", () => {
  const result = applyGroupDefaults(
    host({ username: "host-user", password: "host-password" }),
    {
      identityId: "group-identity",
      username: "group-user",
      password: "group-password",
      savePassword: false,
      authMethod: "key",
      identityFileId: "group-key",
      identityFilePaths: ["~/.ssh/group-key"],
    },
  );

  assert.equal(result.identityId, undefined);
  assert.equal(result.username, "host-user");
  assert.equal(result.password, "host-password");
  assert.equal(result.savePassword, undefined);
  assert.equal(result.authMethod, undefined);
  assert.equal(result.identityFileId, undefined);
  assert.equal(result.identityFilePaths, undefined);
});

test("applyGroupDefaults lets a host password inherit a manual group username", () => {
  const result = applyGroupDefaults(
    host({ username: "", password: "host-password" }),
    { username: "group-user" },
  );

  assert.equal(result.identityId, undefined);
  assert.equal(result.username, "group-user");
  assert.equal(result.password, "host-password");
});

test("applyGroupDefaults lets an empty host identity inherit manual group credentials", () => {
  const result = applyGroupDefaults(
    host({ identityId: "", username: "", authMethod: undefined }),
    {
      username: "group-user",
      password: "group-password",
      authMethod: "password",
    },
  );

  assert.equal(result.identityId, "");
  assert.equal(result.username, "group-user");
  assert.equal(result.password, "group-password");
  assert.equal(result.authMethod, "password");
});

test("applyGroupDefaults does not bypass a host no-save choice with a group identity", () => {
  const result = applyGroupDefaults(
    host({ username: "", password: undefined, savePassword: false }),
    {
      identityId: "group-identity",
      username: "group-user",
      password: "group-password",
      authMethod: "password",
    },
  );

  assert.equal(result.identityId, undefined);
  assert.equal(result.username, "");
  assert.equal(result.password, undefined);
  assert.equal(result.savePassword, false);
  assert.equal(result.authMethod, undefined);
});

test("applyGroupDefaults keeps host manual Telnet credentials instead of a group identity", () => {
  const result = applyGroupDefaults(
    host({ telnetUsername: "host-user", telnetPassword: "host-password" }),
    { telnetIdentityId: "group-identity" },
  );

  assert.equal(result.telnetIdentityId, undefined);
  assert.equal(result.telnetUsername, "host-user");
  assert.equal(result.telnetPassword, "host-password");
});

test("applyGroupDefaults preserves imported primary Telnet credentials", () => {
  const result = applyGroupDefaults(
    host({
      protocol: "telnet",
      username: "operator",
      password: "host-password",
      telnetIdentityId: undefined,
    }),
    { telnetIdentityId: "group-telnet-identity" },
  );

  assert.equal(result.telnetIdentityId, undefined);
  assert.equal(resolveTelnetUsername(result), "operator");
  assert.equal(resolveTelnetPassword(result), "host-password");
});

test("applyGroupDefaults lets a default primary Telnet host inherit a group identity", () => {
  const result = applyGroupDefaults(
    host({
      protocol: "telnet",
      username: "root",
      password: undefined,
      telnetIdentityId: undefined,
    }),
    { telnetIdentityId: "group-telnet-identity" },
  );

  assert.equal(result.telnetIdentityId, "group-telnet-identity");
});

test("applyGroupDefaults preserves explicit empty identityId instead of inheriting group identity", () => {
  const result = applyGroupDefaults(
    host({ identityId: "" }),
    { identityId: "group-identity" },
  );

  assert.equal(result.identityId, "");
});

test("applyGroupDefaults inherits group identityId when host only has default SSH fields", () => {
  const result = applyGroupDefaults(
    host({ identityId: undefined, authMethod: "password" }),
    { identityId: "group-identity" },
  );

  assert.equal(result.identityId, "group-identity");
  assert.equal(result.username, "root");
});

test("applyGroupDefaults preserves a custom username instead of inheriting a group identity", () => {
  const result = applyGroupDefaults(
    host({ identityId: undefined, username: "ubuntu", authMethod: "password" }),
    {
      identityId: "group-identity",
      username: "group-user",
      password: "group-password",
      authMethod: "password",
    },
  );

  assert.equal(result.identityId, undefined);
  assert.equal(result.username, "ubuntu");
  assert.equal(result.password, undefined);
  assert.equal(result.authMethod, "password");
});

test("applyGroupDefaults treats an explicit empty identity as a host opt-out", () => {
  const result = applyGroupDefaults(
    host({ identityId: "", username: "host-user", authMethod: "password" }),
    { identityId: "group-identity", username: "group-user" },
  );

  assert.equal(result.identityId, "");
  assert.equal(result.username, "host-user");
});

test("applyGroupDefaults continues to inherit empty ssh username from the group", () => {
  const result = applyGroupDefaults(
    host({
      username: "",
    }),
    {
      username: "group-ssh-user",
    },
  );

  assert.equal(result.username, "group-ssh-user");
});

test("sanitizeGroupConfig migrates a deprecated fontFamily and clears the override flag", () => {
  // Regression guard for codex P2 review on PR #940: groups saved with
  // pingfang-sc / microsoft-yahei / comic-sans-ms must shed the
  // override so member hosts inherit the global default instead of
  // silently falling through to fonts[0] under an enabled override.
  const before: GroupConfig = {
    path: "team",
    fontFamily: "pingfang-sc",
    fontFamilyOverride: true,
  };
  const after = sanitizeGroupConfig(before);
  assert.equal(after.fontFamily, undefined);
  assert.equal(after.fontFamilyOverride, false);
});

test("sanitizeGroupConfig keeps a still-valid fontFamily untouched", () => {
  const before: GroupConfig = {
    path: "team",
    fontFamily: "jetbrains-mono",
    fontFamilyOverride: true,
  };
  const after = sanitizeGroupConfig(before);
  assert.equal(after.fontFamily, "jetbrains-mono");
  assert.equal(after.fontFamilyOverride, true);
});

test("applyGroupDefaults inherits skipEcdsaHostKey from the group when host has no value", () => {
  const result = applyGroupDefaults(host(), { skipEcdsaHostKey: true });
  assert.equal(result.skipEcdsaHostKey, true);
});

test("applyGroupDefaults keeps host-level skipEcdsaHostKey instead of group default", () => {
  const result = applyGroupDefaults(
    host({ skipEcdsaHostKey: false }),
    { skipEcdsaHostKey: true },
  );
  assert.equal(result.skipEcdsaHostKey, false);
});

test("applyGroupDefaults inherits algorithm overrides from the group", () => {
  const overrides = { serverHostKey: ["ssh-rsa", "ssh-dss"] };
  const result = applyGroupDefaults(host(), { algorithms: overrides });
  assert.deepEqual(result.algorithms, overrides);
});

test("applyGroupDefaults keeps host algorithm overrides instead of inheriting", () => {
  const hostOverrides = { kex: ["curve25519-sha256"] };
  const groupOverrides = { kex: ["diffie-hellman-group14-sha256"] };
  const result = applyGroupDefaults(
    host({ algorithms: hostOverrides }),
    { algorithms: groupOverrides },
  );
  assert.deepEqual(result.algorithms, hostOverrides);
});
