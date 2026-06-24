type QueryRoot = {
  querySelector: (selector: string) => unknown | null;
};

type QueryTarget = QueryRoot & {
  querySelector: (selector: string) => QueryTarget | FocusableTarget | null;
};

type FocusableTarget = {
  focus?: () => void;
};

/** Skip terminal refocus while a Radix dialog is open so deferred tmux actions do not steal modal focus. */
export const hasOpenAppDialog = (
  doc: QueryRoot | null = typeof document !== "undefined" ? document : null,
): boolean => {
  if (!doc) return false;
  return doc.querySelector('[role="dialog"][data-state="open"]') !== null;
};

interface FocusTerminalSessionInputOptions {
  document?: QueryTarget | null;
  requestAnimationFrame?: (callback: () => void) => unknown;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  retryDelays?: readonly number[];
}

const escapeAttributeValue = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export const TERMINAL_SESSION_RESTORE_FOCUS_EVENT = "netcatty:terminal-session-restore-focus";

export type TerminalSessionRestoreFocusDetail = {
  sessionId: string;
};

const dispatchTerminalSessionRestoreFocus = (sessionId: string): void => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<TerminalSessionRestoreFocusDetail>(
    TERMINAL_SESSION_RESTORE_FOCUS_EVENT,
    { detail: { sessionId } },
  ));
};

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
    if (hasOpenAppDialog(doc)) {
      dispatchTerminalSessionRestoreFocus(sessionId);
      return;
    }

    const pane = doc.querySelector(paneSelector) as QueryTarget | null;
    const textarea = pane?.querySelector("textarea.xterm-helper-textarea") as FocusableTarget | null;
    textarea?.focus?.();
    dispatchTerminalSessionRestoreFocus(sessionId);
  };

  raf(() => {
    focusTarget();
    retryDelays.forEach((delay) => {
      scheduleTimeout(focusTarget, delay);
    });
  });
};
