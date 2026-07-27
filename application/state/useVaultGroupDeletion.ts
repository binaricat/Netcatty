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
    await withVaultImportLock("vault", async (lock) => {
      let deletedRoots: string[] = [];
      while (true) {
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
        if (deletion.selectedRoots.length === 0) return;

        let restoreManagedFiles: (() => Promise<void>) | undefined;
        try {
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

          // Rebuild after the file operations so edits made while they were running
          // are preserved, then publish one coherent in-memory baseline for any
          // deletion already queued behind this one.
          while (true) {
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
              const [refreshedHosts, refreshedSources] = await Promise.all([
                onReadPersistedHosts(),
                Promise.resolve(onReadPersistedManagedSources()),
              ]);
              latestRef.current = {
                ...latestRef.current,
                hosts: refreshedHosts,
                managedSources: refreshedSources,
              };
              const retriedDeletion = buildVaultGroupDeletion({
                selectedPaths,
                deleteHosts,
                ...latestRef.current,
              });
              if (!managedSourceSnapshotsMatch(
                expectedSources,
                retriedDeletion.sourcesToRemove,
              )) {
                throw RETRY_VAULT_GROUP_DELETION;
              }
              deletion = retriedDeletion;
              continue;
            }
            latestRef.current = {
              customGroups: transaction.groups,
              hosts: nextHosts,
              groupConfigs: transaction.groupConfigs,
              managedSources: transaction.sources,
            };
            deletedRoots = deletion.selectedRoots;
            break;
          }
          break;
        } catch (error) {
          await restoreManagedFiles?.();
          if (error === RETRY_VAULT_GROUP_DELETION) continue;
          throw error;
        }
      }
      onDeletedPaths?.(deletedRoots);
    });
  }, [
    onClearAndRemoveManagedSource,
    onClearAndRemoveManagedSources,
    onCommitVaultImportTransaction,
    onDeletedPaths,
    onReadPersistedHosts,
    onReadPersistedManagedSources,
  ]);
}
