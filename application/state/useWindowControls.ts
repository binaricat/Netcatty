import { useCallback } from "react";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";

export function subscribeWindowFullscreenChanged(
  cb: (isFullscreen: boolean) => void,
): () => void {
  try {
    return netcattyBridge.get()?.onWindowFullScreenChanged?.(cb) ?? (() => {});
  } catch {
    return () => {};
  }
}

export const useWindowControls = () => {
  const notifyRendererReady = useCallback(() => {
    try {
      netcattyBridge.get()?.rendererReady?.();
    } catch {
      // ignore
    }
  }, []);

  const closeSettingsWindow = useCallback(async () => {
    const bridge = netcattyBridge.get();
    await bridge?.closeSettingsWindow?.();
  }, []);

  const openSettingsWindow = useCallback(async () => {
    const bridge = netcattyBridge.get();
    return bridge?.openSettingsWindow?.();
  }, []);

  const minimize = useCallback(async () => {
    const bridge = netcattyBridge.get();
    await bridge?.windowMinimize?.();
  }, []);

  const maximize = useCallback(async () => {
    const bridge = netcattyBridge.get();
    return bridge?.windowMaximize?.();
  }, []);

  const close = useCallback(async () => {
    const bridge = netcattyBridge.get();
    await bridge?.windowClose?.();
  }, []);

  const isMaximized = useCallback(async () => {
    const bridge = netcattyBridge.get();
    return bridge?.windowIsMaximized?.();
  }, []);

  const isFullscreen = useCallback(async () => {
    const bridge = netcattyBridge.get();
    return bridge?.windowIsFullscreen?.() ?? false;
  }, []);

  const onFullscreenChanged = useCallback(subscribeWindowFullscreenChanged, []);

  const onWindowCommandCloseRequested = useCallback((cb: () => void) => {
    const bridge = netcattyBridge.get();
    return bridge?.onWindowCommandCloseRequested?.(cb) ?? (() => {});
  }, []);

  return {
    notifyRendererReady,
    closeSettingsWindow,
    openSettingsWindow,
    minimize,
    maximize,
    close,
    isMaximized,
    isFullscreen,
    onFullscreenChanged,
    onWindowCommandCloseRequested,
  };
};
