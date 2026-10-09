import assert from "node:assert/strict";
import test from "node:test";

import { createHostTerminalSession } from "./sessionFactories.ts";
import { createLocalTerminalSession } from "./sessionFactories.ts";
import type { Host } from "../../domain/models";

const localVaultHost = (overrides: Partial<Host> = {}): Host => ({
  id: "local-vault-1",
  label: "Project A CMD",
  hostname: "localhost",
  username: "",
  group: "Projects/A",
  tags: ["local"],
  os: "linux",
  protocol: "local",
  createdAt: 0,
  ...overrides,
});

test("createHostTerminalSession copies local shell fields for local vault hosts", () => {
  const host = localVaultHost({
    localShell: "wsl-ubuntu",
    localShellArgs: ["--cd", "/work"],
    localShellName: "Ubuntu (WSL)",
    localShellIcon: "ubuntu",
    localStartDir: "/work",
  });
  const session = createHostTerminalSession("session-1", host);

  assert.equal(session.protocol, "local");
  assert.equal(session.hostId, "local-vault-1");
  assert.equal(session.localShell, "wsl-ubuntu");
  assert.deepEqual(session.localShellArgs, ["--cd", "/work"]);
  assert.equal(session.localShellName, "Ubuntu (WSL)");
  assert.equal(session.localShellIcon, "ubuntu");
  assert.equal(session.localStartDir, "/work");
});

test("createHostTerminalSession does not add local shell fields to SSH hosts", () => {
  const host: Host = {
    ...localVaultHost({ protocol: "ssh", hostname: "example.com", port: 22 }),
  } as Host;
  const session = createHostTerminalSession("session-2", host);

  assert.equal(session.protocol, "ssh");
  assert.equal(session.localShell, undefined);
  assert.equal(session.localShellName, undefined);
});

test("createLocalTerminalSession is unaffected by vault local hosts", () => {
  const session = createLocalTerminalSession("session-3", { shellName: "CMD" });
  assert.equal(session.hostId, "local-terminal");
  assert.equal(session.localShellName, "CMD");
});
