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

  return { close, setWindowTitle, onPopupConfig };
}
