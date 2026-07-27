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
