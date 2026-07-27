import assert from "node:assert/strict";
import test from "node:test";

import type { GroupConfig, Host, ManagedSource } from "./models.ts";
import { buildVaultGroupDeletion } from "./vaultGroupDeletion.ts";

const host = (id: string, group: string, managedSourceId?: string): Host => ({
  id,
  label: id,
  hostname: `${id}.example.com`,
  port: 22,
  username: "root",
  protocol: "ssh",
  tags: [],
  os: "linux",
  group,
  managedSourceId,
});

test("bulk group deletion collapses nested choices and updates related vault data once", () => {
  const managedSources: ManagedSource[] = [{
    id: "managed-a",
    type: "ssh_config",
    filePath: "/tmp/config",
    groupName: "A/Managed",
    lastSyncedAt: 1,
  }];
  const groupConfigs: GroupConfig[] = [
    { path: "A" },
    { path: "A/Sub" },
    { path: "B" },
    { path: "C" },
  ];

  const result = buildVaultGroupDeletion({
    selectedPaths: ["A/Sub", "B", "A"],
    deleteHosts: false,
    customGroups: ["A", "A/Sub", "A/Managed", "B", "C"],
    hosts: [
      host("a", "A"),
      host("managed", "A/Managed", "managed-a"),
      host("b", "B"),
      host("c", "C"),
    ],
    groupConfigs,
    managedSources,
  });

  assert.deepEqual(result.selectedRoots, ["A", "B"]);
  assert.deepEqual(result.customGroups, ["C"]);
  assert.deepEqual(result.hosts.map(({ id, group }) => ({ id, group })), [
    { id: "a", group: "" },
    { id: "b", group: "" },
    { id: "c", group: "C" },
  ]);
  assert.deepEqual(result.groupConfigs, [{ path: "C" }]);
  assert.deepEqual(result.sourcesToRemove, managedSources);
});

test("bulk group deletion can remove every host below the selected groups", () => {
  const result = buildVaultGroupDeletion({
    selectedPaths: ["A", "B"],
    deleteHosts: true,
    customGroups: ["A", "B", "C"],
    hosts: [host("a", "A/Sub"), host("b", "B"), host("c", "C")],
    groupConfigs: [],
    managedSources: [],
  });

  assert.deepEqual(result.hosts.map(({ id }) => id), ["c"]);
});

test("deleting a subgroup of a retained managed source keeps its source identity", () => {
  const result = buildVaultGroupDeletion({
    selectedPaths: ["Managed/Sub"],
    deleteHosts: false,
    customGroups: ["Managed", "Managed/Sub"],
    hosts: [host("managed-child", "Managed/Sub", "managed-root")],
    groupConfigs: [],
    managedSources: [{
      id: "managed-root",
      type: "ssh_config",
      filePath: "/tmp/config",
      groupName: "Managed",
      lastSyncedAt: 1,
    }],
  });

  assert.equal(result.hosts[0]?.group, "");
  assert.equal(result.hosts[0]?.managedSourceId, "managed-root");
  assert.deepEqual(result.sourcesToRemove, []);
});
