import { AgentRuntime } from './agentRuntime';
import { registerAgentRuntimeCleanup } from './agentRuntimeHandle';
import { cattyTurnDriver } from './turnDrivers/cattyTurnDriver';
import { externalSdkTurnDriver } from './turnDrivers/externalSdkTurnDriver';

export const globalAgentRuntime = new AgentRuntime({
  drivers: [cattyTurnDriver, externalSdkTurnDriver],
});
registerAgentRuntimeCleanup(globalAgentRuntime);

export function getAgentRuntime(): AgentRuntime {
  return globalAgentRuntime;
}
