import { useCallback, useEffect, useRef } from 'react';
import type { Snippet } from '@/domain/models';
import { snippetAppliesToHost } from '@/domain/snippetTargets.ts';
import { isScriptSnippet } from '@/domain/snippetScript.ts';
import { netcattyBridge } from '@/infrastructure/services/netcattyBridge.ts';
import { getActiveScriptRunForSession, subscribeScriptRuns } from '@/application/state/scriptAutomationCoordinator.ts';

type OutputTriggerContext = {
  sessionId: string;
  hostId?: string;
  snippets: Snippet[];
  onRunScript: (snippet: Snippet, sessionId: string) => void;
};

function isSessionScriptRunActive(sessionId: string): boolean {
  return Boolean(getActiveScriptRunForSession(sessionId));
}

export function useOutputTriggers({
  sessionId,
  hostId,
  snippets,
  onRunScript,
}: OutputTriggerContext) {
  const bufferRef = useRef('');
  const firedRef = useRef(new Set<string>());
  const hadActiveScriptRef = useRef(false);

  const scanBuffer = useCallback(() => {
    if (isSessionScriptRunActive(sessionId)) {
      return;
    }

    const text = bufferRef.current;

    for (const snippet of snippets) {
      if (!isScriptSnippet(snippet) || snippet.trigger !== 'onOutput' || !snippet.triggerPattern || !snippet.id) {
        continue;
      }
      if (!snippetAppliesToHost(snippet, hostId)) continue;
      const key = `snippet:${sessionId}:${snippet.id}`;
      if (firedRef.current.has(key)) continue;
      try {
        const regex = new RegExp(snippet.triggerPattern);
        if (regex.test(text)) {
          firedRef.current.add(key);
          onRunScript(snippet, sessionId);
        }
      } catch {
        // ignore invalid regex
      }
    }
  }, [hostId, onRunScript, sessionId, snippets]);

  const appendOutput = useCallback((chunk: string) => {
    bufferRef.current = (bufferRef.current + chunk).slice(-8192);
    scanBuffer();
  }, [scanBuffer]);

  useEffect(() => {
    firedRef.current.clear();
    bufferRef.current = '';
    hadActiveScriptRef.current = isSessionScriptRunActive(sessionId);
  }, [sessionId, hostId]);

  useEffect(() => {
    return subscribeScriptRuns((runs) => {
      const active = runs.some((run) =>
        run.sessionId === sessionId && (run.status === 'running' || run.status === 'paused'),
      );
      if (hadActiveScriptRef.current && !active) {
        scanBuffer();
      }
      hadActiveScriptRef.current = active;
    });
  }, [scanBuffer, sessionId]);

  return { appendOutput };
}

export function setupScriptBridgeListeners(
  getSnapshot: (sessionId: string) => ReturnType<typeof import('@/infrastructure/scripts/screenSnapshotRegistry.ts').captureScreenSnapshot>,
) {
  const disposers: Array<() => void> = [];

  disposers.push(
    netcattyBridge.get()?.onScriptScreenSnapshotRequest?.(({ requestId, sessionId }) => {
      const snapshot = getSnapshot(sessionId);
      void netcattyBridge.get()?.scriptScreenSnapshotResponse?.(requestId, snapshot);
    }) ?? (() => {}),
  );

  return () => {
    disposers.forEach((dispose) => dispose());
  };
}
