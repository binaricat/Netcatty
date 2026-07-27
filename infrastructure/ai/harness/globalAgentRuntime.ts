import { AgentRuntime } from './agentRuntime';
import { cattyTurnDriver } from './turnDrivers/cattyTurnDriver';
import { externalSdkTurnDriver } from './turnDrivers/externalSdkTurnDriver';
import { antigravityTurnDriver } from './turnDrivers/antigravityTurnDriver';

export const globalAgentRuntime = new AgentRuntime({
  drivers: [cattyTurnDriver, externalSdkTurnDriver, antigravityTurnDriver],
});

export function getAgentRuntime(): AgentRuntime {
  return globalAgentRuntime;
}
