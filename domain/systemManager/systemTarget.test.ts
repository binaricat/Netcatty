import assert from "node:assert/strict";
import test from "node:test";

import {
  allowSystemManagerMutations,
  buildSystemManagerTabs,
  shouldCollectServerStats,
  shouldShowGpuTab,
  shouldShowPortsTab,
  shouldShowProcessesTab,
  shouldShowServicesTab,
} from "./systemTarget.ts";
import type { SessionCapabilities } from "./types.ts";

function caps(partial: Partial<SessionCapabilities> = {}): SessionCapabilities {
  return {
    targetOs: "linux",
    hasTmux: false,
    hasDocker: false,
    hasNvidiaSmi: false,
    hasNpuSmi: false,
    hasSs: false,
    hasNetstat: false,
    hasLsof: false,
    hasSystemctl: false,
    probedAt: 1,
    ...partial,
  };
}

test("system manager shows overview before detailed management tabs", () => {
  assert.deepEqual(buildSystemManagerTabs(null, undefined, null), ["overview", "processes"]);
});

test("gpu tab appears only after nvidia-smi or npu-smi is detected", () => {
  assert.equal(shouldShowGpuTab(undefined), false);
  assert.equal(shouldShowGpuTab(caps()), false);
  assert.equal(shouldShowGpuTab(caps({ hasNvidiaSmi: true })), true);

  const host = {
    id: "host-gpu",
    label: "GPU",
    hostname: "gpu.local",
    username: "root",
    tags: [],
    os: "linux" as const,
  };
  assert.deepEqual(
    buildSystemManagerTabs(host, caps({
      hasTmux: true,
      hasDocker: true,
      hasNpuSmi: true,
      hasSs: true,
      hasSystemctl: true,
    }), null),
    ["overview", "processes", "ports", "services", "tmux", "docker", "gpu"],
  );
});

test("ports and services tabs are detect-first like GPU", () => {
  assert.equal(shouldShowPortsTab(undefined), false);
  assert.equal(shouldShowPortsTab(caps({ hasSs: true })), true);
  assert.equal(shouldShowPortsTab(caps({ hasNetstat: true })), true);
  assert.equal(shouldShowPortsTab(caps({ hasLsof: true })), true);
  assert.equal(shouldShowServicesTab(undefined), false);
  assert.equal(shouldShowServicesTab(caps({ hasSystemctl: true })), true);
});

test("network appliances keep Ports/Services read-only", () => {
  const host = {
    id: "host-1",
    label: "Router",
    hostname: "router.local",
    username: "admin",
    tags: [],
    os: "linux" as const,
    deviceType: "network" as const,
  };
  assert.equal(allowSystemManagerMutations(host), false);
  assert.equal(allowSystemManagerMutations({
    id: "host-2",
    label: "Linux",
    hostname: "linux.local",
    username: "root",
    tags: [],
    os: "linux" as const,
  }), true);
});

test("network devices hide processes until OS probe confirms a real target", () => {
  const host = {
    id: "host-1",
    label: "Router",
    hostname: "router.local",
    username: "admin",
    tags: [],
    os: "linux" as const,
    deviceType: "network" as const,
  };
  assert.equal(shouldShowProcessesTab(host, undefined), false);
  assert.deepEqual(buildSystemManagerTabs(host, undefined, null), ["overview"]);
  assert.equal(shouldShowProcessesTab(host, caps({ targetOs: "linux" })), true);
  assert.deepEqual(
    buildSystemManagerTabs(host, caps({ targetOs: "linux", hasSs: true }), null),
    ["overview", "processes", "ports"],
  );
});

test("system overview stats skip network devices even when a Linux icon was selected", () => {
  assert.equal(
    shouldCollectServerStats(
      {
        id: "host-1",
        label: "Router",
        hostname: "router.local",
        username: "admin",
        tags: [],
        os: "linux",
        deviceType: "network",
      },
      undefined,
      null,
    ),
    false,
  );
});

test("system overview stats run for Linux and macOS targets", () => {
  assert.equal(
    shouldCollectServerStats(
      {
        id: "host-1",
        label: "Linux",
        distro: "ubuntu",
        hostname: "linux.local",
        username: "root",
        tags: [],
        os: "linux",
      },
      undefined,
      null,
    ),
    true,
  );
  assert.equal(
    shouldCollectServerStats(
      {
        id: "host-2",
        label: "Mac",
        hostname: "mac.local",
        username: "root",
        tags: [],
        os: "macos",
      },
      undefined,
      null,
    ),
    true,
  );
});

test("FreeBSD icon detection does not enable unsupported system features", () => {
  const host = {
    id: "host-3",
    label: "FreeBSD",
    hostname: "freebsd.local",
    username: "root",
    tags: [],
    os: "linux" as const,
    distro: "freebsd",
  };

  assert.equal(shouldCollectServerStats(host, undefined, null), false);
  assert.deepEqual(buildSystemManagerTabs(host, undefined, null), ["overview", "processes"]);
});

test('default Linux and cosmetic icons cannot enable Linux commands before detection', () => {
  const host = {id:'unknown', label:'Host', hostname:'host', username:'user', tags:[], os:'linux' as const, manualDistro:'ubuntu', distroMode:'manual' as const};
  assert.equal(shouldCollectServerStats(host, undefined, null), false);
  assert.deepEqual(buildSystemManagerTabs(host, undefined, null), ['overview','processes']);
  assert.equal(shouldCollectServerStats({...host,distro:'ubuntu'},undefined,null),true);
  assert.equal(shouldCollectServerStats({...host,distro:'ubuntu',osOverride:'windows'},undefined,null),false);
});
