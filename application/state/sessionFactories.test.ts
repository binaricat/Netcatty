import assert from "node:assert/strict";
import test from "node:test";

import type { Host } from "../../domain/models";
import { prepareSerialConfigForSavedHost } from "../../domain/serialBackspace";
import { buildTelnetDeepLinkConnectionHost } from "../../domain/telnetDeepLink";
import { resolveEffectiveTerminalHost } from "../../domain/terminalHostResolution";
import {
  createHostTerminalSession,
  createSerialTerminalSession,
  createWorkspaceHostTerminalSession,
} from "./sessionFactories";

const host = (overrides: Partial<Host>): Host => ({
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  username: "alice",
  port: 22,
  group: "",
  tags: [],
  os: "linux",
  protocol: "ssh",
  createdAt: 1,
  ...overrides,
});

test("createHostTerminalSession keeps telnet deep-link default port for ssh hosts with telnet enabled", () => {
  const connectionHost = buildTelnetDeepLinkConnectionHost(
    host({
      protocol: "ssh",
      telnetEnabled: true,
      telnetPort: undefined,
    }),
  );

  const session = createHostTerminalSession("session-1", connectionHost);

  assert.equal(session.protocol, "telnet");
  assert.equal(session.port, 23);
});

test("serial session factories snapshot effective legacy Backspace behavior", () => {
  const savedHostSession = createHostTerminalSession("session-1", host({
    protocol: "serial",
    hostname: "COM3",
    port: 115200,
    username: "",
    serialConfig: {
      path: "COM3",
      baudRate: 115200,
    },
    backspaceBehavior: "ctrl-h",
  }));
  const quickSession = createSerialTerminalSession("session-2", {
    path: "COM4",
    baudRate: 9600,
  });
  const explicitDefaultSession = createHostTerminalSession("session-3", host({
    protocol: "serial",
    hostname: "COM5",
    port: 115200,
    username: "",
    backspaceBehavior: "ctrl-h",
    serialConfig: {
      path: "COM5",
      baudRate: 115200,
      backspaceBehavior: "default",
    },
  }));

  assert.equal(savedHostSession.serialConfig?.backspaceBehavior, "ctrl-h");
  assert.equal(quickSession.serialConfig?.backspaceBehavior, "default");
  assert.equal(explicitDefaultSession.serialConfig?.backspaceBehavior, "default");
});

test("workspace host factory creates a complete serial session", () => {
  const session = createWorkspaceHostTerminalSession("session-serial", host({
    protocol: "serial",
    hostname: "COM7",
    port: 57600,
    username: "",
    serialConfig: {
      path: "COM7",
      baudRate: 57600,
      dataBits: 7,
      stopBits: 2,
      parity: "even",
    },
  }), "workspace-1");

  assert.equal(session.workspaceId, "workspace-1");
  assert.equal(session.protocol, "serial");
  assert.deepEqual(session.serialConfig, {
    path: "COM7",
    baudRate: 57600,
    dataBits: 7,
    stopBits: 2,
    parity: "even",
    backspaceBehavior: "default",
  });
});

test("serial session factories preserve byteOrientedBackspace", () => {
  const quickSession = createSerialTerminalSession("session-q", {
    path: "COM4",
    baudRate: 9600,
    byteOrientedBackspace: false,
  });
  const savedHostSession = createHostTerminalSession("session-h", host({
    protocol: "serial",
    hostname: "COM3",
    port: 115200,
    username: "",
    serialConfig: {
      path: "COM3",
      baudRate: 115200,
      byteOrientedBackspace: false,
    },
  }));

  assert.equal(quickSession.serialConfig?.byteOrientedBackspace, false);
  assert.equal(savedHostSession.serialConfig?.byteOrientedBackspace, false);
});

test("workspace append snapshots serial Backspace behavior inherited from a group", () => {
  const savedHost = host({
    protocol: "serial",
    hostname: "COM3",
    port: 115200,
    username: "",
    group: "network/serial",
    serialConfig: prepareSerialConfigForSavedHost({
      path: "COM3",
      baudRate: 115200,
      backspaceBehavior: "default",
    }),
  });
  const effectiveHost = resolveEffectiveTerminalHost({
    host: savedHost,
    groupConfigs: [{ path: "network", backspaceBehavior: "ctrl-h" }],
    proxyProfiles: [],
  });

  const session = createWorkspaceHostTerminalSession("session-1", effectiveHost, "workspace-1");

  assert.equal(session.workspaceId, "workspace-1");
  assert.equal(session.serialConfig?.backspaceBehavior, "ctrl-h");
});

test("host session factories snapshot plugin connection configuration", () => {
  const providerId = "com.example.transport.connection";
  const pluginConnection = {
    providerId,
    authenticationProviderId: "com.example.transport.auth",
    configuration: { endpoint: "gateway.example", tags: ["prod"] },
    credentialId: "credential-reference-1234",
  };
  const pluginHost = host({
    protocol: `plugin:${providerId}`,
    pluginConnection,
  });

  const regular = createHostTerminalSession("session-plugin", pluginHost);
  const workspace = createWorkspaceHostTerminalSession("session-workspace-plugin", pluginHost, "workspace-1");

  assert.equal(regular.protocol, `plugin:${providerId}`);
  assert.deepEqual(regular.pluginConnection, pluginConnection);
  assert.notEqual(regular.pluginConnection, pluginConnection);
  assert.equal(workspace.workspaceId, "workspace-1");
  assert.deepEqual(workspace.pluginConnection, pluginConnection);
  assert.notEqual(workspace.pluginConnection, pluginConnection);
});
