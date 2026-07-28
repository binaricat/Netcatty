import test from "node:test";
import assert from "node:assert/strict";

import { buildAITerminalSessionInfo } from "./buildAITerminalSessionInfo";
import type { Host, TerminalSession } from "../../types";

const baseHost = (overrides: Partial<Host> = {}): Host =>
  ({
    id: "h1",
    label: "sw1",
    hostname: "10.0.0.1",
    username: "admin",
    protocol: "ssh",
    ...overrides,
  } as Host);

const baseSession = (overrides: Partial<TerminalSession> = {}): TerminalSession =>
  ({
    id: "s1",
    hostId: "h1",
    protocol: "ssh",
    status: "connected",
    ...overrides,
  } as TerminalSession);

test("keeps explicit network deviceType", () => {
  const info = buildAITerminalSessionInfo(
    baseSession(),
    baseHost({ deviceType: "network" }),
    "linux",
  );
  assert.equal(info.deviceType, "network");
});

test("reports 'network' when the detected distro classifies as a network device (#2367)", () => {
  // Huawei VRP is a known network-device vendor id; the user has NOT flipped
  // Network Device Mode, so host.deviceType is unset.
  const info = buildAITerminalSessionInfo(
    baseSession(),
    baseHost({ distro: "huawei" }),
    "linux",
  );
  assert.equal(info.deviceType, "network");
});

test("does not force network for a normal linux distro", () => {
  const info = buildAITerminalSessionInfo(
    baseSession(),
    baseHost({ distro: "ubuntu" }),
    "linux",
  );
  assert.notEqual(info.deviceType, "network");
});

test("does not misclassify a distro that merely contains a vendor keyword as a substring", () => {
  // Classification is exact-match against the vendor id list, not a substring
  // scan: a custom distro string that merely embeds "cisco"/"huawei" must NOT
  // be treated as a network device (guards against a false positive that would
  // send raw, shell-unwrapped commands to a real POSIX host).
  for (const distro of ["cisco-lab-server", "my-huawei-cloud", "cisco linux", "fortinet-vm"]) {
    const info = buildAITerminalSessionInfo(
      baseSession(),
      baseHost({ distro }),
      "linux",
    );
    assert.notEqual(info.deviceType, "network", `distro "${distro}" should not be network`);
  }
});

test("suppresses network deviceType for Mosh sessions", () => {
  const info = buildAITerminalSessionInfo(
    baseSession({ moshEnabled: true }),
    baseHost({ distro: "huawei", deviceType: "network" }),
    "linux",
  );
  assert.equal(info.deviceType, undefined);
});

test("suppresses network deviceType for ET sessions", () => {
  const info = buildAITerminalSessionInfo(
    baseSession({ etEnabled: true }),
    baseHost({ deviceType: "network" }),
    "linux",
  );
  assert.equal(info.deviceType, undefined);
});
