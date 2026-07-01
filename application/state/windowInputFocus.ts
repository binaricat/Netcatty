import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";

export const requestWindowInputFocus = (): void => {
  try {
    const result = netcattyBridge.get()?.windowFocus?.();
    void result?.catch?.(() => undefined);
  } catch {
    // Browser preview or a disposed Electron bridge.
  }
};

export type ScheduledWindowInputFocus = {
  cancel: () => void;
};

export const scheduleWindowInputFocus = (): ScheduledWindowInputFocus => {
  let cancelled = false;
  let frameId: number | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    cancelled = true;
    if (frameId !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frameId);
      frameId = undefined;
    }
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  };

  const runIfVisible = () => {
    if (cancelled || document.visibilityState !== "visible") return;
    requestWindowInputFocus();
  };

  const scheduleFrame: (callback: FrameRequestCallback) => number =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (callback) => {
        callback(0);
        return 0;
      };

  frameId = scheduleFrame(() => {
    frameId = undefined;
    runIfVisible();
    if (cancelled) return;
    timeoutId = setTimeout(() => {
      timeoutId = undefined;
      runIfVisible();
    }, 50);
  });

  return { cancel };
};
