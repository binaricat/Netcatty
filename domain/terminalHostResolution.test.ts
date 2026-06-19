import assert from "node:assert/strict";
import test from "node:test";

import type { GroupConfig, Host, ProxyProfile, TerminalSession } from "./models";
import {
  resolveTerminalChainHosts,
  resolveTerminalSessionHost,
} from "./terminalHostResolution";

const baseSession: TerminalSession = {
  id: "session-1",
  hostId: "target",
  hostLabel: "Target",
  hostname: "target.example.test",
  username: "alice",
  port: 22,
  protocol: "ssh",
  status: "connected",
  createdAt: 1,
};

const proxyProfiles: ProxyProfile[] = [{
  id: "proxy-1",
  label: "Office proxy",
  config: {
    type: "http",
    host: "proxy.example.test",
    port: 3128,
    username: "proxy-user",
  },
  createdAt: 1,
}];

test("resolveTerminalSessionHost materializes a saved proxy profile for popup terminals", () => {
  const host: Host = {
    id: "target",
    label: "Target",
    hostname: "target.example.test",
    username: "alice",
    port: 22,
    protocol: "ssh",
    tags: [],
    os: "linux",
    proxyProfileId: "proxy-1",
  };

  const resolved = resolveTerminalSessionHost({
    session: baseSession,
    hosts: [host],
    groupConfigs: [],
    proxyProfiles,
    localOs: "linux",
  });

  assert.equal(resolved.proxyProfileId, "proxy-1");
  assert.deepEqual(resolved.proxyConfig, proxyProfiles[0].config);
});

test("resolveTerminalSessionHost applies group default proxy profiles before opening popup terminals", () => {
  const host: Host = {
    id: "target",
    label: "Target",
    hostname: "target.example.test",
    username: "alice",
    port: 22,
    protocol: "ssh",
    tags: [],
    os: "linux",
    group: "prod/web",
  };
  const groupConfigs: GroupConfig[] = [
    { path: "prod", proxyProfileId: "proxy-1" },
  ];

  const resolved = resolveTerminalSessionHost({
    session: baseSession,
    hosts: [host],
    groupConfigs,
    proxyProfiles,
    localOs: "linux",
  });

  assert.equal(resolved.proxyProfileId, "proxy-1");
  assert.deepEqual(resolved.proxyConfig, proxyProfiles[0].config);
});

test("resolveTerminalSessionHost defaults missing saved remote sessions to SSH", () => {
  const resolved = resolveTerminalSessionHost({
    session: {
      ...baseSession,
      protocol: undefined,
    },
    hosts: [],
    groupConfigs: [],
    proxyProfiles,
    localOs: "macos",
  });

  assert.equal(resolved.protocol, "ssh");
  assert.equal(resolved.hostname, "target.example.test");
  assert.equal(resolved.username, "alice");
  assert.equal(resolved.os, "linux");
});

test("resolveTerminalSessionHost keeps explicit missing local sessions local", () => {
  const resolved = resolveTerminalSessionHost({
    session: {
      ...baseSession,
      protocol: "local",
      hostname: "localhost",
      username: "local",
    },
    hosts: [],
    groupConfigs: [],
    proxyProfiles,
    localOs: "macos",
  });

  assert.equal(resolved.protocol, "local");
  assert.equal(resolved.os, "macos");
});

test("resolveTerminalChainHosts materializes proxy profiles on jump hosts", () => {
  const target: Host = {
    id: "target",
    label: "Target",
    hostname: "target.example.test",
    username: "alice",
    port: 22,
    protocol: "ssh",
    tags: [],
    os: "linux",
    hostChain: { hostIds: ["jump-1"] },
  };
  const jumpHost: Host = {
    id: "jump-1",
    label: "Jump",
    hostname: "jump.example.test",
    username: "jump",
    port: 22,
    protocol: "ssh",
    tags: [],
    os: "linux",
    proxyProfileId: "proxy-1",
  };

  const resolved = resolveTerminalChainHosts({
    host: target,
    hosts: [target, jumpHost],
    groupConfigs: [],
    proxyProfiles,
  });

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.id, "jump-1");
  assert.deepEqual(resolved[0]?.proxyConfig, proxyProfiles[0].config);
});

test("resolveTerminalChainHosts applies group default proxy profiles to jump hosts", () => {
  const target: Host = {
    id: "target",
    label: "Target",
    hostname: "target.example.test",
    username: "alice",
    port: 22,
    protocol: "ssh",
    tags: [],
    os: "linux",
    hostChain: { hostIds: ["jump-1"] },
  };
  const jumpHost: Host = {
    id: "jump-1",
    label: "Jump",
    hostname: "jump.example.test",
    username: "jump",
    port: 22,
    protocol: "ssh",
    tags: [],
    os: "linux",
    group: "bastion",
  };
  const groupConfigs: GroupConfig[] = [
    { path: "bastion", proxyProfileId: "proxy-1" },
  ];

  const resolved = resolveTerminalChainHosts({
    host: target,
    hosts: [target, jumpHost],
    groupConfigs,
    proxyProfiles,
  });

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.id, "jump-1");
  assert.equal(resolved[0]?.proxyProfileId, "proxy-1");
  assert.deepEqual(resolved[0]?.proxyConfig, proxyProfiles[0].config);
});
