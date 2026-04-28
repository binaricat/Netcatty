type QueryTarget = {
  querySelector: (selector: string) => QueryTarget | FocusableTarget | null;
};

type FocusableTarget = {
  focus?: () => void;
};

interface FocusTerminalSessionInputOptions {
  document?: QueryTarget | null;
  requestAnimationFrame?: (callback: () => void) => unknown;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  retryDelays?: readonly number[];
}

const escapeAttributeValue = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export const focusTerminalSessionInput = (
  sessionId: string | null | undefined,
  options: FocusTerminalSessionInputOptions = {},
): void => {
  if (!sessionId) return;

  const doc = options.document ?? (typeof document !== "undefined" ? document : null);
  if (!doc) return;

  const raf = options.requestAnimationFrame
    ?? (typeof requestAnimationFrame !== "undefined"
      ? requestAnimationFrame
      : (callback: () => void) => {
        callback();
        return undefined;
      });
  const scheduleTimeout = options.setTimeout
    ?? (typeof setTimeout !== "undefined"
      ? setTimeout
      : (callback: () => void) => {
        callback();
        return undefined;
      });
  const retryDelays = options.retryDelays ?? [50];
  const paneSelector = `[data-session-id="${escapeAttributeValue(sessionId)}"]`;

  const focusTarget = () => {
    const pane = doc.querySelector(paneSelector) as QueryTarget | null;
    const textarea = pane?.querySelector("textarea.xterm-helper-textarea") as FocusableTarget | null;
    textarea?.focus?.();
  };

  raf(() => {
    focusTarget();
    retryDelays.forEach((delay) => {
      scheduleTimeout(focusTarget, delay);
    });
  });
};
