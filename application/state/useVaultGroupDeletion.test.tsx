import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { GroupConfig, ManagedSource } from "../../domain/models.ts";
import { useVaultGroupDeletion, VaultGroupDeletionConfirmationChangedError } from "./useVaultGroupDeletion.ts";

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
      onCommitVaultGroupMutation: async (mutate) => {
        const result = mutate({
          groups: storedGroups,
          configs: storedGroupConfigs,
          hosts: [],
          managedSources: storedSources,
          snippets: [],
        });
        if (result.ok) committedGroupConfigs = result.state.configs;
        return result;
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
      onCommitVaultGroupMutation: async () => {
        commitCount += 1;
        throw new Error("unexpected commit");
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

test("group deletion rejects retry when another managed source enters the group", async () => {
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
      onCommitVaultGroupMutation: async (mutate) => {
        commitCount += 1;
        return mutate({
          groups: ["Production"],
          configs: [],
          hosts: [],
          managedSources: [firstSource, concurrentSource],
          snippets: [],
        });
      },
    });
    return null;
  };

  try {
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    await act(async () => {
      await assert.rejects(deleteGroups!(["Production"]), VaultGroupDeletionConfirmationChangedError);
    });
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }

  assert.deepEqual(clearedSourceIds, [
    ["managed-first"],
  ]);
  assert.equal(restoreCount, 1);
  assert.equal(commitCount, 0);
});

test("group deletion restores managed files and does not report success when commit fails", async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

  const source: ManagedSource = {
    id: "managed-production",
    type: "ssh_config",
    filePath: "/tmp/managed-production.conf",
    groupName: "Production",
    lastSyncedAt: 1,
  };
  let deleteGroups: ((paths: Iterable<string>) => Promise<void>) | undefined;
  let renderer: ReactTestRenderer | null = null;
  let restoreCount = 0;
  let reportedCount = 0;

  const Probe = () => {
    deleteGroups = useVaultGroupDeletion({
      customGroups: ["Production"],
      hosts: [],
      groupConfigs: [],
      managedSources: [source],
      onReadPersistedHosts: async () => [],
      onReadPersistedManagedSources: () => [source],
      onClearAndRemoveManagedSources: async () => async () => {
        restoreCount += 1;
      },
      onCommitVaultGroupMutation: async () => {
        throw new Error("Vault quota exhausted");
      },
      onDeletedPaths: () => {
        reportedCount += 1;
      },
    });
    return null;
  };

  let deletionError: unknown;
  try {
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    try {
      await act(async () => {
        await deleteGroups?.(["Production"]);
      });
    } catch (error) {
      deletionError = error;
    }
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }

  assert.match(String(deletionError), /quota exhausted/i);
  assert.equal(restoreCount, 1);
  assert.equal(reportedCount, 0);
});

const confirmedSource: ManagedSource = {
  id: "managed-production",
  type: "ssh_config",
  filePath: "/tmp/managed-production.conf",
  groupName: "Production",
  lastSyncedAt: 1,
};

async function withDeletionProbe(
  options: Partial<Parameters<typeof useVaultGroupDeletion>[0]>,
  run: (getDelete: () => ReturnType<typeof useVaultGroupDeletion>, rerender: (sources: ManagedSource[]) => Promise<void>) => Promise<void>,
) {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: ReactTestRenderer | undefined;
  let deleteGroups!: ReturnType<typeof useVaultGroupDeletion>;
  const defaults: Parameters<typeof useVaultGroupDeletion>[0] = {
    customGroups: ["Production"], hosts: [], groupConfigs: [],
    managedSources: [confirmedSource],
    onReadPersistedHosts: async () => [],
    onReadPersistedManagedSources: () => [confirmedSource],
    onCommitVaultGroupMutation: async (mutate) => mutate({
      groups: ["Production"], configs: [], hosts: [],
      managedSources: [confirmedSource], snippets: [],
    }),
    ...options,
  };
  const Probe = ({ sources }: { sources: ManagedSource[] }) => {
    deleteGroups = useVaultGroupDeletion({ ...defaults, managedSources: sources });
    return null;
  };
  try {
    await act(async () => {
      renderer = create(<Probe sources={defaults.managedSources} />);
    });
    await run(() => deleteGroups, async (sources) => {
      await act(async () => { renderer!.update(<Probe sources={sources} />); });
    });
  } finally {
    await act(async () => { renderer?.unmount(); });
    environment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

for (const [name, rendered, persisted] of [
  ["changed file path", [confirmedSource], [{ ...confirmedSource, filePath: "/tmp/other.conf" }]],
  ["changed source id", [confirmedSource], [{ ...confirmedSource, id: "replacement" }]],
  ["added source", [confirmedSource], [confirmedSource, { ...confirmedSource, id: "added", filePath: "/tmp/added.conf" }]],
  ["first source", [], [confirmedSource]],
  ["source moved up within selection", [{ ...confirmedSource, groupName: "Production/Sub" }], [confirmedSource]],
  ["source moved into selection", [{ ...confirmedSource, groupName: "Staging" }], [confirmedSource]],
] as const) {
  test(`group deletion rejects initially persisted ${name} before clearing files`, async () => {
    let clearCount = 0;
    let commitCount = 0;
    let reportedCount = 0;
    await withDeletionProbe({
      managedSources: [...rendered],
      onReadPersistedManagedSources: () => [...persisted],
      onClearAndRemoveManagedSources: async () => {
        clearCount += 1;
        return async () => {};
      },
      onCommitVaultGroupMutation: async () => {
        commitCount += 1;
        throw new Error("unexpected commit");
      },
      onDeletedPaths: () => { reportedCount += 1; },
    }, async (getDelete) => {
      // A failed attempt refreshes latestRef without refreshing the warning.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(getDelete()(["Production"]), VaultGroupDeletionConfirmationChangedError);
      }
    });
    assert.equal(clearCount, 0);
    assert.equal(commitCount, 0);
    assert.equal(reportedCount, 0);
  });
}

test("group deletion keeps old callbacks bound to their rendered confirmation", async () => {
  const changed = { ...confirmedSource, filePath: "/tmp/changed.conf" };
  const cleared: string[] = [];
  await withDeletionProbe({
    onReadPersistedManagedSources: () => [changed],
    onClearAndRemoveManagedSources: async (sources) => {
      cleared.push(...sources.map((source) => source.filePath));
      return async () => {};
    },
    onCommitVaultGroupMutation: async (mutate) => mutate({
      groups: ["Production"], configs: [], hosts: [], managedSources: [changed], snippets: [],
    }),
  }, async (getDelete, rerender) => {
    const staleDelete = getDelete();
    await rerender([changed]);
    assert.notEqual(getDelete(), staleDelete);
    await assert.rejects(staleDelete(["Production"]), VaultGroupDeletionConfirmationChangedError);
    assert.deepEqual(cleared, []);
    await getDelete()(["Production"]);
  });
  assert.deepEqual(cleared, [changed.filePath]);
});

for (const retry of ["snapshot", "commit", "superseded"] as const) {
  test(`group deletion retains safe ${retry} retries for the same confirmed file`, async () => {
    const updated = { ...confirmedSource, lastSyncedAt: 2 };
    let reads = 0;
    let commits = 0;
    let restores = 0;
    let reported = 0;
    const cleared: string[] = [];
    await withDeletionProbe({
      onReadPersistedManagedSources: () => {
        reads += 1;
        return [retry === "snapshot" && reads > 1 ? updated : confirmedSource];
      },
      onClearAndRemoveManagedSources: async (sources) => {
        cleared.push(...sources.map((source) => source.filePath));
        return async () => { restores += 1; };
      },
      onCommitVaultGroupMutation: async (mutate) => {
        commits += 1;
        if (retry === "superseded" && commits === 1) return { ok: false, superseded: true };
        return mutate({
          groups: ["Production"], configs: [], hosts: [], snippets: [],
          managedSources: [retry === "snapshot" || (retry === "commit" && commits === 1) ? updated : confirmedSource],
        });
      },
      onDeletedPaths: () => { reported += 1; },
    }, async (getDelete) => { await getDelete()(["Production"]); });
    assert.deepEqual(cleared, [confirmedSource.filePath, confirmedSource.filePath]);
    assert.equal(restores, 1);
    assert.equal(commits, retry === "snapshot" ? 1 : 2);
    assert.equal(reported, 1);
  });
}

for (const retry of ["commit", "superseded"] as const) {
  test(`group deletion rejects new files after a ${retry} retry`, async () => {
    const added = { ...confirmedSource, id: "added", filePath: "/tmp/added.conf" };
    let persisted = [confirmedSource];
    let commits = 0;
    let restores = 0;
    let reported = 0;
    const cleared: string[] = [];
    await withDeletionProbe({
      onReadPersistedManagedSources: () => persisted,
      onClearAndRemoveManagedSources: async (sources) => {
        cleared.push(...sources.map((source) => source.filePath));
        return async () => { restores += 1; };
      },
      onCommitVaultGroupMutation: async (mutate) => {
        commits += 1;
        persisted = [confirmedSource, added];
        if (retry === "superseded") return { ok: false, superseded: true };
        return mutate({
          groups: ["Production"], configs: [], hosts: [], snippets: [], managedSources: persisted,
        });
      },
      onDeletedPaths: () => { reported += 1; },
    }, async (getDelete) => {
      await assert.rejects(getDelete()(["Production"]), VaultGroupDeletionConfirmationChangedError);
    });
    assert.deepEqual(cleared, [confirmedSource.filePath]);
    assert.equal(restores, 1);
    assert.equal(commits, 1);
    assert.equal(reported, 0);
  });
}

for (const phase of ["snapshot", "commit"] as const) {
  test(`group deletion rejects a managed subgroup moved to its parent during ${phase}`, async () => {
    const subgroup = { ...confirmedSource, groupName: "Production/Sub" };
    let persisted = [subgroup];
    let reads = 0;
    let restores = 0;
    let commits = 0;
    const cleared: string[] = [];
    await withDeletionProbe({
      managedSources: [subgroup],
      onReadPersistedManagedSources: () => {
        if (phase === "snapshot" && ++reads > 1) persisted = [confirmedSource];
        return persisted;
      },
      onClearAndRemoveManagedSources: async (sources) => {
        cleared.push(...sources.map((source) => source.groupName));
        return async () => { restores += 1; };
      },
      onCommitVaultGroupMutation: async (mutate) => {
        commits += 1;
        persisted = [confirmedSource];
        return mutate({
          groups: ["Production", "Production/Sub"], configs: [], hosts: [],
          managedSources: persisted, snippets: [],
        });
      },
    }, async (getDelete) => {
      await assert.rejects(getDelete()(["Production"]), VaultGroupDeletionConfirmationChangedError);
    });
    assert.deepEqual(cleared, ["Production/Sub"]);
    assert.equal(restores, 1);
    assert.equal(commits, phase === "snapshot" ? 0 : 1);
  });
}
