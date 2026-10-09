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

test("resolveTerminalSessionHost restores a missing plugin host from the session snapshot", () => {
  const providerId = "com.example.transport.connection";
  const pluginConnection = {
    providerId,
    configuration: { endpoint: "saved.example", mode: "opaque" },
  };
  const resolved = resolveTerminalSessionHost({
    session: {
      ...baseSession,
      hostId: "missing-plugin-host",
      protocol: `plugin:${providerId}`,
      pluginConnection,
    },
    hosts: [],
    groupConfigs: [],
    proxyProfiles,
    localOs: "macos",
  });

  assert.equal(resolved.protocol, `plugin:${providerId}`);
  assert.deepEqual(resolved.pluginConnection, pluginConnection);
});

test("resolveTerminalSessionHost keeps the session plugin configuration when the Vault host changes", () => {
  const providerId = "com.example.transport.connection";
  const protocol = `plugin:${providerId}` as const;
  const resolved = resolveTerminalSessionHost({
    session: {
      ...baseSession,
      protocol,
      pluginConnection: { providerId, configuration: { endpoint: "session.example" } },
    },
    hosts: [{
      id: "target",
      label: "Target",
      hostname: providerId,
      username: "",
      tags: [],
      os: "linux",
      protocol,
      pluginConnection: { providerId, configuration: { endpoint: "vault.example" } },
    }],
    groupConfigs: [],
    proxyProfiles,
    localOs: "linux",
  });

  assert.deepEqual(resolved.pluginConnection, {
    providerId,
    configuration: { endpoint: "session.example" },
  });
});

test("resolveTerminalSessionHost carries local session start directory into fallback host", () => {
  const resolved = resolveTerminalSessionHost({
    session: {
      ...baseSession,
      protocol: "local",
      hostname: "localhost",
      username: "local",
      localStartDir: "/Users/alice/project",
    },
    hosts: [],
    groupConfigs: [],
    proxyProfiles,
    localOs: "macos",
  });

  assert.equal(resolved.protocol, "local");
  assert.equal(resolved.localStartDir, "/Users/alice/project");
});

test("resolveTerminalSessionHost carries serial Ctrl-H backspace behavior into quick sessions", () => {
  const resolved = resolveTerminalSessionHost({
    session: {
      ...baseSession,
      hostId: "serial-session-1",
      hostLabel: "Serial: COM3",
      hostname: "COM3",
      username: "",
      protocol: "serial",
      serialConfig: {
        path: "COM3",
        baudRate: 115200,
        backspaceBehavior: "ctrl-h",
      },
    },
    hosts: [],
    groupConfigs: [],
    proxyProfiles,
    localOs: "windows",
  });

  assert.equal(resolved.protocol, "serial");
  assert.equal(resolved.backspaceBehavior, "ctrl-h");
});

test("resolveTerminalSessionHost applies serial Ctrl-H backspace behavior from saved hosts", () => {
  const host: Host = {
    id: "target",
    label: "Serial: COM3",
    hostname: "COM3",
    username: "",
    port: 115200,
    protocol: "serial",
    tags: [],
    os: "linux",
    serialConfig: {
      path: "COM3",
      baudRate: 115200,
      backspaceBehavior: "ctrl-h",
    },
  };

  const resolved = resolveTerminalSessionHost({
    session: {
      ...baseSession,
      hostLabel: "Serial: COM3",
      hostname: "COM3",
      username: "",
      port: undefined,
      protocol: "serial",
    },
    hosts: [host],
    groupConfigs: [],
    proxyProfiles,
    localOs: "windows",
  });

  assert.equal(resolved.protocol, "serial");
  assert.equal(resolved.backspaceBehavior, "ctrl-h");
});

test("resolveTerminalSessionHost preserves inherited Ctrl-H for legacy restored serial sessions", () => {
  const host: Host = {
    id: "target",
    label: "Serial: COM3",
    hostname: "COM3",
    username: "",
    port: 115200,
    protocol: "serial",
    tags: [],
    os: "linux",
    group: "serial-devices",
    serialConfig: {
      path: "COM3",
      baudRate: 115200,
    },
  };

  const resolved = resolveTerminalSessionHost({
    session: {
      ...baseSession,
      hostLabel: "Serial: COM3",
      hostname: "COM3",
      username: "",
      port: undefined,
      protocol: "serial",
      serialConfig: {
        path: "COM3",
        baudRate: 115200,
      },
    },
    hosts: [host],
    groupConfigs: [{ path: "serial-devices", backspaceBehavior: "ctrl-h" }],
    proxyProfiles,
    localOs: "windows",
  });

  assert.equal(resolved.backspaceBehavior, "ctrl-h");
});

test("resolveTerminalSessionHost keeps the serial Backspace behavior captured by the session", () => {
  const host: Host = {
    id: "target",
    label: "Serial: COM3",
    hostname: "COM3",
    username: "",
    port: 115200,
    protocol: "serial",
    tags: [],
    os: "linux",
    serialConfig: {
      path: "COM3",
      baudRate: 115200,
      backspaceBehavior: "default",
    },
  };

  const ctrlHSession = resolveTerminalSessionHost({
    session: {
      ...baseSession,
      hostname: "COM3",
      username: "",
      protocol: "serial",
      serialConfig: {
        path: "COM3",
        baudRate: 115200,
        backspaceBehavior: "ctrl-h",
      },
    },
    hosts: [host],
    groupConfigs: [],
    proxyProfiles,
    localOs: "windows",
  });

  const defaultSession = resolveTerminalSessionHost({
    session: {
      ...baseSession,
      hostname: "COM3",
      username: "",
      protocol: "serial",
      serialConfig: {
        path: "COM3",
        baudRate: 115200,
        backspaceBehavior: "default",
      },
    },
    hosts: [{
      ...host,
      serialConfig: {
        ...host.serialConfig!,
        backspaceBehavior: "ctrl-h",
      },
    }],
    groupConfigs: [],
    proxyProfiles,
    localOs: "windows",
  });

  assert.equal(ctrlHSession.backspaceBehavior, "ctrl-h");
  assert.equal(defaultSession.backspaceBehavior, undefined);
});

test("resolveTerminalSessionHost suppresses inherited network device mode for Mosh sessions", () => {
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
    { path: "prod", deviceType: "network" },
    { path: "prod/web", moshEnabled: true },
  ];

  const resolved = resolveTerminalSessionHost({
    session: baseSession,
    hosts: [host],
    groupConfigs,
    proxyProfiles,
    localOs: "linux",
  });

  assert.equal(resolved.moshEnabled, true);
  assert.equal(resolved.deviceType, undefined);
});

test("resolveTerminalSessionHost suppresses explicit network device mode for ET session overrides", () => {
  const host: Host = {
    id: "target",
    label: "Target",
    hostname: "target.example.test",
    username: "alice",
    port: 22,
    protocol: "ssh",
    tags: [],
    os: "linux",
    deviceType: "network",
  };

  const resolved = resolveTerminalSessionHost({
    session: {
      ...baseSession,
      etEnabled: true,
    },
    hosts: [host],
    groupConfigs: [],
    proxyProfiles,
    localOs: "linux",
  });

  assert.equal(resolved.etEnabled, true);
  assert.equal(resolved.deviceType, undefined);
  assert.equal(host.deviceType, "network");
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

test("resolveTerminalChainHosts skips non-SSH jump candidates", () => {
  const target: Host = {
    id: "target",
    label: "Target",
    hostname: "target.example.test",
    username: "alice",
    port: 22,
    protocol: "ssh",
    tags: [],
    os: "linux",
    hostChain: { hostIds: ["jump-local", "jump-serial", "jump-telnet", "jump-ssh", "jump-mosh"] },
  };
  const localHost: Host = {
    id: "jump-local",
    label: "Local Shell",
    hostname: "localhost",
    username: "",
    port: 22,
    protocol: "local",
    tags: [],
    os: "linux",
  };
  const serialHost: Host = {
    id: "jump-serial",
    label: "Serial",
    hostname: "/dev/ttyUSB0",
    username: "",
    port: 22,
    protocol: "serial",
    tags: [],
    os: "linux",
  };
  const telnetHost: Host = {
    id: "jump-telnet",
    label: "Telnet",
    hostname: "telnet.example.test",
    username: "bob",
    port: 23,
    protocol: "telnet",
    tags: [],
    os: "linux",
  };
  const sshHost: Host = {
    id: "jump-ssh",
    label: "Jump SSH",
    hostname: "jump.example.test",
    username: "jump",
    port: 22,
    protocol: "ssh",
    tags: [],
    os: "linux",
  };
  const moshHost: Host = {
    id: "jump-mosh",
    label: "Jump Mosh",
    hostname: "mosh.example.test",
    username: "jump",
    port: 22,
    protocol: "ssh",
    moshEnabled: true,
    tags: [],
    os: "linux",
  };

  const resolved = resolveTerminalChainHosts({
    host: target,
    hosts: [target, localHost, serialHost, telnetHost, sshHost, moshHost],
    groupConfigs: [],
    proxyProfiles,
  });

  assert.deepEqual(resolved.map((host) => host.id), ["jump-ssh", "jump-mosh"]);
});
