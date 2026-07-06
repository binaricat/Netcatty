import type { Host } from "./models";

/**
 * True when the host entry represents a persisted vault host. Ephemeral
 * hosts (password deep links) live in the terminal host list but must not
 * be treated as saved hosts for persistence-routing decisions.
 */
export const isSavedVaultHost = (host: Host | null | undefined): boolean =>
  Boolean(host) && host?.ephemeral !== true;

export interface EphemeralHostsUpdateSplit {
  vaultHosts: Host[];
  ephemeralHosts: Host[];
}

export const splitHostsUpdateByEphemeral = (
  nextHosts: Host[],
  ephemeralHostIds: ReadonlySet<string>,
): EphemeralHostsUpdateSplit => {
  const vaultHosts: Host[] = [];
  const ephemeralHosts: Host[] = [];
  for (const host of nextHosts) {
    if (ephemeralHostIds.has(host.id)) {
      ephemeralHosts.push(host);
    } else {
      vaultHosts.push(host);
    }
  }
  return { vaultHosts, ephemeralHosts };
};

export const applyEphemeralHostsUpdate = (
  previous: Host[],
  updated: Host[],
): Host[] => {
  if (updated.length === 0) return previous;
  const updatedById = new Map(updated.map((host) => [host.id, host]));
  return previous.map((host) => updatedById.get(host.id) ?? host);
};
