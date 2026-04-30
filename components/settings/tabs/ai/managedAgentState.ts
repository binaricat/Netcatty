import type { ExternalAgentConfig } from "../../../../infrastructure/ai/types";
import {
  type ManagedAgentKey,
} from "../../../../infrastructure/ai/managedAgents";
import type { AgentPathInfo } from "./types";
import { AGENT_DEFAULTS } from "./types";

function isPathLikeCommand(command: string | undefined): boolean {
  const normalized = String(command || "").trim();
  return normalized.includes("/") || normalized.includes("\\");
}

function getAutoManagedAgentStoredPath(
  agents: ExternalAgentConfig[],
  agentKey: ManagedAgentKey,
): string | null {
  const managed = agents.find((agent) => agent.id === `discovered_${agentKey}`);
  return isPathLikeCommand(managed?.command) ? managed?.command ?? null : null;
}

export function areExternalAgentListsEqual(
  left: ExternalAgentConfig[],
  right: ExternalAgentConfig[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((agent, index) => JSON.stringify(agent) === JSON.stringify(right[index]));
}

export function buildManagedAgentState(
  prevAgents: ExternalAgentConfig[],
  defaultAgentId: string,
  agentKey: ManagedAgentKey,
  pathInfo: AgentPathInfo | null,
): { agents: ExternalAgentConfig[]; defaultAgentId: string } {
  const managedId = `discovered_${agentKey}`;
  const managedAgents = prevAgents.filter((agent) => agent.id === managedId);
  const otherAgents = prevAgents.filter((agent) => agent.id !== managedId);

  if (!pathInfo?.available || !pathInfo.path) {
    return {
      agents: otherAgents,
      defaultAgentId: managedAgents.some((agent) => agent.id === defaultAgentId)
        ? "catty"
        : defaultAgentId,
    };
  }

  const existingManaged = managedAgents.find((agent) => agent.id === managedId);
  const defaults = AGENT_DEFAULTS[agentKey];
  const nextManagedAgent: ExternalAgentConfig = {
    ...existingManaged,
    ...defaults,
    id: managedId,
    command: pathInfo.path,
    enabled: managedAgents.length === 0 ? true : managedAgents.some((agent) => agent.enabled),
  };

  return {
    agents: [...otherAgents, nextManagedAgent],
    defaultAgentId: managedAgents.some((agent) => agent.id === defaultAgentId)
      ? managedId
      : defaultAgentId,
  };
}

export function getInitialManagedAgentPaths(agents: ExternalAgentConfig[]) {
  return {
    codex: getAutoManagedAgentStoredPath(agents, "codex") ?? "",
    claude: getAutoManagedAgentStoredPath(agents, "claude") ?? "",
    copilot: getAutoManagedAgentStoredPath(agents, "copilot") ?? "",
  };
}
