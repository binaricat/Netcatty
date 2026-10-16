import test from "node:test";
import assert from "node:assert/strict";

import { buildAITerminalSessionInfo } from "./buildAITerminalSessionInfo.ts";
import type { Host, TerminalSession } from "../types";

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

test("prefers a session custom name over the shared host label", () => {
  const info = buildAITerminalSessionInfo(
    baseSession({ customName: "Bastion - production" }),
    baseHost({ label: "Bastion" }),
    "linux",
  );
  assert.equal(info.label, "Bastion - production");
});

test("only saved remote hosts can receive persistent server approvals", () => {
  const saved = baseHost();
  assert.equal(buildAITerminalSessionInfo(baseSession(), saved, "linux", {
    allHosts: [saved],
  }).savedHostId, "h1");
  assert.equal(buildAITerminalSessionInfo(baseSession(), saved, "linux", {
    allHosts: [],
  }).savedHostId, undefined);
  const temporary = baseHost({ ephemeral: true });
  assert.equal(buildAITerminalSessionInfo(baseSession(), temporary, "linux", {
    allHosts: [temporary],
  }).savedHostId, undefined);
  assert.equal(buildAITerminalSessionInfo(baseSession({ protocol: "local" }), saved, "linux", {
    allHosts: [saved],
  }).savedHostId, undefined);
  assert.equal(buildAITerminalSessionInfo(baseSession({ protocol: "serial" }), saved, "linux", {
    allHosts: [saved],
  }).savedHostId, undefined);
});

test("exposes every live mapping of a multi-mapping port forward rule", () => {
  const rule = {
    id: "r1",
    label: "db tunnels",
    hostId: "h1",
    type: "local",
    localPort: 18080,
    remoteHost: "127.0.0.1",
    remotePort: 8080,
    bindAddress: "127.0.0.1",
    status: "partial",
    createdAt: 1,
    mappings: [
      { localPort: 18080, remotePort: 8080 },
      { localPort: 19090, remotePort: 9090 },
    ],
  } as unknown as import("./models.ts").PortForwardingRule;

  const info = buildAITerminalSessionInfo(
    baseSession(),
    baseHost(),
    "linux",
    { portForwardingRules: [rule] },
  );

  assert.deepEqual(
    info.activePortForwards?.map((forward) => forward.localPort).sort(),
    [18080, 19090],
  );
  assert.ok(info.activePortForwards?.every((forward) => forward.ruleId === "r1"));
});

test("dynamic and single-mapping rules keep their scalar context entry", () => {
  const dynamicRule = {
    id: "r2",
    label: "socks",
    hostId: "h1",
    type: "dynamic",
    localPort: 1080,
    bindAddress: "127.0.0.1",
    status: "active",
    createdAt: 1,
  } as unknown as import("./models.ts").PortForwardingRule;

  const info = buildAITerminalSessionInfo(
    baseSession(),
    baseHost(),
    "linux",
    { portForwardingRules: [dynamicRule] },
  );

  assert.deepEqual(
    info.activePortForwards?.map((forward) => ({ ruleId: forward.ruleId, localPort: forward.localPort })),
    [{ ruleId: "r2", localPort: 1080 }],
  );
});
