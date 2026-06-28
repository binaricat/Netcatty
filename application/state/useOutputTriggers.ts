import { useCallback, useEffect, useRef } from 'react';
import type { Snippet } from '@/domain/models';
import { isScriptSnippet } from '@/domain/snippetScript.ts';
import { createTerminalOutputTriggerFilter } from '@/domain/terminalOutputTriggerFilter.ts';
import { netcattyBridge } from '@/infrastructure/services/netcattyBridge.ts';
import { getActiveScriptRunForSession } from '@/application/state/scriptAutomationCoordinator.ts';
import {
  getOutputTriggerSkipReason,
  previewTerminalBytes,
  summarizeOnOutputSnippets,
  traceOutputTrigger,
} from '@/application/state/outputTriggerDiagnostics.ts';
import { logger } from '@/lib/logger.ts';

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

  useEffect(() => {
    const candidates = summarizeOnOutputSnippets(snippets, hostId);
    const eligible = candidates.filter((item) => item.skipReason === 'eligible');
    traceOutputTrigger('session.init', {
      sessionId,
      hostId,
      snippetCount: snippets.length,
      onOutputCandidates: candidates.length,
      eligibleCount: eligible.length,
      eligible: eligible.map((item) => ({
        id: item.id,
        label: item.label,
        pattern: item.triggerPattern,
      })),
      skipped: candidates.filter((item) => item.skipReason !== 'eligible'),
    });
  }, [hostId, sessionId, snippets]);

  const scanBuffer = useCallback((recentChunk: string) => {
    if (!recentChunk) {
      traceOutputTrigger('scan.skip', { sessionId, reason: 'empty-chunk' });
      return;
    }
    if (isSessionScriptRunActive(sessionId)) {
      traceOutputTrigger('scan.skip', {
        sessionId,
        reason: 'script-run-active',
        activeRun: getActiveScriptRunForSession(sessionId)?.runId,
      });
      return;
    }
    if (launchingRef.current) {
      traceOutputTrigger('scan.skip', { sessionId, reason: 'launching' });
      return;
    }

    const text = bufferRef.current;
    const overlap = 64;
    const chunkWithOverlap = text.slice(Math.max(0, text.length - recentChunk.length - overlap));
    const chunkStartInSlice = Math.max(0, chunkWithOverlap.length - recentChunk.length);
    const chunkBaseOffset = text.length - chunkWithOverlap.length;

    traceOutputTrigger('scan.start', {
      sessionId,
      recentPreview: previewTerminalBytes(recentChunk),
      bufferLen: text.length,
      overlapPreview: previewTerminalBytes(chunkWithOverlap, 240),
      chunkStartInSlice,
    });

    for (const snippet of snippets) {
      if (isSessionScriptRunActive(sessionId) || launchingRef.current) {
        traceOutputTrigger('scan.abort', { sessionId, snippetId: snippet.id, reason: 'script-run-or-launching' });
        return;
      }

      const skipReason = getOutputTriggerSkipReason(snippet, hostId);
      if (skipReason !== 'eligible') {
        if (snippet.trigger === 'onOutput' || isScriptSnippet(snippet)) {
          traceOutputTrigger('scan.candidate.skip', {
            sessionId,
            snippetId: snippet.id,
            label: snippet.label,
            reason: skipReason,
            kind: snippet.kind ?? 'snippet',
            trigger: snippet.trigger ?? 'manual',
            triggerPattern: snippet.triggerPattern,
            targetsAllHosts: snippet.targetsAllHosts ?? false,
            targetCount: snippet.targets?.length ?? 0,
            hostId,
          });
        }
        continue;
      }

      try {
        const matched = findMatchEndingAfter(chunkWithOverlap, snippet.triggerPattern!, chunkStartInSlice);
        if (!matched) {
          traceOutputTrigger('scan.candidate.no-match', {
            sessionId,
            snippetId: snippet.id,
            label: snippet.label,
            pattern: snippet.triggerPattern,
            chunkStartInSlice,
          });
          continue;
        }
        const matchEnd = chunkBaseOffset + matched.endOffset;
        const lastMatchEnd = lastTriggerMatchEndRef.current.get(snippet.id!) ?? -1;
        if (matchEnd <= lastMatchEnd) {
          traceOutputTrigger('scan.candidate.dedup', {
            sessionId,
            snippetId: snippet.id,
            label: snippet.label,
            match: matched.value,
            matchEnd,
            lastMatchEnd,
          });
          continue;
        }
        const matchedSnippetId = snippet.id!;
        launchingRef.current = true;
        lastTriggerMatchEndRef.current.set(matchedSnippetId, matchEnd);
        traceOutputTrigger('scan.launch', {
          sessionId,
          snippetId: matchedSnippetId,
          label: snippet.label,
          pattern: snippet.triggerPattern,
          match: matched.value,
          matchEnd,
        });
        void Promise.resolve(onRunScript(snippet, sessionId))
          .then(() => {
            traceOutputTrigger('scan.launch.ok', { sessionId, snippetId: matchedSnippetId });
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            traceOutputTrigger('scan.launch.error', { sessionId, snippetId: matchedSnippetId, message });
            logger.warn('[output-trigger] script launch failed', { sessionId, snippetId: matchedSnippetId, message });
          })
          .finally(() => {
            launchingRef.current = false;
          });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        traceOutputTrigger('scan.candidate.invalid-regex', {
          sessionId,
          snippetId: snippet.id,
          label: snippet.label,
          pattern: snippet.triggerPattern,
          message,
        });
      }
    }

    traceOutputTrigger('scan.done-no-match', { sessionId });
  }, [hostId, onRunScript, sessionId, snippets]);

  const appendOutput = useCallback((chunk: string) => {
    if (!chunk) {
      traceOutputTrigger('output.skip', { sessionId, reason: 'empty-chunk' });
      return;
    }
    traceOutputTrigger('output.raw', {
      sessionId,
      rawLen: chunk.length,
      preview: previewTerminalBytes(chunk),
    });
    const { scannableText, alternateScreenActive, meta } = serverOutputFilterRef.current.processServerChunk(chunk);
    traceOutputTrigger('output.filtered', {
      sessionId,
      alternateScreenActive,
      meta,
      scannablePreview: previewTerminalBytes(scannableText),
    });
    if (!scannableText) {
      traceOutputTrigger('output.skip', {
        sessionId,
        reason: meta.dropReason ?? 'empty-scannable',
        alternateScreenActive,
      });
      return;
    }
    if (alternateScreenActive) {
      traceOutputTrigger('output.skip', { sessionId, reason: 'alternate-screen-active' });
      return;
    }
    bufferRef.current = (bufferRef.current + scannableText).slice(-8192);
    scanBuffer(scannableText);
  }, [scanBuffer, sessionId]);

  const noteUserInput = useCallback((data: string) => {
    if (!data) return;
    serverOutputFilterRef.current.noteUserInput(data);
    traceOutputTrigger('input.note', {
      sessionId,
      bytes: data.length,
      preview: previewTerminalBytes(data),
    });
  }, [sessionId]);

  useEffect(() => {
    bufferRef.current = '';
    launchingRef.current = false;
    lastTriggerMatchEndRef.current = new Map();
    serverOutputFilterRef.current.reset();
    traceOutputTrigger('session.reset', { sessionId, hostId });
  }, [hostId, sessionId]);

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
