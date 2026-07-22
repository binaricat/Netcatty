import { useCallback } from 'react';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import type { TerminalPopupPayload } from '../../domain/systemManager/types';

export function useTerminalPopupWindow() {
  const close = useCallback(async () => {
    await netcattyBridge.get()?.windowClose?.();
  }, []);

  const setWindowTitle = useCallback(async (title: string) => {
    await netcattyBridge.get()?.setWindowTitle?.(title);
  }, []);

  const onPopupConfig = useCallback((cb: (payload: TerminalPopupPayload) => void) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onTerminalPopupConfig) return () => {};
    return bridge.onTerminalPopupConfig(cb);
  }, []);

  const markAttachClosePrepared = useCallback(async (sessionId: string, authorization: string) => {
    return netcattyBridge.get()?.markAttachPopupClosePrepared?.(sessionId, authorization);
  }, []);

  const onPrepareClose = useCallback((cb: (payload: { sessionId: string; authorization: string }) => void) => {
    return netcattyBridge.get()?.onTerminalPopupPrepareClose?.(cb) ?? (() => {});
  }, []);

  return { close, setWindowTitle, onPopupConfig, markAttachClosePrepared, onPrepareClose };
}
