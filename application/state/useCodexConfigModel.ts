import { useEffect, useMemo, useState } from 'react';
import { getNetcattyBridge } from '../../infrastructure/ai/aiChatStreamingSupport';
import { getManualAgentCommand, matchesManagedAgentConfig } from '../../infrastructure/ai/managedAgents';
import type { ExternalAgentConfig } from '../../infrastructure/ai/types';

/** Share the config probe between the picker and sends, scoped to this agent. */
export function useCodexConfigModel(agent: ExternalAgentConfig | undefined, isVisible: boolean) {
  const loadModel = useMemo(() => {
    let pending: Promise<string | null> | undefined;
    return () => {
      pending ??= Promise.resolve().then(async () => {
        if (!isVisible || !agent || !matchesManagedAgentConfig(agent, 'codex')) return null;
        const info = await getNetcattyBridge()?.aiCodexGetIntegration?.({
          codexPath: getManualAgentCommand(agent),
          agentEnv: agent.env,
        });
        return info?.customConfig?.model || null;
      }).catch(() => null);
      return pending;
    };
  // Reopening the panel refreshes config changed outside Netcatty.
  }, [agent, isVisible]);
  const [result, setResult] = useState<{ loadModel: typeof loadModel; model: string | null }>();
  useEffect(() => {
    if (!isVisible) return;
    let cancelled = false;
    void loadModel().then(model => {
      if (!cancelled) setResult({ loadModel, model });
    });
    return () => { cancelled = true; };
  }, [isVisible, loadModel]);
  return { model: result?.loadModel === loadModel ? result.model : null, loadModel };
}
