import { useCallback, useEffect, useRef, useState } from 'react';
import { netcattyBridge } from '../../../infrastructure/services/netcattyBridge';

export interface ZmodemTransferEvent {
  type: 'detect' | 'progress' | 'complete' | 'error';
  sessionId: string;
  transferType?: 'upload' | 'download';
  filename?: string;
  transferred?: number;
  total?: number;
  fileIndex?: number;
  fileCount?: number;
  finalizing?: boolean;
  error?: string;
}

export interface ZmodemTransferState {
  active: boolean;
  transferType: 'upload' | 'download' | null;
  filename: string | null;
  transferred: number;
  total: number;
  fileIndex: number;
  fileCount: number;
  finalizing: boolean;
  completed: boolean;
  startedAt: number | null;
  updatedAt: number | null;
  bytesPerSecond: number | null;
  error: string | null;
}

const initialState: ZmodemTransferState = {
  active: false,
  transferType: null,
  filename: null,
  transferred: 0,
  total: 0,
  fileIndex: 0,
  fileCount: 0,
  finalizing: false,
  completed: false,
  startedAt: null,
  updatedAt: null,
  bytesPerSecond: null,
  error: null,
};

export function reduceZmodemTransferState(
  prev: ZmodemTransferState,
  event: ZmodemTransferEvent,
  now: number = Date.now(),
): ZmodemTransferState {
  switch (event.type) {
    case 'detect':
      return {
        ...initialState,
        active: true,
        transferType: event.transferType ?? null,
        startedAt: now,
        updatedAt: now,
      };
    case 'progress': {
      const transferred = event.transferred ?? prev.transferred;
      const fileChanged = (
        prev.filename !== null
        && (
          (typeof event.fileIndex === 'number' && event.fileIndex !== prev.fileIndex)
          || (typeof event.filename === 'string' && event.filename !== prev.filename)
        )
      );
      const previousUpdatedAt = fileChanged ? now : (prev.updatedAt ?? now);
      const elapsedSeconds = Math.max((now - previousUpdatedAt) / 1000, 0);
      const deltaBytes = Math.max(transferred - prev.transferred, 0);
      const bytesPerSecond = elapsedSeconds > 0 && deltaBytes > 0
        ? deltaBytes / elapsedSeconds
        : fileChanged
          ? null
          : prev.bytesPerSecond;

      return {
        ...prev,
        active: true,
        transferType: event.transferType ?? prev.transferType,
        filename: event.filename ?? prev.filename,
        transferred,
        total: event.total ?? prev.total,
        fileIndex: event.fileIndex ?? prev.fileIndex,
        fileCount: event.fileCount ?? prev.fileCount,
        finalizing: !!event.finalizing,
        completed: false,
        startedAt: prev.startedAt ?? now,
        updatedAt: now,
        bytesPerSecond,
        error: null,
      };
    }
    case 'complete':
      return {
        ...prev,
        active: false,
        finalizing: false,
        completed: true,
        updatedAt: now,
      };
    case 'error':
      return {
        ...prev,
        active: false,
        finalizing: false,
        completed: false,
        updatedAt: now,
        error: event.error ?? 'Unknown error',
      };
  }
}

export function useZmodemTransfer(sessionId: string | null) {
  const [state, setState] = useState<ZmodemTransferState>(initialState);
  const [overwriteRequest, setOverwriteRequest] = useState<{ requestId: string; filename: string } | null>(null);
  const disposeRef = useRef<(() => void) | null>(null);

  const disposeExitRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!sessionId) return;

    const bridge = netcattyBridge.get();
    if (!bridge?.onZmodemEvent) return;

    disposeRef.current = bridge.onZmodemEvent(sessionId, (event) => {
      setState((prev) => reduceZmodemTransferState(prev, event));
    });

    const disposeOverwrite = bridge.onZmodemOverwriteRequest?.(sessionId, (payload) => {
      setOverwriteRequest({ requestId: payload.requestId, filename: payload.filename });
    });

    // If the session exits mid-transfer (disconnect, shell exit, etc.),
    // reset state so the progress indicator doesn't stay stuck.
    disposeExitRef.current = bridge.onSessionExit(sessionId, () => {
      setState(initialState);
    });

    return () => {
      disposeRef.current?.();
      disposeRef.current = null;
      disposeOverwrite?.();
      disposeExitRef.current?.();
      disposeExitRef.current = null;
      setState(initialState);
      setOverwriteRequest(null);
    };
  }, [sessionId]);

  const cancel = useCallback(() => {
    if (!sessionId) return;
    const bridge = netcattyBridge.get();
    bridge?.cancelZmodem?.(sessionId);
  }, [sessionId]);

  const respondOverwrite = useCallback((action: "overwrite" | "skip" | "cancel", applyToRest: boolean) => {
    setOverwriteRequest((req) => {
      if (req) netcattyBridge.get()?.respondZmodemOverwrite?.({ requestId: req.requestId, action, applyToRest });
      return null;
    });
  }, []);

  return { ...state, cancel, overwriteRequest, respondOverwrite };
}
