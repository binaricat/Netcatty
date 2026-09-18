import { useCallback, useRef } from "react";

import type { GroupConfig, Host, ManagedSource } from "../../domain/models";
import { removeSnippetTargetGroupPaths } from "../../domain/hostGroupPathMutations";
import { buildVaultGroupDeletion } from "../../domain/vaultGroupDeletion";
import type {
  VaultGroupMutationResult,
  VaultGroupMutationState,
} from "../../domain/vaultGroupMutation";
import {
  type VaultLockHandle,
  withVaultImportLock,
} from "./vaultManagedImportLock";

const RETRY_VAULT_GROUP_DELETION = Symbol("retry-vault-group-deletion");

export class VaultGroupDeletionConfirmationChangedError extends Error {
  constructor() {
    super("The managed files affected by this deletion have changed. Review the files and confirm again.");
    this.name = "VaultGroupDeletionConfirmationChangedError";
  }
}

const managedSourceFileIdentity = (source: ManagedSource): string => (
  JSON.stringify([source.id, source.type, source.filePath])
);

const managedSourceSnapshotsMatch = (
  left: ManagedSource[],
  right: ManagedSource[],
): boolean => {
  const serialize = (sources: ManagedSource[]) => JSON.stringify(
    [...sources].sort((a, b) => a.id.localeCompare(b.id)),
  );
  return serialize(left) === serialize(right);
};

export function useVaultGroupDeletion({
  customGroups,
  hosts,
  groupConfigs,
  managedSources,
  onReadPersistedHosts,
  onReadPersistedManagedSources,
  onCommitVaultGroupMutation,
  onClearAndRemoveManagedSource,
  onClearAndRemoveManagedSources,
  onDeletedPaths,
}: {
  customGroups: string[];
  hosts: Host[];
  groupConfigs: GroupConfig[];
  managedSources: ManagedSource[];
  onReadPersistedHosts: () => Promise<Host[]>;
  onReadPersistedManagedSources: () => ManagedSource[];
  onCommitVaultGroupMutation: (
    mutate: (current: VaultGroupMutationState) => VaultGroupMutationResult,
    lock?: VaultLockHandle | null,
  ) => Promise<VaultGroupMutationResult | { ok: false; superseded: true }>;
  onClearAndRemoveManagedSource?: (source: ManagedSource) => Promise<() => Promise<void>>;
  onClearAndRemoveManagedSources?: (sources: ManagedSource[]) => Promise<() => Promise<void>>;
  onDeletedPaths?: (selectedRoots: string[]) => void;
}) {
  const latestRef = useRef({ customGroups, hosts, groupConfigs, managedSources });
  latestRef.current = { customGroups, hosts, groupConfigs, managedSources };

  return useCallback(async (
    paths: Iterable<string>,
    deleteHosts: boolean = false,
    additionallyDeletedHostIds: ReadonlySet<string> = new Set(),
  ) => {
    const selectedPaths = [...paths];
    // Bind confirmation to the sources rendered with this callback, not the
    // latest persisted snapshot (which reads and retries update independently).
    const confirmedFiles = new Set(buildVaultGroupDeletion({
      ...latestRef.current,
      selectedPaths,
      deleteHosts,
      managedSources,
    }).sourcesToRemove.map(managedSourceFileIdentity));
    let deletedRoots: string[] = [];
    while (true) {
      let restoreManagedFiles: (() => Promise<void>) | undefined;
      try {
        const outcome = await withVaultImportLock("vault", async (lock) => {
          const [latestHosts, latestManagedSources] = await Promise.all([
            onReadPersistedHosts(),
            Promise.resolve(onReadPersistedManagedSources()),
          ]);
          latestRef.current = {
            ...latestRef.current,
            hosts: latestHosts,
            managedSources: latestManagedSources,
          };
          let deletion = buildVaultGroupDeletion({
            selectedPaths,
            deleteHosts,
            ...latestRef.current,
          });
          if (deletion.selectedRoots.length === 0) {
            return { status: "empty" as const };
          }

          if (deletion.sourcesToRemove.some((source) => (
            !confirmedFiles.has(managedSourceFileIdentity(source))
          ))) {
            throw new VaultGroupDeletionConfirmationChangedError();
          }

          if (deletion.sourcesToRemove.length > 0) {
            if (onClearAndRemoveManagedSources) {
              restoreManagedFiles = await onClearAndRemoveManagedSources(deletion.sourcesToRemove);
            } else if (onClearAndRemoveManagedSource) {
              const restores = await Promise.all(
                deletion.sourcesToRemove.map((source) => onClearAndRemoveManagedSource(source)),
              );
              restoreManagedFiles = async () => {
                await Promise.all(restores.map((restore) => restore()));
              };
            }
          }

          latestRef.current = {
            ...latestRef.current,
            hosts: await onReadPersistedHosts(),
            managedSources: onReadPersistedManagedSources(),
          };
          const refreshedDeletion = buildVaultGroupDeletion({
            selectedPaths,
            deleteHosts,
            ...latestRef.current,
          });
          if (!managedSourceSnapshotsMatch(
            deletion.sourcesToRemove,
            refreshedDeletion.sourcesToRemove,
          )) {
            throw RETRY_VAULT_GROUP_DELETION;
          }
          deletion = refreshedDeletion;

          const expectedSources = deletion.sourcesToRemove;
          const transaction = await onCommitVaultGroupMutation(
            (current) => {
              const currentDeletion = buildVaultGroupDeletion({
                selectedPaths,
                deleteHosts,
                customGroups: current.groups,
                hosts: current.hosts,
                groupConfigs: current.configs,
                managedSources: current.managedSources,
              });
              if (!managedSourceSnapshotsMatch(
                expectedSources,
                currentDeletion.sourcesToRemove,
              )) {
                throw RETRY_VAULT_GROUP_DELETION;
              }
              return {
                ok: true,
                state: {
                  groups: currentDeletion.customGroups,
                  hosts: currentDeletion.hosts.filter(
                    (host) => !additionallyDeletedHostIds.has(host.id),
                  ),
                  configs: currentDeletion.groupConfigs,
                  managedSources: current.managedSources.filter(
                    (source) => !currentDeletion.sourcesToRemove.some(
                      (removed) => removed.id === source.id,
                    ),
                  ),
                  snippets: removeSnippetTargetGroupPaths(
                    current.snippets,
                    currentDeletion.selectedRoots,
                  ),
                },
              };
            },
            lock,
          );
          if (!transaction.ok && "superseded" in transaction) {
            // Release the lock so concurrent saves can finish before retry.
            return { status: "retry" as const, restoreManagedFiles };
          }
          if ("error" in transaction) {
            throw new Error(transaction.error);
          }
          latestRef.current = {
            customGroups: transaction.state.groups,
            hosts: transaction.state.hosts,
            groupConfigs: transaction.state.configs,
            managedSources: transaction.state.managedSources,
          };
          return {
            status: "done" as const,
            deletedRoots: deletion.selectedRoots,
          };
        });

        if (outcome.status === "empty") {
          onDeletedPaths?.([]);
          return;
        }
        if (outcome.status === "retry") {
          await outcome.restoreManagedFiles?.();
          // Drain concurrent locked writes outside the critical section.
          await onReadPersistedHosts();
          continue;
        }
        deletedRoots = outcome.deletedRoots;
        break;
      } catch (error) {
        await restoreManagedFiles?.();
        if (error === RETRY_VAULT_GROUP_DELETION) {
          await onReadPersistedHosts();
          continue;
        }
        throw error;
      }
    }
    onDeletedPaths?.(deletedRoots);
  }, [
    managedSources,
    onClearAndRemoveManagedSource,
    onClearAndRemoveManagedSources,
    onCommitVaultGroupMutation,
    onDeletedPaths,
    onReadPersistedHosts,
    onReadPersistedManagedSources,
  ]);
}
