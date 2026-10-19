import assert from "node:assert/strict";
import test from "node:test";

import type { GroupConfig, Host } from "./models.ts";
import { pruneVaultJumpHostReferences } from "./vaultJumpGraph.ts";
import { applyGroupDefaults, resolveGroupDefaults } from "./groupConfig.ts";

const host = (id: string, hostIds?: string[]): Host => ({
  id,
  label: id,
  hostname: `${id}.example.com`,
  port: 22,
  username: "root",
  protocol: "ssh",
  tags: [],
  os: "linux",
  group: "",
  ...(hostIds ? { hostChain: { hostIds } } : {}),
});

test("pruning removes deleted hosts from other hosts' jump chains", () => {
  const hosts = [
    host("target", ["jump-a", "jump-b"]),
    host("other"),
  ];
  const result = pruneVaultJumpHostReferences({
    hosts,
    groupConfigs: [],
    removedHostIds: ["jump-a"],
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.hosts[0].hostChain, { hostIds: ["jump-b"] });
  assert.equal(result.hosts[1], hosts[1]);
});

test("pruning clears an empty chain and prunes group config chains", () => {
  const groupConfigs: GroupConfig[] = [
    { path: "A", hostChain: { hostIds: ["gone"] } },
    { path: "B" },
  ];
  const result = pruneVaultJumpHostReferences({
    hosts: [host("target", ["gone"])],
    groupConfigs,
    removedHostIds: ["gone"],
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.hosts[0].hostChain, { hostIds: [] });
  assert.deepEqual(result.groupConfigs[0].hostChain, { hostIds: [] });
  assert.equal(result.groupConfigs[1], groupConfigs[1]);
});

test("pruning keeps collections untouched when no chains reference removed hosts", () => {
  const hosts = [host("target", ["kept"]), host("chain-free")];
  const groupConfigs: GroupConfig[] = [{ path: "B" }];
  const result = pruneVaultJumpHostReferences({
    hosts,
    groupConfigs,
    removedHostIds: ["gone"],
  });

  assert.equal(result.changed, false);
  assert.equal(result.hosts, hosts);
  assert.equal(result.groupConfigs, groupConfigs);
});

test("removing a final explicit hop does not activate another inherited chain", () => {
  const result = pruneVaultJumpHostReferences({
    hosts: [{ ...host("target", ["gone"]), group: "Parent" },
      { ...host("inherited"), group: "Parent/Child" }],
    groupConfigs: [
      { path: "Parent", hostChain: { hostIds: ["kept"] } },
      { path: "Parent/Child", hostChain: { hostIds: ["gone"] } },
    ],
    removedHostIds: ["gone"],
  });
  for (const target of result.hosts) {
    const effective = applyGroupDefaults(target,
      resolveGroupDefaults(target.group!, result.groupConfigs));
    assert.deepEqual(effective.hostChain, { hostIds: [] });
  }
  assert.deepEqual(result.groupConfigs[0].hostChain, { hostIds: ["kept"] });
});
