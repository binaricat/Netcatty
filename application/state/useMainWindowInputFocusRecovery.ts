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

type Listener = () => void;

type MainWindowInputFocusRecoveryDocument = {
  visibilityState: DocumentVisibilityState;
  addEventListener: (eventName: "visibilitychange", listener: Listener) => void;
  removeEventListener: (eventName: "visibilitychange", listener: Listener) => void;
};

type MainWindowInputFocusRecoveryWindow = {
  addEventListener: (eventName: "focus", listener: Listener) => void;
  removeEventListener: (eventName: "focus", listener: Listener) => void;
};

type MainWindowInputFocusRecoveryBridge = {
  onWindowShown?: (callback: Listener) => Listener;
  onWindowFocusRequested?: (callback: Listener) => Listener;
  onWindowWillHide?: (callback: Listener) => Listener;
};

export type MainWindowInputFocusRecoveryDependencies = {
  documentRef: MainWindowInputFocusRecoveryDocument;
  windowRef?: MainWindowInputFocusRecoveryWindow;
  bridge?: MainWindowInputFocusRecoveryBridge;
  scheduleFocus?: () => ScheduledWindowInputFocus;
};

export function startMainWindowInputFocusRecovery(
  options: MainWindowInputFocusRecoveryOptions = {},
  dependencies: MainWindowInputFocusRecoveryDependencies = {
    documentRef: document,
    windowRef: window,
    bridge: netcattyBridge.get(),
    scheduleFocus: scheduleWindowInputFocus,
  },
): () => void {
  const { onPageHidden } = options;
  const {
    documentRef,
    bridge,
    scheduleFocus = scheduleWindowInputFocus,
  } = dependencies;

  let pendingFocusRecovery: ScheduledWindowInputFocus | null = null;
  let pendingExplicitFocusRecovery = false;

  const cancelPendingFocusRecovery = () => {
    pendingFocusRecovery?.cancel();
    pendingFocusRecovery = null;
  };

  const recoverFocus = (): boolean => {
    if (documentRef.visibilityState !== "visible") return false;
    pendingExplicitFocusRecovery = false;
    cancelPendingFocusRecovery();
    pendingFocusRecovery = scheduleFocus();
    return true;
  };

  const dismissTransientUi = () => {
    pendingExplicitFocusRecovery = false;
    cancelPendingFocusRecovery();
    onPageHidden?.();
  };

  const onVisibilityChange = () => {
    if (documentRef.visibilityState === "hidden") {
      dismissTransientUi();
      return;
    }
    if (pendingExplicitFocusRecovery) {
      recoverFocus();
    }
  };

  documentRef.addEventListener("visibilitychange", onVisibilityChange);

  const unsubscribeFocusRequested = bridge?.onWindowFocusRequested?.(() => {
    pendingExplicitFocusRecovery = true;
    recoverFocus();
  });
  const unsubscribeWillHide = bridge?.onWindowWillHide?.(() => {
    dismissTransientUi();
  });

  return () => {
    pendingExplicitFocusRecovery = false;
    cancelPendingFocusRecovery();
    documentRef.removeEventListener("visibilitychange", onVisibilityChange);
    unsubscribeFocusRequested?.();
    unsubscribeWillHide?.();
  };
}

/**
 * Recover OS/renderer input focus when the main process explicitly foregrounds the
 * main window (#760, #1714, #1722).
 */
export function useMainWindowInputFocusRecovery(
  options: MainWindowInputFocusRecoveryOptions = {},
): void {
  const { onPageHidden } = options;

  useEffect(() => {
    return startMainWindowInputFocusRecovery({ onPageHidden });
  }, [onPageHidden]);
}
