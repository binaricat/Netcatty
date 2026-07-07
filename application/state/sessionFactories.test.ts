import assert from "node:assert/strict";
import test from "node:test";

import type { Host } from "../../domain/models";
import { buildTelnetDeepLinkConnectionHost } from "../../domain/telnetDeepLink";
import { createHostTerminalSession } from "./sessionFactories";

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
