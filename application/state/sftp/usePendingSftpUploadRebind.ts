import { useCallback, useRef, useState } from "react";

export interface PendingSftpUploadRebindBarrier {
  requestId: string;
  previousConnectionId: string | null;
  targetTabId?: string;
  targetConnectionId?: string;
}

export interface PendingSftpUploadRebindTarget {
  tabId: string;
  connectionId: string;
}

interface StartPendingSftpUploadRebindParams {
  requestId: string;
  previousConnectionId: string | null;
  connect: () => Promise<void>;
}

/**
 * Tracks the strict SFTP connect attempt owned by the latest terminal drop.
 * A later drop may share the same in-flight connect promise, so completion is
 * tracked by request generation instead of relying only on connection-id churn.
 */
export function usePendingSftpUploadRebind() {
  const startedRequestIdRef = useRef<string | null>(null);
  const barrierRef = useRef<PendingSftpUploadRebindBarrier | null>(null);
  const generationRef = useRef(0);
  const [settledRequestId, setSettledRequestId] = useState<string | null>(null);

  const start = useCallback((params: StartPendingSftpUploadRebindParams) => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    startedRequestIdRef.current = params.requestId;
    barrierRef.current = {
      requestId: params.requestId,
      previousConnectionId: params.previousConnectionId,
    };
    setSettledRequestId(null);

    const settle = () => {
      if (
        generationRef.current === generation
        && startedRequestIdRef.current === params.requestId
      ) {
        setSettledRequestId(params.requestId);
      }
    };
    void params.connect().then(settle, settle);
  }, []);

  const bindTarget = useCallback((
    requestId: string,
    target: PendingSftpUploadRebindTarget,
  ) => {
    const barrier = barrierRef.current;
    if (
      !barrier
      || barrier.requestId !== requestId
      || startedRequestIdRef.current !== requestId
    ) return;
    barrierRef.current = {
      ...barrier,
      targetTabId: target.tabId,
      targetConnectionId: target.connectionId,
    };
  }, []);

  const clearBarrier = useCallback((requestId?: string) => {
    if (requestId && barrierRef.current?.requestId !== requestId) return;
    barrierRef.current = null;
  }, []);

  const reset = useCallback(() => {
    generationRef.current += 1;
    startedRequestIdRef.current = null;
    barrierRef.current = null;
    setSettledRequestId(null);
  }, []);

  return {
    barrierRef,
    bindTarget,
    clearBarrier,
    reset,
    settledRequestId,
    start,
    startedRequestIdRef,
  };
}
