import type { ExternalAgentConfig } from "../../infrastructure/ai/types";
import { getExternalAgentSdkBackend } from "../../infrastructure/ai/managedAgents";

export function findEnabledExternalAgent(
  agents: ExternalAgentConfig[],
  agentId: string,
): ExternalAgentConfig | undefined {
  return agents.find((agent) => agent.id === agentId && agent.enabled && Boolean(getExternalAgentSdkBackend(agent)));
}

export function canSendWithAgent(
  agentId: string,
  agents: ExternalAgentConfig[],
): boolean {
  return agentId === "catty" || Boolean(findEnabledExternalAgent(agents, agentId));
}
