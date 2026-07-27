import { useCallback, useRef } from "react";

import type { GroupConfig, Host, ManagedSource } from "../../domain/models";
import { buildVaultGroupDeletion } from "../../domain/vaultGroupDeletion";
import {
  type VaultLockHandle,
  withVaultImportLock,
} from "./vaultManagedImportLock";

const RETRY_VAULT_GROUP_DELETION = Symbol("retry-vault-group-deletion");

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
  onCommitVaultImportTransaction,
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
  onCommitVaultImportTransaction: (
    hosts: Host[],
    updateGroups: (current: string[]) => string[],
    updateSources: (current: ManagedSource[]) => ManagedSource[],
    updateGroupConfigs?: (current: GroupConfig[]) => GroupConfig[],
    expectedHosts?: Host[],
    lock?: VaultLockHandle | null,
  ) => Promise<
    | {
      status: "persisted";
      groups: string[];
      sources: ManagedSource[];
      groupConfigs: GroupConfig[];
    }
    | { status: "superseded" }
  >;
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

          const expectedHosts = latestRef.current.hosts;
          const expectedSources = deletion.sourcesToRemove;
          const nextHosts = deletion.hosts.filter(
            (host) => !additionallyDeletedHostIds.has(host.id),
          );
          const transaction = await onCommitVaultImportTransaction(
            nextHosts,
            (currentGroups) => buildVaultGroupDeletion({
              selectedPaths,
              deleteHosts,
              customGroups: currentGroups,
              hosts: [],
              groupConfigs: [],
              managedSources: [],
            }).customGroups,
            (currentSources) => {
              const currentDeletion = buildVaultGroupDeletion({
                selectedPaths,
                deleteHosts,
                customGroups: [],
                hosts: [],
                groupConfigs: [],
                managedSources: currentSources,
              });
              if (!managedSourceSnapshotsMatch(
                expectedSources,
                currentDeletion.sourcesToRemove,
              )) {
                throw RETRY_VAULT_GROUP_DELETION;
              }
              const removedIds = new Set(expectedSources.map((source) => source.id));
              return currentSources.filter((source) => !removedIds.has(source.id));
            },
            (currentGroupConfigs) => buildVaultGroupDeletion({
              selectedPaths,
              deleteHosts,
              customGroups: [],
              hosts: [],
              groupConfigs: currentGroupConfigs,
              managedSources: [],
            }).groupConfigs,
            expectedHosts,
            lock,
          );
          if (transaction.status === "superseded") {
            // Release the lock so concurrent host saves can finish before retry.
            return { status: "retry" as const, restoreManagedFiles };
          }
          latestRef.current = {
            customGroups: transaction.groups,
            hosts: nextHosts,
            groupConfigs: transaction.groupConfigs,
            managedSources: transaction.sources,
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
    onClearAndRemoveManagedSource,
    onClearAndRemoveManagedSources,
    onCommitVaultImportTransaction,
    onDeletedPaths,
    onReadPersistedHosts,
    onReadPersistedManagedSources,
  ]);
}
