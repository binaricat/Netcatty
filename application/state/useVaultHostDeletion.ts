import { useCallback } from 'react';

import type { VaultGroupMutationResult, VaultGroupMutationState } from '../../domain/vaultGroupMutation';
import { pruneVaultJumpHostReferences } from '../../domain/vaultJumpGraph';

export function useVaultHostDeletion(
  commit: (
    mutate: (current: VaultGroupMutationState) => VaultGroupMutationResult,
  ) => Promise<VaultGroupMutationResult | { ok: false; superseded: true }>,
) {
  return useCallback(async (hostIds: Iterable<string>) => {
    const removedHostIds = new Set(hostIds);
    if (removedHostIds.size === 0) return;
    const result = await commit((current) => {
      const pruned = pruneVaultJumpHostReferences({
        hosts: current.hosts.filter((host) => !removedHostIds.has(host.id)),
        groupConfigs: current.configs,
        removedHostIds,
      });
      return {
        ok: true,
        state: { ...current, hosts: pruned.hosts, configs: pruned.groupConfigs },
      };
    });
    if (!result.ok) {
      throw new Error('error' in result ? result.error : 'Host deletion was superseded. Try again.');
    }
  }, [commit]);
}
