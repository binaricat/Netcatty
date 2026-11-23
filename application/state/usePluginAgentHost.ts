import { useEffect, useRef, useState } from 'react';
import type { TerminalSession } from '../../domain/models';
import type { PluginAgentHostTerminal } from '@netcatty/plugin-contract';
import type { createTrustedPluginAgentRuntime } from '../../infrastructure/ai/pluginAgent/trustedAgentRuntime';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import { getAppAppLockRuntime } from './appRuntimeBridge';
import { LOCAL_STORAGE_ADAPTER_CHANGED_EVENT } from '../../infrastructure/persistence/localStorageAdapter';
import { STORAGE_KEY_AI_PROVIDERS, STORAGE_KEY_AI_ACTIVE_PROVIDER, STORAGE_KEY_AI_ACTIVE_MODEL, STORAGE_KEY_AI_AGENT_MODEL_MAP,
  STORAGE_KEY_AI_AGENT_PROVIDER_MAP, STORAGE_KEY_AI_EXTERNAL_AGENTS } from '../../infrastructure/config/storageKeys';

type Choice = { items: PluginAgentHostTerminal[]; confirm: (ids: string[]) => void; cancel: () => void };

// All inventory remains in trusted application UI. Only confirmed metadata is
// passed to the main-owned worker bindings; focus never determines a target.
export function usePluginAgentHost(sessions: TerminalSession[]) {
  const latest = useRef(sessions); latest.current = sessions;
  const [choice, setChoice] = useState<Choice | null>(null);
  useEffect(() => {
    const api = netcattyBridge.get();
    if (!api?.onPluginAgentHostRequest || !api.setPluginAgentHostReady || !api.respondPluginAgentHost) return;
    const bridge = { subscribe: api.onPluginAgentHostRequest.bind(api), ready: api.setPluginAgentHostReady.bind(api), respond: api.respondPluginAgentHost.bind(api) };
    let mounted = true;
    let chooser: { runtimeId: string; cancel: () => void } | null = null;
    const requests = new Map<string, { runtimeId: string; controller: AbortController }>();
    // The agent runtime pulls in the whole Catty harness and AI SDK. This host
    // is mounted for every main window, so create it on the first plugin agent
    // request instead of at startup; until then there is nothing to cancel,
    // release or invalidate.
    type AgentRuntime = ReturnType<typeof createTrustedPluginAgentRuntime>;
    let runtime: AgentRuntime | null = null;
    let runtimeLoading: Promise<AgentRuntime> | null = null;
    const withLoadedRuntime = (apply: (loaded: AgentRuntime) => void) => {
      if (runtime) apply(runtime);
      else void runtimeLoading?.then(apply, () => {});
    };
    const ensureRuntime = () => runtimeLoading ??= import('../../infrastructure/ai/pluginAgent/trustedAgentRuntime')
      .then(({ createTrustedPluginAgentRuntime: createRuntime }) => {
        runtime = createRuntime({
          isActive: () => mounted && document.visibilityState === 'visible' && getAppAppLockRuntime()?.locked === false,
          chooseTargets: (signal, runtimeId) => new Promise((resolve, reject) => {
            if (chooser) { reject(Error('A target selection is already pending')); return; }
            const items = latest.current.filter((item) => item.status === 'connected').map((item) => ({
              sessionId: item.id, hostId: item.hostId, hostname: (item.hostname || '').slice(0, 253),
              label: (item.customName || item.hostLabel || item.id).slice(0, 160),
              ...(item.protocol ? { protocol: item.protocol } : {}), ...(item.username ? { username: item.username.slice(0, 160) } : {}), connected: true,
            }));
            const finish = (ids: string[] | null) => {
              if (chooser?.cancel !== cancel) return;
              chooser = null; signal.removeEventListener('abort', cancel); setChoice(null);
              if (ids === null || signal.aborted || ids.length > 32 || new Set(ids).size !== ids.length) { reject(Error('Target selection cancelled')); return; }
              const selected = ids.map((id) => items.find((item) => item.sessionId === id));
              if (selected.some((item) => !item || !latest.current.some((session) => session.id === item.sessionId && session.status === 'connected'))) {
                reject(Error('Selected terminal is no longer connected')); return;
              }
              resolve(selected as PluginAgentHostTerminal[]);
            };
            const cancel = () => finish(null);
            chooser = { runtimeId, cancel }; signal.addEventListener('abort', cancel, { once: true });
            setChoice({ items, confirm: finish, cancel });
            if (signal.aborted) cancel();
          }),
        });
        if (!mounted) runtime.shutdown();
        return runtime;
      });
    const unsubscribe = bridge.subscribe((request) => {
      if (request.kind === 'request.cancel') {
        const pending = requests.get(request.payload.requestId);
        if (pending?.runtimeId === request.runtimeId) pending.controller.abort();
        withLoadedRuntime((loaded) => loaded.cancelRequest(request.payload.requestId, request.runtimeId)); return;
      }
      if (request.kind === 'runtime.release') {
        for (const item of requests.values()) if (item.runtimeId === request.runtimeId) item.controller.abort();
        if (chooser?.runtimeId === request.runtimeId) chooser.cancel();
        withLoadedRuntime((loaded) => loaded.releaseRuntime(request.runtimeId)); return;
      }
      if (request.kind === 'agent.close') { withLoadedRuntime((loaded) => loaded.releaseChat(request.payload.chatSessionId, request.runtimeId)); return; }
      if (requests.has(request.requestId) || requests.size >= 64) return;
      const controller = new AbortController(); requests.set(request.requestId, { runtimeId: request.runtimeId, controller });
      void ensureRuntime().then((loaded) => {
        // Loading is async: re-check that the host and request are still live.
        if (!mounted || controller.signal.aborted) throw new Error('Plugin agent request is no longer active');
        return loaded.handle(request, controller.signal);
      }).then(
        (result) => bridge.respond({ requestId: request.requestId, actionToken: request.actionToken, result }).catch(() =>
          bridge.respond({ requestId: request.requestId, actionToken: request.actionToken, error: true })),
        () => bridge.respond({ requestId: request.requestId, actionToken: request.actionToken, error: true }),
      ).catch(() => {}).finally(() => requests.delete(request.requestId));
    });
    const pageHide = () => { withLoadedRuntime((loaded) => loaded.shutdown()); for (const item of requests.values()) item.controller.abort(); };
    const configurationKeys = new Set([STORAGE_KEY_AI_PROVIDERS, STORAGE_KEY_AI_ACTIVE_PROVIDER, STORAGE_KEY_AI_ACTIVE_MODEL,
      STORAGE_KEY_AI_AGENT_MODEL_MAP, STORAGE_KEY_AI_AGENT_PROVIDER_MAP, STORAGE_KEY_AI_EXTERNAL_AGENTS]);
    const configurationChanged = (event: Event) => {
      const key = event.type === 'storage' ? (event as StorageEvent).key : (event as CustomEvent<{ key: string }>).detail?.key;
      if (key === null || (key && configurationKeys.has(key))) {
        withLoadedRuntime((loaded) => loaded.invalidateConfiguration());
        // Invalidate main-owned backend leases too, even with no event read in
        // flight. Re-advertising availability does not renew existing handles.
        void bridge.ready(false).then(() => { if (mounted) return bridge.ready(true); }).catch(() => {});
      }
    };
    window.addEventListener('pagehide', pageHide);
    window.addEventListener('storage', configurationChanged); window.addEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, configurationChanged);
    void bridge.ready(true).catch(() => {});
    return () => {
      mounted = false; chooser?.cancel(); unsubscribe(); window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('storage', configurationChanged); window.removeEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, configurationChanged);
      for (const item of requests.values()) item.controller.abort(); requests.clear(); withLoadedRuntime((loaded) => loaded.shutdown());
      void bridge.ready(false).catch(() => {});
    };
  }, []);
  return { choice };
}
