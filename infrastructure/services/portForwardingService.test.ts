import test from "node:test";
import assert from "node:assert/strict";

import type { Host, PortForwardingRule } from "../../domain/models.ts";
import { startPortForward } from "./portForwardingService.ts";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  username: "root",
  tags: [],
  os: "linux",
  ...overrides,
});

const rule = (overrides: Partial<PortForwardingRule> = {}): PortForwardingRule => ({
  id: "rule-1",
  name: "Rule",
  type: "local",
  localPort: 18080,
  remoteHost: "127.0.0.1",
  remotePort: 8080,
  enabled: true,
  status: "inactive",
  ...overrides,
});

const installBridgeStub = () => {
  let started = false;
  let capturedOptions: Record<string, unknown> | null = null;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async (options: Record<string, unknown>) => {
          started = true;
          capturedOptions = options;
          return { success: true };
        },
        onPortForwardStatus: () => undefined,
      },
    },
  });
  return {
    wasStarted: () => started,
    getOptions: () => capturedOptions,
  };
};

test("startPortForward rejects missing proxy identities before starting", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];

  const result = await startPortForward(
    rule(),
    host({
      proxyConfig: {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "missing-identity",
      },
    }),
    [],
    [],
    [],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy identity for "Host" is missing/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy identity/);
});

test("startPortForward rejects missing saved proxy profiles before starting", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];

  const result = await startPortForward(
    rule({ id: "rule-missing-profile" }),
    host({ proxyProfileId: "missing-proxy" }),
    [],
    [],
    [],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Saved proxy for host "Host" is missing/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Saved proxy/);
});

test("startPortForward rejects incomplete proxy identities before starting", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];

  const result = await startPortForward(
    rule({ id: "rule-incomplete" }),
    host({
      proxyConfig: {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "identity-1",
      },
    }),
    [],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy identity for "Host" is incomplete/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy identity/);
});

test("startPortForward rejects proxy identities with blank usernames even when passwords are encrypted", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];

  const result = await startPortForward(
    rule({ id: "rule-blank-username" }),
    host({
      proxyConfig: {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "identity-1",
      },
    }),
    [],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "",
      authMethod: "password",
      password: "enc:v1:djEwAAAA",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy identity for "Host" is incomplete/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy identity/);
});

test("startPortForward resolves target proxy credentials from an identity", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];

  const result = await startPortForward(
    rule({ id: "rule-resolved-target" }),
    host({
      proxyConfig: {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "identity-1",
      },
    }),
    [],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      password: "proxy-secret",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, true);
  assert.equal(bridge.wasStarted(), true);
  assert.deepEqual(bridge.getOptions()?.proxy, {
    type: "http",
    host: "proxy.example.com",
    port: 3128,
    username: "proxy-user",
    password: "proxy-secret",
  });
  assert.deepEqual(statuses, ["connecting"]);
});

test("startPortForward rejects target proxy identity passwords that cannot be decrypted", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];

  const result = await startPortForward(
    rule({ id: "rule-unreadable-target" }),
    host({
      proxyConfig: {
        type: "http",
        host: "proxy.example.com",
        port: 3128,
        identityId: "identity-1",
      },
    }),
    [],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      password: "enc:v1:djEwAAAA",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy credentials cannot be decrypted/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy credentials/);
});

test("startPortForward rejects missing jump host proxy identities before starting", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyConfig: {
      type: "http",
      host: "proxy.example.com",
      port: 3128,
      identityId: "missing-identity",
    },
  });

  const result = await startPortForward(
    rule({ id: "rule-2" }),
    host({ hostChain: { hostIds: ["jump-1"] } }),
    [jumpHost],
    [],
    [],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy identity for "Jump" is missing/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy identity/);
});

test("startPortForward rejects missing saved proxy profiles on jump hosts before starting", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyProfileId: "missing-proxy",
  });

  const result = await startPortForward(
    rule({ id: "rule-missing-jump-profile" }),
    host({ hostChain: { hostIds: ["jump-1"] } }),
    [jumpHost],
    [],
    [],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Saved proxy for jump host "Jump" is missing/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Saved proxy/);
});

test("startPortForward rejects incomplete jump host proxy identities before starting", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyConfig: {
      type: "http",
      host: "proxy.example.com",
      port: 3128,
      identityId: "identity-1",
    },
  });

  const result = await startPortForward(
    rule({ id: "rule-jump-incomplete" }),
    host({ hostChain: { hostIds: ["jump-1"] } }),
    [jumpHost],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "",
      authMethod: "password",
      password: "enc:v1:djEwAAAA",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy identity for "Jump" is incomplete/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy identity/);
});

test("startPortForward resolves jump host proxy credentials from an identity", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyConfig: {
      type: "socks5",
      host: "jump-proxy.example.com",
      port: 1080,
      identityId: "identity-1",
    },
  });

  const result = await startPortForward(
    rule({ id: "rule-resolved-jump" }),
    host({ hostChain: { hostIds: ["jump-1"] } }),
    [jumpHost],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      password: "proxy-secret",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, true);
  assert.equal(bridge.wasStarted(), true);
  const jumpHosts = bridge.getOptions()?.jumpHosts as Array<Record<string, unknown>>;
  assert.deepEqual(jumpHosts[0]?.proxy, {
    type: "socks5",
    host: "jump-proxy.example.com",
    port: 1080,
    username: "proxy-user",
    password: "proxy-secret",
  });
  assert.deepEqual(statuses, ["connecting"]);
});

test("startPortForward rejects jump host proxy identity passwords that cannot be decrypted", async () => {
  const bridge = installBridgeStub();
  const statuses: string[] = [];
  const jumpHost = host({
    id: "jump-1",
    label: "Jump",
    proxyConfig: {
      type: "http",
      host: "proxy.example.com",
      port: 3128,
      identityId: "identity-1",
    },
  });

  const result = await startPortForward(
    rule({ id: "rule-unreadable-jump" }),
    host({ hostChain: { hostIds: ["jump-1"] } }),
    [jumpHost],
    [],
    [{
      id: "identity-1",
      label: "Proxy login",
      username: "proxy-user",
      authMethod: "password",
      password: "enc:v1:djEwAAAA",
      created: 1,
    }],
    (status, error) => statuses.push(error ? `${status}:${error}` : status),
  );

  assert.equal(result.success, false);
  assert.match(result.error || "", /Proxy credentials for jump host "Jump" cannot be decrypted/);
  assert.equal(bridge.wasStarted(), false);
  assert.match(statuses.at(-1) || "", /error:Proxy credentials/);
});
