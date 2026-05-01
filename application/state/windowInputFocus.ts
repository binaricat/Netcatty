import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";

export const requestWindowInputFocus = (): void => {
  try {
    const result = netcattyBridge.get()?.windowFocus?.();
    void result?.catch?.(() => undefined);
  } catch {
    // Browser preview or a disposed Electron bridge.
  }
};

export const scheduleWindowInputFocus = (): void => {
  const scheduleFrame: (callback: () => void) => unknown =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (callback) => {
        callback();
        return undefined;
      };

  scheduleFrame(() => {
    requestWindowInputFocus();
    setTimeout(requestWindowInputFocus, 50);
  });
};
