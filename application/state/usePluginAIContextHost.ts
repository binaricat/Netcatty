import { useEffect, useRef, useState } from 'react';
import type { TerminalSession, Workspace } from '../../domain/models';
import { getNotesSnapshot } from './notesStore';
import { useActiveTabId } from './activeTabStore';
import { getAppAppLockRuntime } from './appRuntimeBridge';
import type { createTrustedPluginAIHostRuntime } from '../../infrastructure/ai/plugin/trustedHostRuntime';
import { buildSelectedPluginSources } from '../../infrastructure/ai/plugin/selectedSources';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

export function usePluginAIContextHost({ sessions, workspaces }: { sessions: TerminalSession[]; workspaces: Workspace[] }) {
  const activeTabId = useActiveTabId();
  const latest = useRef({ activeTabId, sessions, workspaces });
  latest.current = { activeTabId, sessions, workspaces };
  const [choice, setChoice] = useState<{ confirm: (id: string) => void; cancel: () => void } | null>(null);
  const [noteId, setNoteId] = useState('');
  const [noteChoices, setNoteChoices] = useState<Array<{ id: string; title: string }>>([]);
  useEffect(() => {
    const api = netcattyBridge.get();
    if (!api?.onPluginAIHostRequest || !api.setPluginAIHostReady || !api.respondPluginAIHost) return;
    const bridge = {
      onPluginAIHostRequest: api.onPluginAIHostRequest.bind(api),
      setPluginAIHostReady: api.setPluginAIHostReady.bind(api),
      respondPluginAIHost: api.respondPluginAIHost.bind(api),
    };
    let selectedNoteId: string | null = null;
    let mounted = true;
    let chooser: { runtimeId: string; cancel: () => void } | null = null;
    const requests = new Map<string, { runtimeId: string; controller: AbortController }>();
    // The runtime pulls in the AI SDK providers (~1 MB with the Catty
    // harness). This host is mounted for every main window, so create it on
    // the first plugin AI request instead of at startup.
    type HostRuntime = ReturnType<typeof createTrustedPluginAIHostRuntime>;
    let runtime: HostRuntime | null = null;
    let runtimeLoading: Promise<HostRuntime> | null = null;
    const withLoadedRuntime = (apply: (loaded: HostRuntime) => void) => {
      if (runtime) apply(runtime);
      else void runtimeLoading?.then(apply, () => {});
    };
    const ensureRuntime = () => runtimeLoading ??= Promise.all([
      import('../../infrastructure/ai/plugin/trustedHostRuntime'),
      import('../../infrastructure/ai/plugin/configuredModel'),
    ]).then(([{ createTrustedPluginAIHostRuntime: createRuntime }, { getConfiguredPluginModel, prepareConfiguredPluginModel }]) => {
      runtime = createRuntime({
        getModel: getConfiguredPluginModel,
        prepareModel: prepareConfiguredPluginModel,
        isActive: () => mounted && document.visibilityState === 'visible' && getAppAppLockRuntime()?.locked === false,
        chooseSelected: (signal, runtimeId) => new Promise((resolve, reject) => {
          if (chooser) { reject(Error('A host selection is already pending')); return; }
          const finish = (id: string | null) => {
            if (chooser?.cancel !== cancel) return;
            chooser = null; signal.removeEventListener('abort', cancel); setChoice(null);
            if (id === null || signal.aborted) { reject(Error('Selection cancelled')); return; }
            selectedNoteId = id || null;
            resolve(buildSelectedPluginSources(() => ({ ...latest.current,
              note: getNotesSnapshot().notes.find((note) => note.id === selectedNoteId) ?? null })));
          };
          const cancel = () => finish(null);
          chooser = { runtimeId, cancel };
          signal.addEventListener('abort', cancel, { once: true });
          setNoteId('');
          // This inventory stays inside trusted host UI. The plugin receives
          // summaries only for the Note chosen here and current selected scopes.
          setNoteChoices(getNotesSnapshot().notes.map((note) => ({ id: note.id, title: note.title })));
          setChoice({ confirm: (id) => finish(id), cancel });
          if (signal.aborted) cancel();
        }),
      });
      if (!mounted) runtime.shutdown();
      return runtime;
    });
    const unsubscribe = bridge.onPluginAIHostRequest((request) => {
      if (request.kind === 'request.cancel') {
        requests.get(String(request.payload.requestId))?.controller.abort();
        return;
      }
      if (request.kind === 'runtime.release') {
        for (const pending of requests.values()) if (pending.runtimeId === request.runtimeId) pending.controller.abort();
        if (chooser?.runtimeId === request.runtimeId) chooser.cancel();
        withLoadedRuntime((loaded) => loaded.releaseRuntime(request.runtimeId));
        return;
      }
      if (requests.has(request.requestId) || requests.size >= 64) return;
      const controller = new AbortController();
      requests.set(request.requestId, { runtimeId: request.runtimeId, controller });
      void ensureRuntime().then((loaded) => {
        // Loading is async: re-check that the host and request are still live.
        if (!mounted || controller.signal.aborted) throw new Error('Plugin AI request is no longer active');
        return loaded.handle(request.kind, request.payload, request.runtimeId, controller.signal);
      }).then(
        (result) => bridge.respondPluginAIHost({ requestId: request.requestId, actionToken: request.actionToken, result }),
        () => bridge.respondPluginAIHost({ requestId: request.requestId, actionToken: request.actionToken, error: true }),
      ).catch(() => {}).finally(() => requests.delete(request.requestId));
    });
    const pageHide = () => { withLoadedRuntime((loaded) => loaded.shutdown()); for (const pending of requests.values()) pending.controller.abort(); };
    window.addEventListener('pagehide', pageHide);
    void bridge.setPluginAIHostReady(true).catch(() => {});
    return () => {
      mounted = false; chooser?.cancel(); unsubscribe(); window.removeEventListener('pagehide', pageHide);
      for (const pending of requests.values()) pending.controller.abort();
      requests.clear(); withLoadedRuntime((loaded) => loaded.shutdown());
      void bridge.setPluginAIHostReady(false).catch(() => {});
    };
  }, []);
  return { choice, noteId, setNoteId, noteChoices };
}
