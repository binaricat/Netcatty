import { useCallback, useEffect, useRef } from 'react';
import type { Snippet } from '@/domain/models';
import { snippetAppliesToOutputTrigger } from '@/domain/snippetTargets.ts';
import { isScriptSnippet } from '@/domain/snippetScript.ts';
import { createTerminalOutputTriggerFilter } from '@/domain/terminalOutputTriggerFilter.ts';
import { netcattyBridge } from '@/infrastructure/services/netcattyBridge.ts';
import { getActiveScriptRunForSession } from '@/application/state/scriptAutomationCoordinator.ts';

type OutputTriggerContext = {
  sessionId: string;
  hostId?: string;
  snippets: Snippet[];
  onRunScript: (snippet: Snippet, sessionId: string) => void | Promise<void>;
};

function isSessionScriptRunActive(sessionId: string): boolean {
  return Boolean(getActiveScriptRunForSession(sessionId));
}

export function findMatchEndingAfter(text: string, pattern: string, minEndOffset: number): { value: string; endOffset: number } | null {
  const source = new RegExp(pattern);
  for (let startOffset = 0; startOffset <= text.length;) {
    const match = source.exec(text.slice(startOffset));
    if (!match || match.index === undefined) return null;
    const absoluteStart = startOffset + match.index;
    const absoluteEnd = absoluteStart + match[0].length;
    if (absoluteEnd > minEndOffset) {
      return { value: match[0], endOffset: absoluteEnd };
    }
    startOffset = Math.max(absoluteStart + 1, absoluteEnd);
  }
  return null;
}

export function useOutputTriggers({
  sessionId,
  hostId,
  snippets,
  onRunScript,
}: OutputTriggerContext) {
  const bufferRef = useRef('');
  const launchingRef = useRef(false);
  const lastTriggerMatchEndRef = useRef(new Map<string, number>());
  const serverOutputFilterRef = useRef(createTerminalOutputTriggerFilter());

  const scanBuffer = useCallback((recentChunk: string) => {
    if (!recentChunk || isSessionScriptRunActive(sessionId) || launchingRef.current) {
      return;
    }

    const text = bufferRef.current;
    const overlap = 64;
    const chunkWithOverlap = text.slice(Math.max(0, text.length - recentChunk.length - overlap));
    const chunkStartInSlice = Math.max(0, chunkWithOverlap.length - recentChunk.length);
    const chunkBaseOffset = text.length - chunkWithOverlap.length;

    for (const snippet of snippets) {
      if (isSessionScriptRunActive(sessionId) || launchingRef.current) {
        return;
      }
      if (!isScriptSnippet(snippet) || snippet.trigger !== 'onOutput' || !snippet.triggerPattern || !snippet.id) {
        continue;
      }
      if (!snippetAppliesToOutputTrigger(snippet, hostId)) continue;
      try {
        const matched = findMatchEndingAfter(chunkWithOverlap, snippet.triggerPattern, chunkStartInSlice);
        if (!matched) {
          continue;
        }
        const matchEnd = chunkBaseOffset + matched.endOffset;
        const lastMatchEnd = lastTriggerMatchEndRef.current.get(snippet.id) ?? -1;
        if (matchEnd <= lastMatchEnd) {
          continue;
        }
        const matchedSnippetId = snippet.id;
        launchingRef.current = true;
        lastTriggerMatchEndRef.current.set(matchedSnippetId, matchEnd);
        void Promise.resolve(onRunScript(snippet, sessionId))
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
    if (!chunk) return;
    const { scannableText, alternateScreenActive } = serverOutputFilterRef.current.processServerChunk(chunk);
    if (!scannableText || alternateScreenActive) {
      return;
    }
    bufferRef.current = (bufferRef.current + scannableText).slice(-8192);
    scanBuffer(scannableText);
  }, [scanBuffer]);

  const noteUserInput = useCallback((data: string) => {
    if (!data) return;
    serverOutputFilterRef.current.noteUserInput(data);
  }, []);

  useEffect(() => {
    bufferRef.current = '';
    launchingRef.current = false;
    lastTriggerMatchEndRef.current = new Map();
    serverOutputFilterRef.current.reset();
  }, [sessionId, hostId]);

  return { appendOutput, noteUserInput };
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
