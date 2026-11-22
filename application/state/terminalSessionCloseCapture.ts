import { useEffect, type RefObject } from 'react';
import { logger } from '../../lib/logger';

const closeCaptures = new Map<string, Set<() => void>>();

/** Notify owning terminals before explicit session removal, never on runtime cleanup. */
export function captureClosingTerminalSessions(sessionIds: readonly string[]): void {
  for (const sessionId of new Set(sessionIds)) {
    for (const capture of closeCaptures.get(sessionId) ?? []) capture();
  }
}

export function useTerminalSessionCloseCapture({
  sessionId,
  enabled,
  hasConnectedRef,
  terminalDataCapturedRef,
  finalizeTerminalLogData,
  onTerminalDataCapture,
}: {
  sessionId: string;
  enabled: boolean;
  hasConnectedRef: RefObject<boolean>;
  terminalDataCapturedRef: RefObject<boolean>;
  finalizeTerminalLogData: () => string;
  onTerminalDataCapture: (
    sessionId: string,
    data: string,
    options: { finalized: true },
  ) => void | Promise<void>;
}): void {
  useEffect(() => {
    if (!enabled) return;
    const capture = () => {
      // Connected terminals retain their existing drain/serialize close path.
      if (hasConnectedRef.current || terminalDataCapturedRef.current) return;
      try {
        // A never-connected runtime is disposed synchronously on unmount.
        // Finish its log now, even if empty, so persistence can set endTime.
        void Promise.resolve(onTerminalDataCapture(
          sessionId, finalizeTerminalLogData(), { finalized: true },
        )).catch((err: unknown) => {
          logger.warn('Failed to capture terminal log on session close', err);
        });
      } catch (err) {
        logger.warn('Failed to capture terminal log on session close', err);
      }
    };
    const captures = closeCaptures.get(sessionId) ?? new Set<() => void>();
    closeCaptures.set(sessionId, captures);
    captures.add(capture);
    return () => {
      captures.delete(capture);
      if (!captures.size) closeCaptures.delete(sessionId);
    };
  }, [sessionId, enabled, hasConnectedRef, terminalDataCapturedRef, finalizeTerminalLogData, onTerminalDataCapture]);
}
