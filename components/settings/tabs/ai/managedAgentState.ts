import type { ExternalAgentConfig } from "../../../../infrastructure/ai/types";
import {
  type ManagedAgentKey,
} from "../../../../infrastructure/ai/managedAgents";
import type { AgentPathInfo } from "./types";
import { AGENT_DEFAULTS } from "./types";
import { buildCodebuddyEnv } from "./codebuddyConfigEnv";

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
    const existingManaged = managedAgents.find((agent) => agent.id === managedId);
    if (agentKey === "cursor" && existingManaged?.apiKey) {
      const defaults = AGENT_DEFAULTS[agentKey];
      const {
        acpCommand: _legacyCommand,
        acpArgs: _legacyArgs,
        ...existingManagedWithoutLegacy
      } = existingManaged;
      return {
        agents: [
          ...otherAgents,
          {
            ...existingManagedWithoutLegacy,
            ...defaults,
            id: managedId,
            command: pathInfo?.path || existingManaged.command || "cursor",
            enabled: false,
            available: false,
            apiKey: existingManaged.apiKey,
          },
        ],
        defaultAgentId: existingManaged.id === defaultAgentId ? "catty" : defaultAgentId,
      };
    }
    if (agentKey === "codebuddy") {
      if (existingManaged?.env && Object.keys(existingManaged.env).length > 0) {
        return {
          agents: [
            ...otherAgents,
            {
              ...existingManaged,
              ...AGENT_DEFAULTS.codebuddy,
              id: managedId,
              command: existingManaged.command || "codebuddy",
              enabled: false,
            },
          ],
          defaultAgentId: existingManaged.id === defaultAgentId ? "catty" : defaultAgentId,
        };
      }
    }
    return {
      agents: otherAgents,
      defaultAgentId: managedAgents.some((agent) => agent.id === defaultAgentId)
        ? "catty"
        : defaultAgentId,
    };
  }

  const existingManaged = managedAgents.find((agent) => agent.id === managedId);
  const {
    acpCommand: _legacyCommand,
    acpArgs: _legacyArgs,
    ...existingManagedWithoutLegacy
  } = existingManaged ?? {};
  const defaults = AGENT_DEFAULTS[agentKey];
  const managedEnv =
    agentKey === "claude"
      ? { ...(existingManaged?.env ?? {}), CLAUDE_CODE_EXECUTABLE: pathInfo.path }
      : agentKey === "codebuddy"
        ? { ...(existingManaged?.env ?? {}), CODEBUDDY_CODE_PATH: pathInfo.path }
        : existingManaged?.env;
  const nextManagedAgent: ExternalAgentConfig = {
    ...existingManagedWithoutLegacy,
    ...defaults,
    id: managedId,
    command: pathInfo.path,
    ...(managedEnv ? { env: managedEnv } : {}),
    available: true,
    enabled: managedAgents.length === 0
      || (agentKey === "codebuddy" && existingManaged && !isPathLikeCommand(existingManaged.command))
      ? true
      : managedAgents.some((agent) => agent.enabled) || managedAgents.every((agent) => agent.available === false),
  };

  return {
    agents: [...otherAgents, nextManagedAgent],
    defaultAgentId: managedAgents.some((agent) => agent.id === defaultAgentId)
      ? managedId
      : defaultAgentId,
  };
}

export function updateCodebuddyManagedEnv(
  prevAgents: ExternalAgentConfig[],
  internetEnv: string,
  envText: string,
): ExternalAgentConfig[] {
  const managedId = "discovered_codebuddy";
  const existingManaged = prevAgents.find((agent) => agent.id === managedId);
  const nextEnv = buildCodebuddyEnv(existingManaged?.env, internetEnv, envText);

  if (existingManaged) {
    if (!nextEnv && !isPathLikeCommand(existingManaged.command)) {
      return prevAgents.filter((agent) => agent.id !== managedId);
    }
    return prevAgents.map((agent) =>
      agent.id === managedId
        ? { ...agent, ...(nextEnv ? { env: nextEnv } : { env: undefined }) }
        : agent,
    );
  }

  if (!nextEnv) return prevAgents;

  return [
    ...prevAgents,
    {
      ...AGENT_DEFAULTS.codebuddy,
      id: managedId,
      command: "codebuddy",
      enabled: false,
      env: nextEnv,
    },
  ];
}

export function getInitialManagedAgentPaths(agents: ExternalAgentConfig[]) {
  return {
    codex: getAutoManagedAgentStoredPath(agents, "codex") ?? "",
    claude: getAutoManagedAgentStoredPath(agents, "claude") ?? "",
    copilot: getAutoManagedAgentStoredPath(agents, "copilot") ?? "",
    cursor: getAutoManagedAgentStoredPath(agents, "cursor") ?? "",
    codebuddy: getAutoManagedAgentStoredPath(agents, "codebuddy") ?? "",
  };
}
