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
