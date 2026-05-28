export function removeProviderReferences(
  removedProviderId: string,
  agentProviderMap: Record<string, string>,
  agentModelMap: Record<string, string>,
): {
  agentProviderMap: Record<string, string>;
  agentModelMap: Record<string, string>;
  providerMapChanged: boolean;
  modelMapChanged: boolean;
} {
  let providerMapChanged = false;
  let modelMapChanged = false;
  const orphanedAgents = new Set<string>();
  const nextAgentProviderMap: Record<string, string> = {};

  for (const [agentId, providerId] of Object.entries(agentProviderMap)) {
    if (providerId === removedProviderId) {
      providerMapChanged = true;
      orphanedAgents.add(agentId);
    } else {
      nextAgentProviderMap[agentId] = providerId;
    }
  }

  const nextAgentModelMap: Record<string, string> = { ...agentModelMap };
  for (const agentId of orphanedAgents) {
    if (agentId in nextAgentModelMap) {
      delete nextAgentModelMap[agentId];
      modelMapChanged = true;
    }
  }

  return {
    agentProviderMap: providerMapChanged ? nextAgentProviderMap : agentProviderMap,
    agentModelMap: modelMapChanged ? nextAgentModelMap : agentModelMap,
    providerMapChanged,
    modelMapChanged,
  };
}
