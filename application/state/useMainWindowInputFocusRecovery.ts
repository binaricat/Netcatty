import { useEffect } from "react";

import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import {
  scheduleWindowInputFocus,
  type ScheduledWindowInputFocus,
} from "./windowInputFocus";

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
    let pendingFocusRecovery: ScheduledWindowInputFocus | null = null;

    const cancelPendingFocusRecovery = () => {
      pendingFocusRecovery?.cancel();
      pendingFocusRecovery = null;
    };

    const recoverFocus = () => {
      if (document.visibilityState !== "visible") return;
      cancelPendingFocusRecovery();
      pendingFocusRecovery = scheduleWindowInputFocus();
    };

    const dismissTransientUi = () => {
      cancelPendingFocusRecovery();
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
      cancelPendingFocusRecovery();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", recoverFocus);
      unsubscribeShown?.();
      unsubscribeWillHide?.();
    };
  }, [onPageHidden]);
}
