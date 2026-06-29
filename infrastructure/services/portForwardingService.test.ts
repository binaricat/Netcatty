import test from "node:test";
import assert from "node:assert/strict";

import type { Host, Identity, PortForwardingRule } from "../../domain/models.ts";
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
  label: "Rule",
  type: "local",
  localPort: 8080,
  bindAddress: "127.0.0.1",
  remoteHost: "127.0.0.1",
  remotePort: 80,
  status: "inactive",
  createdAt: 1,
  ...overrides,
});

const withNetcattyBridge = async <T>(
  bridge: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { netcatty: bridge };
  try {
    return await run();
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
  }
};

test("startPortForward resolves proxy credentials from a referenced keychain identity", async () => {
  const identity: Identity = {
    id: "identity-1",
    label: "Proxy Login",
    username: "proxy-user",
    authMethod: "password",
    password: "proxy-secret",
    created: 1,
  };
  let capturedOptions: { proxy?: { username?: string; password?: string } } | undefined;
  const statuses: string[] = [];

  const result = await withNetcattyBridge(
    {
      startPortForward: async (options: { proxy?: { username?: string; password?: string } }) => {
        capturedOptions = options;
        return { success: true };
      },
      onPortForwardStatus: () => () => undefined,
    },
    () => startPortForward(
      rule(),
      host({
        proxyConfig: {
          type: "socks5",
          host: "proxy.example.com",
          port: 1080,
          identityId: identity.id,
        },
      }),
      [],
      [],
      [identity],
      (status) => statuses.push(status),
    ),
  );

  assert.equal(result.success, true);
  assert.equal(capturedOptions?.proxy?.username, "proxy-user");
  assert.equal(capturedOptions?.proxy?.password, "proxy-secret");
  assert.deepEqual(statuses, ["connecting"]);
});

test("startPortForward rejects proxy identities without saved passwords", async () => {
  const identity: Identity = {
    id: "identity-1",
    label: "Key Only",
    username: "proxy-user",
    authMethod: "key",
    created: 1,
  };
  let startCalled = false;
  const statuses: Array<{ status: string; error?: string }> = [];

  const result = await withNetcattyBridge(
    {
      startPortForward: async () => {
        startCalled = true;
        return { success: true };
      },
      onPortForwardStatus: () => () => undefined,
    },
    () => startPortForward(
      rule(),
      host({
        proxyConfig: {
          type: "socks5",
          host: "proxy.example.com",
          port: 1080,
          identityId: identity.id,
        },
      }),
      [],
      [],
      [identity],
      (status, error) => statuses.push({ status, error }),
    ),
  );

  assert.equal(startCalled, false);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /has no saved password/);
  assert.deepEqual(statuses, [{
    status: "error",
    error: result.error,
  }]);
});
