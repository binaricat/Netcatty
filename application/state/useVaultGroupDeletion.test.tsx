import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { GroupConfig, ManagedSource } from "../../domain/models.ts";
import { useVaultGroupDeletion } from "./useVaultGroupDeletion.ts";

test("group deletion removes saved settings in the same Vault transaction", async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

  const storedGroups = ["Production", "Staging"];
  const storedSources: ManagedSource[] = [];
  const storedGroupConfigs: GroupConfig[] = [
    { path: "Production", username: "root" },
    { path: "Staging", username: "deploy" },
  ];
  let deleteGroups: ((paths: Iterable<string>) => Promise<void>) | undefined;
  let renderer: ReactTestRenderer | null = null;
  let committedGroupConfigs: GroupConfig[] = [];

  const Probe = () => {
    deleteGroups = useVaultGroupDeletion({
      customGroups: storedGroups,
      hosts: [],
      groupConfigs: storedGroupConfigs,
      managedSources: storedSources,
      onReadPersistedHosts: async () => [],
      onReadPersistedManagedSources: () => storedSources,
      onCommitVaultImportTransaction: async (
        _hosts,
        updateGroups,
        updateSources,
        updateGroupConfigs,
      ) => {
        committedGroupConfigs = updateGroupConfigs?.(storedGroupConfigs) ?? storedGroupConfigs;
        return {
          status: "persisted",
          groups: updateGroups(storedGroups),
          sources: updateSources(storedSources),
          groupConfigs: committedGroupConfigs,
        };
      },
    });
    return null;
  };

  try {
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    await act(async () => {
      await deleteGroups?.(["Production"]);
    });
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }

  assert.deepEqual(storedGroupConfigs.map((config) => config.path), ["Production", "Staging"]);
  assert.deepEqual(committedGroupConfigs, [{ path: "Staging", username: "deploy" }]);
});

test("group deletion restores managed files when the persisted Vault cannot be reread", async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

  const storedSources: ManagedSource[] = [{
    id: "managed-production",
    type: "ssh_config",
    filePath: "/tmp/managed-production.conf",
    groupName: "Production",
    lastSyncedAt: 1,
  }];
  let deleteGroups: ((paths: Iterable<string>) => Promise<void>) | undefined;
  let renderer: ReactTestRenderer | null = null;
  let readCount = 0;
  let restoreCount = 0;
  let commitCount = 0;

  const Probe = () => {
    deleteGroups = useVaultGroupDeletion({
      customGroups: ["Production"],
      hosts: [],
      groupConfigs: [],
      managedSources: storedSources,
      onReadPersistedHosts: async () => {
        readCount += 1;
        if (readCount > 1) throw new Error("saved hosts unreadable");
        return [];
      },
      onReadPersistedManagedSources: () => storedSources,
      onClearAndRemoveManagedSources: async () => async () => {
        restoreCount += 1;
      },
      onCommitVaultImportTransaction: async () => {
        commitCount += 1;
        return {
          status: "persisted",
          groups: [],
          sources: [],
          groupConfigs: [],
        };
      },
    });
    return null;
  };

  try {
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    let deletionError: unknown;
    try {
      await act(async () => {
        await deleteGroups?.(["Production"]);
      });
    } catch (error) {
      deletionError = error;
    }
    assert.match(String(deletionError), /saved hosts unreadable/);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }

  assert.equal(readCount, 2);
  assert.equal(restoreCount, 1);
  assert.equal(commitCount, 0);
});

test("group deletion retries file clearing when another managed source enters the group", async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

  const firstSource: ManagedSource = {
    id: "managed-first",
    type: "ssh_config",
    filePath: "/tmp/managed-first.conf",
    groupName: "Production",
    lastSyncedAt: 1,
  };
  const concurrentSource: ManagedSource = {
    id: "managed-concurrent",
    type: "ssh_config",
    filePath: "/tmp/managed-concurrent.conf",
    groupName: "Production",
    lastSyncedAt: 2,
  };
  let deleteGroups: ((paths: Iterable<string>) => Promise<void>) | undefined;
  let renderer: ReactTestRenderer | null = null;
  let sourceReadCount = 0;
  let restoreCount = 0;
  let commitCount = 0;
  const clearedSourceIds: string[][] = [];

  const Probe = () => {
    deleteGroups = useVaultGroupDeletion({
      customGroups: ["Production"],
      hosts: [],
      groupConfigs: [],
      managedSources: [firstSource],
      onReadPersistedHosts: async () => [],
      onReadPersistedManagedSources: () => {
        sourceReadCount += 1;
        return sourceReadCount === 1
          ? [firstSource]
          : [firstSource, concurrentSource];
      },
      onClearAndRemoveManagedSources: async (sources) => {
        clearedSourceIds.push(sources.map((source) => source.id).sort());
        return async () => {
          restoreCount += 1;
        };
      },
      onCommitVaultImportTransaction: async (
        _hosts,
        updateGroups,
        updateSources,
        updateGroupConfigs,
        expectedHosts,
      ) => {
        commitCount += 1;
        assert.deepEqual(expectedHosts, []);
        return {
          status: "persisted",
          groups: updateGroups(["Production"]),
          sources: updateSources([firstSource, concurrentSource]),
          groupConfigs: updateGroupConfigs?.([]) ?? [],
        };
      },
    });
    return null;
  };

  try {
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    await act(async () => {
      await deleteGroups?.(["Production"]);
    });
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }

  assert.deepEqual(clearedSourceIds, [
    ["managed-first"],
    ["managed-concurrent", "managed-first"],
  ]);
  assert.equal(restoreCount, 1);
  assert.equal(commitCount, 1);
});
