import test from "node:test";
import assert from "node:assert/strict";
import { applyGroupDefaults, resolveGroupDefaults, sanitizeGroupConfig } from "./groupConfig.ts";
import {
  getActiveGlobalDefaultProxyProfileId,
  publishActiveGlobalDefaultProxyProfileId,
} from "./globalDefaultProxy.ts";
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

test("applyGroupDefaults ignores a legacy single-channel group flag", () => {
  const result = applyGroupDefaults(
    host(),
    { deviceType: "network", singleChannelSsh: true } as Partial<GroupConfig>,
  );

  assert.equal(result.deviceType, "network");
  assert.equal("singleChannelSsh" in result, false);
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

test("applyGroupDefaults preserves explicit DEL over group Ctrl-H after persistence", () => {
  const groupDefaults: Partial<GroupConfig> = { backspaceBehavior: "ctrl-h" };
  const saved: Host = JSON.parse(JSON.stringify(host({ backspaceBehavior: "default" })));
  assert.equal(applyGroupDefaults(saved, groupDefaults).backspaceBehavior, "default");
  assert.equal(applyGroupDefaults(host(), groupDefaults).backspaceBehavior, "ctrl-h");
});

test("applyGroupDefaults skips remote-only device type for local shell hosts", () => {
  const result = applyGroupDefaults(host({ protocol: "local" }), { deviceType: "network" });

  assert.equal(result.deviceType, undefined);
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

test("applyGroupDefaults does not inherit a group password after a host clears it", () => {
  const result = applyGroupDefaults(
    host({ username: "", password: undefined, savePassword: false }),
    {
      username: "group-user",
      password: "group-password",
      authMethod: "password",
    },
  );

  assert.equal(result.password, undefined);
  assert.equal(result.savePassword, false);
  assert.equal(result.authMethod, "password");
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

test("applyGroupDefaults keeps explicit host auth modes instead of inheriting a group identity", () => {
  for (const authMethod of ["auto", "password"] as const) {
    const result = applyGroupDefaults(
      host({ authMethod, authPolicyVersion: 1 }),
      { identityId: "group-identity" },
    );

    assert.equal(result.authMethod, authMethod);
    assert.equal(result.identityId, undefined);
  }
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

test("sanitizeGroupConfig drops a legacy single-channel SSH flag", () => {
  const source = {
    path: "team",
    username: "alice",
    singleChannelSsh: true,
  } as Parameters<typeof sanitizeGroupConfig>[0];
  const after = sanitizeGroupConfig(source);

  assert.equal("singleChannelSsh" in after, false);
  assert.equal(after.username, "alice");
  assert.equal("singleChannelSsh" in source, true);
});

test("sanitizeGroupConfig preserves legacy group passwords as password-only", () => {
  const after = sanitizeGroupConfig({
    path: "team",
    password: "group-secret",
  });

  assert.equal(after.authMethod, "password");
});

test("sanitizeGroupConfig preserves an explicit automatic password fallback", () => {
  const after = sanitizeGroupConfig({
    path: "team",
    authMethod: "auto",
    password: "group-secret",
  });

  assert.equal(after.authMethod, "auto");
});

test("sanitizeGroupConfig does not replace a selected identity with password-only", () => {
  const after = sanitizeGroupConfig({
    path: "team",
    identityId: "identity-1",
    password: "stale-secret",
  });

  assert.equal(after.authMethod, undefined);
});

test("sanitizeGroupConfig treats an empty inherited identity marker as cleared", () => {
  const after = sanitizeGroupConfig({
    path: "team/child",
    identityId: "",
    password: "child-secret",
  });

  assert.equal(after.identityId, "");
  assert.equal(after.authMethod, "password");
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

test("resolveGroupDefaults uses the nearest group X11 toggle and stays off otherwise", () => {
  const configs: GroupConfig[] = [
    { path: "prod", x11Forwarding: true },
    { path: "prod/edge", x11Forwarding: false },
  ];
  assert.equal(resolveGroupDefaults("prod", configs).x11Forwarding, true);
  assert.equal(resolveGroupDefaults("prod/web", configs).x11Forwarding, true);
  assert.equal(resolveGroupDefaults("prod/edge", configs).x11Forwarding, false);
  assert.equal(resolveGroupDefaults("prod/edge/api", configs).x11Forwarding, false);
  assert.equal(resolveGroupDefaults("other", configs).x11Forwarding, undefined);
});

test("applyGroupDefaults inherits group X11 forwarding when the host leaves it unset", () => {
  assert.equal(applyGroupDefaults(host(), { x11Forwarding: true }).x11Forwarding, true);
});

test("applyGroupDefaults keeps an explicit host X11 toggle ahead of the group", () => {
  assert.equal(
    applyGroupDefaults(host({ x11Forwarding: false }), { x11Forwarding: true }).x11Forwarding,
    false,
  );
  assert.equal(
    applyGroupDefaults(host({ x11Forwarding: true }), { x11Forwarding: false }).x11Forwarding,
    true,
  );
});

test("applyGroupDefaults leaves X11 forwarding off when neither host nor group sets it", () => {
  assert.equal(applyGroupDefaults(host(), {}).x11Forwarding, undefined);
});

test("applyGroupDefaults does not inherit X11 forwarding onto non-SSH transports", () => {
  const groupDefaults = { x11Forwarding: true as const };
  assert.equal(applyGroupDefaults(host({ moshEnabled: true }), groupDefaults).x11Forwarding, undefined);
  assert.equal(applyGroupDefaults(host({ etEnabled: true }), groupDefaults).x11Forwarding, undefined);
  assert.equal(applyGroupDefaults(host({ protocol: "telnet" }), groupDefaults).x11Forwarding, undefined);
  assert.equal(applyGroupDefaults(host({ protocol: "serial" }), groupDefaults).x11Forwarding, undefined);
  assert.equal(applyGroupDefaults(host({ protocol: "local" }), groupDefaults).x11Forwarding, undefined);
  assert.equal(
    applyGroupDefaults(host(), { ...groupDefaults, moshEnabled: true }).x11Forwarding,
    undefined,
  );
  assert.equal(
    applyGroupDefaults(host(), { ...groupDefaults, protocol: "telnet" }).x11Forwarding,
    undefined,
  );
  assert.equal(
    applyGroupDefaults(host({ moshEnabled: false }), { ...groupDefaults, moshEnabled: true }).x11Forwarding,
    true,
  );
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

test("group notes survive sanitization but are not connection defaults", () => {
  const config = { path: "Project", notes: "# VPN\nConnect before SSH.", username: "admin" };
  assert.equal(sanitizeGroupConfig(config).notes, config.notes);
  assert.equal(resolveGroupDefaults("Project", [config]).notes, undefined);
  assert.equal(resolveGroupDefaults("Project/Servers", [config]).notes, undefined);
});

test("applyGroupDefaults does not inherit group SSH credentials into serial hosts", () => {
  const groupDefaults: Partial<GroupConfig> = {
    username: "group-ssh-user",
    password: "group-ssh-password",
    savePassword: true,
    authMethod: "password",
  };

  const result = applyGroupDefaults(
    host({ protocol: "serial", username: undefined, password: undefined }),
    groupDefaults,
  );

  assert.equal(result.username, undefined);
  assert.equal(result.password, undefined);
});

test("applyGroupDefaults still inherits non-credential defaults into serial hosts", () => {
  const result = applyGroupDefaults(
    host({ protocol: "serial", username: undefined, charset: undefined }),
    { username: "group-ssh-user", charset: "UTF-8" },
  );

  assert.equal(result.username, undefined);
  assert.equal(result.charset, "UTF-8");
});

test("applyGroupDefaults does not inherit group SSH credentials into local shell hosts", () => {
  const groupDefaults: Partial<GroupConfig> = {
    username: "group-ssh-user",
    password: "group-ssh-password",
    savePassword: true,
    authMethod: "password",
    identityId: "identity-1",
    identityFileId: "identity-file-1",
  };

  const result = applyGroupDefaults(
    host({ protocol: "local", username: undefined, password: undefined }),
    groupDefaults,
  );

  assert.equal(result.username, undefined);
  assert.equal(result.password, undefined);
  assert.equal(result.savePassword, undefined);
  assert.equal(result.authMethod, undefined);
  assert.equal(result.identityId, undefined);
  assert.equal(result.identityFileId, undefined);
});

test("applyGroupDefaults does not inherit SSH transport/input defaults into local shell hosts", () => {
  const groupDefaults: Partial<GroupConfig> = {
    backspaceBehavior: "ctrl-h",
    moshEnabled: true,
    moshServerPath: "/usr/bin/mosh-server",
    etEnabled: true,
    etPort: 8737,
    legacyAlgorithms: true,
    skipEcdsaHostKey: true,
    agentForwarding: true,
    x11Forwarding: true,
    hostChain: { hostIds: ["bastion-1"] },
    charset: "UTF-8",
    fontSize: 14,
  };

  const result = applyGroupDefaults(
    host({
      protocol: "local",
      backspaceBehavior: undefined,
      algorithms: undefined,
      charset: undefined,
      fontSize: undefined,
    }),
    groupDefaults,
  );

  assert.equal(result.backspaceBehavior, undefined);
  assert.equal(result.moshEnabled, undefined);
  assert.equal(result.moshServerPath, undefined);
  assert.equal(result.etEnabled, undefined);
  assert.equal(result.etPort, undefined);
  assert.equal(result.legacyAlgorithms, undefined);
  assert.equal(result.skipEcdsaHostKey, undefined);
  assert.equal(result.agentForwarding, undefined);
  assert.equal(result.x11Forwarding, undefined);
  assert.equal(result.hostChain, undefined);
  // Display/appearance defaults still apply to local shells.
  assert.equal(result.charset, "UTF-8");
  assert.equal(result.fontSize, 14);
});

test("applyGroupDefaults still inherits non-credential defaults into local shell hosts", () => {
  const result = applyGroupDefaults(
    host({ protocol: "local", username: undefined, charset: undefined, fontSize: undefined }),
    { username: "group-ssh-user", charset: "UTF-8", fontSize: 14 },
  );

  assert.equal(result.username, undefined);
  assert.equal(result.charset, "UTF-8");
  assert.equal(result.fontSize, 14);
});

test("applyGroupDefaults does not inherit the group startup command into local shell hosts", () => {
  const result = applyGroupDefaults(
    host({ protocol: "local" }),
    { startupCommand: "rm -rf /", startupCommandRunMode: "paste" },
  );

  assert.equal(result.startupCommand, undefined);
  assert.equal(result.startupCommandRunMode, "paste");
});

const globalProxyOptions = {
  globalProxyProfileId: "global-proxy",
  validProxyProfileIds: new Set(["global-proxy", "group-proxy", "host-proxy"]),
};

test("applyGroupDefaults prefers the host proxy over the group and global defaults", () => {
  const result = applyGroupDefaults(
    host({ proxyProfileId: "host-proxy" }),
    { proxyProfileId: "group-proxy" },
    globalProxyOptions,
  );

  assert.equal(result.proxyProfileId, "host-proxy");
});

test("applyGroupDefaults prefers the nearest group proxy over the global default", () => {
  const groupDefaults = resolveGroupDefaults("prod/api", [
    { path: "prod", proxyProfileId: "group-proxy" },
    { path: "prod/api", proxyProfileId: "child-proxy" },
  ]);
  const result = applyGroupDefaults(host({ group: "prod/api" }), groupDefaults, {
    ...globalProxyOptions,
    validProxyProfileIds: new Set(["global-proxy", "group-proxy", "child-proxy"]),
  });

  assert.equal(result.proxyProfileId, "child-proxy");
});

test("applyGroupDefaults uses the global default when the host and group have no proxy", () => {
  const grouped = applyGroupDefaults(host({ group: "prod" }), {}, globalProxyOptions);
  const ungrouped = applyGroupDefaults(host(), {}, globalProxyOptions);

  assert.equal(grouped.proxyProfileId, "global-proxy");
  assert.equal(ungrouped.proxyProfileId, "global-proxy");
});

test("applyGroupDefaults stays direct when the global default is off", () => {
  const result = applyGroupDefaults(host(), {}, { globalProxyProfileId: "" });

  assert.equal(result.proxyProfileId, undefined);
  assert.equal(result.proxyConfig, undefined);
});

test("applyGroupDefaults lets an explicit host direct choice override group and global proxies", () => {
  const result = applyGroupDefaults(
    host({
      directProxy: true,
      proxyProfileId: "host-proxy",
      proxyConfig: { type: "http", host: "leftover.example.com", port: 8080 },
    }),
    { proxyProfileId: "group-proxy" },
    globalProxyOptions,
  );

  assert.equal(result.directProxy, true);
  assert.equal(result.proxyProfileId, undefined);
  assert.equal(result.proxyConfig, undefined);
});

test("applyGroupDefaults still inherits after the host proxy setting is cleared", () => {
  const fromGroup = applyGroupDefaults(
    host({ proxyProfileId: "" }),
    { proxyProfileId: "group-proxy" },
    globalProxyOptions,
  );
  const fromGlobal = applyGroupDefaults(
    host({ proxyProfileId: "" }),
    {},
    globalProxyOptions,
  );

  assert.equal(fromGroup.proxyProfileId, "group-proxy");
  assert.equal(fromGlobal.proxyProfileId, "global-proxy");
});

test("applyGroupDefaults ignores a deleted global proxy profile", () => {
  const result = applyGroupDefaults(host(), {}, {
    globalProxyProfileId: "deleted-proxy",
    validProxyProfileIds: new Set(["group-proxy"]),
  });

  assert.equal(result.proxyProfileId, undefined);
});

test("applyGroupDefaults keeps a missing group proxy instead of using the global default", () => {
  const result = applyGroupDefaults(
    host(),
    { proxyProfileId: "missing-proxy" },
    {
      globalProxyProfileId: "global-proxy",
      validProxyProfileIds: new Set(["global-proxy"]),
    },
  );

  assert.equal(result.proxyProfileId, "missing-proxy");
});

test("applyGroupDefaults reads the active global default when callers omit it", () => {
  publishActiveGlobalDefaultProxyProfileId("global-proxy");
  try {
    const inherited = applyGroupDefaults(host(), {});
    const forcedOff = applyGroupDefaults(host(), {}, { globalProxyProfileId: "" });
    assert.equal(inherited.proxyProfileId, "global-proxy");
    assert.equal(forcedOff.proxyProfileId, undefined);
  } finally {
    publishActiveGlobalDefaultProxyProfileId(undefined);
  }

  assert.equal(getActiveGlobalDefaultProxyProfileId(), undefined);
});

test("applyGroupDefaults inherits hostChain and proxy for vnc/rdp hosts while skipping SSH-only keys", () => {
  const groupDefaults: Partial<GroupConfig> = {
    username: "ssh-user",
    password: "ssh-password",
    port: 2222,
    protocol: "ssh",
    deviceType: "network",
    startupCommand: "uptime",
    charset: "GBK",
    theme: "dracula",
    fontFamily: "JetBrains Mono",
    fontSize: 16,
    moshEnabled: true,
    etEnabled: true,
    hostChain: { hostIds: ["bastion-1"] },
    proxyProfileId: "corp-proxy",
  };

  for (const protocol of ["rdp", "vnc"] as const) {
    const result = applyGroupDefaults(
      host({
        protocol,
        username: "",
        port: protocol === "rdp" ? 3389 : 5900,
      }),
      groupDefaults,
      { globalProxyProfileId: "" },
    );

    assert.deepEqual(result.hostChain, { hostIds: ["bastion-1"] });
    assert.equal(result.proxyProfileId, "corp-proxy");
    assert.equal(result.username, "");
    assert.equal(result.password, undefined);
    assert.equal(result.port, protocol === "rdp" ? 3389 : 5900);
    assert.equal(result.protocol, protocol);
    assert.equal(result.deviceType, undefined);
    assert.equal(result.startupCommand, undefined);
    assert.equal(result.charset, undefined);
    assert.equal(result.theme, undefined);
    assert.equal(result.fontFamily, undefined);
    assert.equal(result.fontSize, undefined);
    assert.equal(result.moshEnabled, undefined);
    assert.equal(result.etEnabled, undefined);
  }
});

test("sanitizeGroupConfig strips accidental plaintext passwords from rdpConfig and vncConfig while keeping identityId opt-out", () => {
  const sanitized = sanitizeGroupConfig({
    path: "desktops",
    rdpConfig: {
      enabled: true,
      port: 13389,
      domain: "CORP",
      identityId: "",
      password: "never-store-plaintext",
    } as GroupConfig["rdpConfig"],
    vncConfig: {
      enabled: true,
      port: 5902,
      identityId: "",
      password: "never-store-plaintext",
    } as GroupConfig["vncConfig"],
  });

  assert.equal(sanitized.rdpConfig?.port, 13389);
  assert.equal(sanitized.rdpConfig?.domain, "CORP");
  assert.equal(sanitized.rdpConfig?.identityId, "");
  assert.equal("password" in (sanitized.rdpConfig ?? {}), false);
  assert.equal(sanitized.vncConfig?.port, 5902);
  assert.equal(sanitized.vncConfig?.identityId, "");
  assert.equal("password" in (sanitized.vncConfig ?? {}), false);
});

test("resolveGroupDefaults merges rdpConfig and vncConfig across ancestor groups", () => {
  const resolved = resolveGroupDefaults("corp/eu", [
    {
      path: "corp",
      rdpConfig: {
        enabled: true,
        port: 3389,
        domain: "CORP",
        identityId: "parent-rdp-id",
        resolutionMode: "fixed",
        width: 1920,
        height: 1080,
        securityMode: "nla",
        audioEnabled: true,
      },
      vncConfig: {
        enabled: true,
        port: 5901,
        identityId: "parent-vnc-id",
        scalingMode: "fit",
        viewOnly: true,
      },
    },
    {
      path: "corp/eu",
      rdpConfig: {
        enabled: true,
        port: 13389,
        audioEnabled: false,
      },
      vncConfig: {
        enabled: true,
        username: "eu-vnc-user",
        viewOnly: false,
      },
    },
  ]);

  assert.deepEqual(resolved.rdpConfig, {
    enabled: true,
    port: 13389,
    domain: "CORP",
    identityId: "parent-rdp-id",
    resolutionMode: "fixed",
    width: 1920,
    height: 1080,
    securityMode: "nla",
    audioEnabled: false,
  });
  assert.deepEqual(resolved.vncConfig, {
    enabled: true,
    port: 5901,
    username: "eu-vnc-user",
    scalingMode: "fit",
    viewOnly: false,
  });
});

test("applyGroupDefaults inherits rdpConfig and vncConfig into standalone remote desktop hosts", () => {
  const groupDefaults: Partial<GroupConfig> = {
    port: 2222,
    username: "ssh-user",
    rdpConfig: {
      enabled: true,
      port: 13389,
      domain: "CORP",
      identityId: "group-rdp-id",
      tunnelViaHostSsh: true,
      tunnelTargetHost: "10.0.0.5",
      useHostCredentials: true,
      resolutionMode: "fixed",
      width: 1600,
      height: 900,
      colorDepth: 24,
      audioEnabled: false,
      securityMode: "nla",
    },
    vncConfig: {
      enabled: true,
      port: 5902,
      identityId: "group-vnc-id",
      tunnelViaHostSsh: true,
      scalingMode: "actual",
      quality: 8,
      compressionLevel: 4,
      viewOnly: true,
      showRemoteCursor: false,
    },
  };

  const rdpResult = applyGroupDefaults(
    host({ protocol: "rdp", username: "", port: undefined }),
    groupDefaults,
    { globalProxyProfileId: "" },
  );
  assert.equal(rdpResult.port, 13389);
  assert.equal(rdpResult.rdpConfig?.port, 13389);
  assert.equal(rdpResult.rdpConfig?.domain, "CORP");
  assert.equal(rdpResult.rdpConfig?.identityId, "group-rdp-id");
  assert.equal(rdpResult.rdpConfig?.resolutionMode, "fixed");
  assert.equal(rdpResult.rdpConfig?.width, 1600);
  assert.equal(rdpResult.rdpConfig?.height, 900);
  assert.equal(rdpResult.rdpConfig?.colorDepth, 24);
  assert.equal(rdpResult.rdpConfig?.audioEnabled, false);
  assert.equal(rdpResult.rdpConfig?.securityMode, "nla");
  // Companion-only flags must not leak onto standalone RDP hosts.
  assert.equal(rdpResult.rdpConfig?.enabled, undefined);
  assert.equal(rdpResult.rdpConfig?.tunnelViaHostSsh, undefined);
  assert.equal(rdpResult.rdpConfig?.tunnelTargetHost, undefined);
  assert.equal(rdpResult.rdpConfig?.useHostCredentials, undefined);
  assert.equal(rdpResult.vncConfig, undefined);

  const vncResult = applyGroupDefaults(
    host({ protocol: "vnc", username: "", port: undefined }),
    groupDefaults,
    { globalProxyProfileId: "" },
  );
  assert.equal(vncResult.port, 5902);
  assert.equal(vncResult.vncConfig?.port, 5902);
  assert.equal(vncResult.vncConfig?.identityId, "group-vnc-id");
  assert.equal(vncResult.vncConfig?.scalingMode, "actual");
  assert.equal(vncResult.vncConfig?.quality, 8);
  assert.equal(vncResult.vncConfig?.compressionLevel, 4);
  assert.equal(vncResult.vncConfig?.viewOnly, true);
  assert.equal(vncResult.vncConfig?.showRemoteCursor, false);
  assert.equal(vncResult.vncConfig?.enabled, undefined);
  assert.equal(vncResult.vncConfig?.tunnelViaHostSsh, undefined);
  assert.equal(vncResult.rdpConfig, undefined);
});

test("applyGroupDefaults respects standalone remote desktop host overrides and manual credentials", () => {
  const groupDefaults: Partial<GroupConfig> = {
    rdpConfig: {
      enabled: true,
      port: 13389,
      domain: "GROUPDOM",
      identityId: "group-rdp-id",
      securityMode: "nla",
    },
  };

  const result = applyGroupDefaults(
    host({
      protocol: "rdp",
      port: 3390,
      username: "local-admin",
      password: "secret",
      rdpConfig: { domain: "HOSTDOM" },
    }),
    groupDefaults,
    { globalProxyProfileId: "" },
  );

  assert.equal(result.port, 3390);
  assert.equal(result.rdpConfig?.port, undefined);
  assert.equal(result.rdpConfig?.domain, "HOSTDOM");
  assert.equal(result.rdpConfig?.identityId, undefined);
  assert.equal(result.rdpConfig?.securityMode, "nla");
});

test("applyGroupDefaults inherits rdpConfig and vncConfig only into SSH hosts that enabled those protocols", () => {
  const groupDefaults: Partial<GroupConfig> = {
    port: 2222,
    rdpConfig: {
      enabled: true,
      port: 13389,
      domain: "CORP",
      identityId: "group-rdp-id",
      tunnelViaHostSsh: false,
      resolutionMode: "fit",
    },
    vncConfig: {
      enabled: true,
      port: 5905,
      useHostCredentials: true,
      tunnelViaHostSsh: true,
      tunnelTargetHost: "127.0.0.1",
      scalingMode: "dynamic",
    },
  };

  // Plain SSH host without RDP/VNC enabled must NOT have RDP/VNC enabled by the group.
  const sshOnly = applyGroupDefaults(
    host({ protocol: "ssh", port: undefined }),
    groupDefaults,
    { globalProxyProfileId: "" },
  );
  assert.equal(sshOnly.port, 2222);
  assert.equal(sshOnly.rdpConfig, undefined);
  assert.equal(sshOnly.vncConfig, undefined);

  // SSH host with companion RDP & VNC enabled inherits both protocol configs cleanly.
  const companion = applyGroupDefaults(
    host({
      protocol: "ssh",
      port: undefined,
      rdpConfig: { enabled: true },
      vncConfig: { enabled: true, port: 5910 },
    }),
    groupDefaults,
    { globalProxyProfileId: "" },
  );
  assert.equal(companion.port, 2222);
  assert.deepEqual(companion.rdpConfig, {
    enabled: true,
    port: 13389,
    domain: "CORP",
    identityId: "group-rdp-id",
    tunnelViaHostSsh: false,
    resolutionMode: "fit",
  });
  assert.deepEqual(companion.vncConfig, {
    enabled: true,
    port: 5910,
    useHostCredentials: true,
    tunnelViaHostSsh: true,
    tunnelTargetHost: "127.0.0.1",
    scalingMode: "dynamic",
  });

  // Companion RDP host explicitly using host credentials must not inherit group RDP identityId.
  const companionHostCreds = applyGroupDefaults(
    host({
      protocol: "ssh",
      rdpConfig: { enabled: true, useHostCredentials: true },
    }),
    groupDefaults,
    { globalProxyProfileId: "" },
  );
  assert.equal(companionHostCreds.rdpConfig?.useHostCredentials, true);
  assert.equal(companionHostCreds.rdpConfig?.identityId, undefined);
  assert.equal(companionHostCreds.rdpConfig?.domain, "CORP");
});
