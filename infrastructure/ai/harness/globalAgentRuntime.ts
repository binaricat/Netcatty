import { AgentRuntime } from './agentRuntime';
import { cattyTurnDriver } from './turnDrivers/cattyTurnDriver';
import { externalSdkTurnDriver } from './turnDrivers/externalSdkTurnDriver';

export const globalAgentRuntime = new AgentRuntime({
  drivers: [cattyTurnDriver, externalSdkTurnDriver],
});

export function getAgentRuntime(): AgentRuntime {
  return globalAgentRuntime;
}
