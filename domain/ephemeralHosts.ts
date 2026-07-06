import type { Host } from "./models";

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
