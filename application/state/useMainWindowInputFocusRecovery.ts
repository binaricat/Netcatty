import { useEffect } from "react";

import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import { scheduleWindowInputFocus } from "./windowInputFocus";

export type MainWindowInputFocusRecoveryOptions = {
  /** Close transient overlays before the window hides (#1722). */
  onPageHidden?: () => void;
};

/**
 * Recover OS/renderer input focus when the main window returns from hide,
 * another app, or a virtual desktop (#760, #1714, #1722).
 */
export function useMainWindowInputFocusRecovery(
  options: MainWindowInputFocusRecoveryOptions = {},
): void {
  const { onPageHidden } = options;

  useEffect(() => {
    const recoverFocus = () => {
      if (document.visibilityState !== "visible") return;
      scheduleWindowInputFocus();
    };

    const dismissTransientUi = () => {
      onPageHidden?.();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        dismissTransientUi();
        return;
      }
      recoverFocus();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", recoverFocus);

    const bridge = netcattyBridge.get();
    const unsubscribeShown = bridge?.onWindowShown?.(() => {
      recoverFocus();
    });
    const unsubscribeWillHide = bridge?.onWindowWillHide?.(() => {
      dismissTransientUi();
    });

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", recoverFocus);
      unsubscribeShown?.();
      unsubscribeWillHide?.();
    };
  }, [onPageHidden]);
}
