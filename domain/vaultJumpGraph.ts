import type { GroupConfig, Host, HostChainConfig } from './models';

export type VaultJumpGraphIssue = {
  key: string;
  targetId: string;
  jumpHostId: string;
  kind: 'self' | 'missing' | 'protocol';
  error: string;
};

const identity = (host: Host): Host => host;

/**
 * Drop host-chain entries that point at hosts the user removed. Without this,
 * a deleted jump host stays referenced by its targets and connecting them
 * keeps failing with "A configured jump host is missing".
 */
export function pruneVaultJumpHostReferences({
  hosts,
  groupConfigs,
  removedHostIds,
}: {
  hosts: Host[];
  groupConfigs: GroupConfig[];
  removedHostIds: Iterable<string>;
}): {
  hosts: Host[];
  groupConfigs: GroupConfig[];
  changed: boolean;
} {
  const removed = removedHostIds instanceof Set
    ? removedHostIds
    : new Set(removedHostIds);
  if (removed.size === 0) return { hosts, groupConfigs, changed: false };

  const buildWithoutRemovedRefs = <Item extends { hostChain?: HostChainConfig }>(
    items: Item[],
  ): Item[] => {
    let next: Item[] | undefined;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const hostIds = item.hostChain?.hostIds;
      if (!hostIds?.length) continue;
      const nextHostIds = hostIds.filter((hostId) => !removed.has(hostId));
      if (nextHostIds.length === hostIds.length) continue;
      if (!next) next = items.slice();
      next[index] = {
        ...item,
        // Keep an explicit empty chain so a host/child group does not start
        // using a different inherited jump chain after its last hop is removed.
        hostChain: { hostIds: nextHostIds },
      };
    }
    return next ?? items;
  };

  const nextHosts = buildWithoutRemovedRefs(hosts);
  const nextGroupConfigs = buildWithoutRemovedRefs(groupConfigs);
  const changed = nextHosts !== hosts || nextGroupConfigs !== groupConfigs;
  return { hosts: nextHosts, groupConfigs: nextGroupConfigs, changed };
}

export function findVaultGroupConfigJumpReference(
  configs: GroupConfig[],
  hostId: string,
): GroupConfig | undefined {
  return configs.find((config) => config.hostChain?.hostIds?.includes(hostId));
}

export function collectVaultJumpGraphIssues(
  hosts: Host[],
  resolveEffectiveHost: (host: Host) => Host = identity,
): Map<string, VaultJumpGraphIssue> {
  const effectiveHosts = new Map(hosts.map((host) => [host.id, resolveEffectiveHost(host)]));
  const issues = new Map<string, VaultJumpGraphIssue>();

  for (const [targetId, target] of effectiveHosts) {
    for (const jumpHostId of target.hostChain?.hostIds ?? []) {
      if (jumpHostId === targetId) {
        const issue: VaultJumpGraphIssue = {
          key: `${targetId}:${jumpHostId}:self`,
          targetId,
          jumpHostId,
          kind: 'self',
          error: `Host "${targetId}" cannot use itself as an inherited jump host.`,
        };
        issues.set(issue.key, issue);
        continue;
      }

      const jumpHost = effectiveHosts.get(jumpHostId);
      if (!jumpHost) {
        const issue: VaultJumpGraphIssue = {
          key: `${targetId}:${jumpHostId}:missing`,
          targetId,
          jumpHostId,
          kind: 'missing',
          error: `Jump host "${jumpHostId}" was not found.`,
        };
        issues.set(issue.key, issue);
        continue;
      }

      if (jumpHost.protocol !== undefined && jumpHost.protocol !== 'ssh') {
        const issue: VaultJumpGraphIssue = {
          key: `${targetId}:${jumpHostId}:protocol`,
          targetId,
          jumpHostId,
          kind: 'protocol',
          error: `Jump host "${jumpHostId}" does not support SSH jump connections.`,
        };
        issues.set(issue.key, issue);
      }
    }
  }

  return issues;
}

export function findIntroducedVaultJumpGraphIssue(
  beforeHosts: Host[],
  afterHosts: Host[],
  resolveBefore: (host: Host) => Host = identity,
  resolveAfter: (host: Host) => Host = resolveBefore,
): VaultJumpGraphIssue | undefined {
  const previousIssues = collectVaultJumpGraphIssues(beforeHosts, resolveBefore);
  return [...collectVaultJumpGraphIssues(afterHosts, resolveAfter).values()]
    .find((issue) => !previousIssues.has(issue.key));
}
