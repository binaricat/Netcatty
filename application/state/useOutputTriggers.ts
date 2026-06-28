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
  onRunScript: (snippet: Snippet, sessionId: string) => void | Promise<void>;
};

function isSessionScriptRunActive(sessionId: string): boolean {
  return Boolean(getActiveScriptRunForSession(sessionId));
}

function waitForSessionScriptRunActive(sessionId: string, timeoutMs = 5000): Promise<boolean> {
  if (isSessionScriptRunActive(sessionId)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      unsubscribe();
      resolve(value);
    };
    const timeoutId = setTimeout(() => finish(false), timeoutMs);
    const unsubscribe = subscribeScriptRuns(() => {
      if (isSessionScriptRunActive(sessionId)) {
        finish(true);
      }
    });
  });
}

function waitForSessionScriptRunInactive(sessionId: string, timeoutMs = 3_600_000): Promise<void> {
  if (!isSessionScriptRunActive(sessionId)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      unsubscribe();
      resolve();
    };
    const timeoutId = setTimeout(finish, timeoutMs);
    const unsubscribe = subscribeScriptRuns(() => {
      if (!isSessionScriptRunActive(sessionId)) {
        finish();
      }
    });
  });
}

export function useOutputTriggers({
  sessionId,
  hostId,
  snippets,
  onRunScript,
}: OutputTriggerContext) {
  const bufferRef = useRef('');
  const launchingRef = useRef(false);

  const scanBuffer = useCallback((recentChunk: string) => {
    if (!recentChunk || isSessionScriptRunActive(sessionId) || launchingRef.current) {
      return;
    }

    const text = bufferRef.current;
    const newPortion = text.slice(-Math.max(recentChunk.length + 128, 256));

    for (const snippet of snippets) {
      if (isSessionScriptRunActive(sessionId) || launchingRef.current) {
        return;
      }
      if (!isScriptSnippet(snippet) || snippet.trigger !== 'onOutput' || !snippet.triggerPattern || !snippet.id) {
        continue;
      }
      if (!snippetAppliesToHost(snippet, hostId)) continue;
      try {
        const regex = new RegExp(snippet.triggerPattern);
        if (!regex.test(newPortion)) {
          continue;
        }
        launchingRef.current = true;
        void Promise.resolve(onRunScript(snippet, sessionId))
          .then(async () => {
            const started = await waitForSessionScriptRunActive(sessionId);
            if (started) {
              await waitForSessionScriptRunInactive(sessionId);
            }
          })
          .catch(() => {
            // Failed starts can retry on the next matching output chunk.
          })
          .finally(() => {
            launchingRef.current = false;
          });
        return;
      } catch {
        // ignore invalid regex
      }
    }
  }, [hostId, onRunScript, sessionId, snippets]);

  const appendOutput = useCallback((chunk: string) => {
    bufferRef.current = (bufferRef.current + chunk).slice(-8192);
    scanBuffer(chunk);
  }, [scanBuffer]);

  useEffect(() => {
    bufferRef.current = '';
    launchingRef.current = false;
  }, [sessionId, hostId]);

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
