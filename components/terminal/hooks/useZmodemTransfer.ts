import { useCallback, useEffect, useRef, useState } from 'react';
import { netcattyBridge } from '../../../infrastructure/services/netcattyBridge';

export interface ZmodemTransferState {
  active: boolean;
  transferType: 'upload' | 'download' | null;
  filename: string | null;
  transferred: number;
  total: number;
  fileIndex: number;
  fileCount: number;
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
  error: null,
};

export function useZmodemTransfer(sessionId: string | null) {
  const [state, setState] = useState<ZmodemTransferState>(initialState);
  const disposeRef = useRef<(() => void) | null>(null);

  const disposeExitRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!sessionId) return;

    const bridge = netcattyBridge.get();
    if (!bridge?.onZmodemEvent) return;

    disposeRef.current = bridge.onZmodemEvent(sessionId, (event) => {
      switch (event.type) {
        case 'detect':
          setState({
            active: true,
            transferType: event.transferType ?? null,
            filename: null,
            transferred: 0,
            total: 0,
            fileIndex: 0,
            fileCount: 0,
            error: null,
          });
          break;
        case 'progress':
          setState((prev) => ({
            ...prev,
            active: true,
            transferType: event.transferType ?? prev.transferType,
            filename: event.filename ?? prev.filename,
            transferred: event.transferred ?? prev.transferred,
            total: event.total ?? prev.total,
            fileIndex: event.fileIndex ?? prev.fileIndex,
            fileCount: event.fileCount ?? prev.fileCount,
          }));
          break;
        case 'complete':
          setState((prev) => ({ ...prev, active: false }));
          break;
        case 'error':
          setState((prev) => ({
            ...prev,
            active: false,
            error: event.error ?? 'Unknown error',
          }));
          break;
      }
    });

    // If the session exits mid-transfer (disconnect, shell exit, etc.),
    // reset state so the progress indicator doesn't stay stuck.
    disposeExitRef.current = bridge.onSessionExit(sessionId, () => {
      setState(initialState);
    });

    return () => {
      disposeRef.current?.();
      disposeRef.current = null;
      disposeExitRef.current?.();
      disposeExitRef.current = null;
      setState(initialState);
    };
  }, [sessionId]);

  const cancel = useCallback(() => {
    if (!sessionId) return;
    const bridge = netcattyBridge.get();
    bridge?.cancelZmodem?.(sessionId);
  }, [sessionId]);

  return { ...state, cancel };
}
