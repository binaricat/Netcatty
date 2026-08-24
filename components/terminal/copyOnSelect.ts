/**
 * Copy-on-select policy for the xterm selection overlay.
 *
 * SearchAddon (and other programmatic paths) call terminal.select() to mark
 * the active match. Those selection-change events must not write the
 * clipboard — otherwise a later user selection is overwritten by the search
 * term after a resize/write revival (issue #3007).
 */

export const COPY_ON_SELECT_USER_GESTURE_RELEASE_MS = 80;

export type CopyOnSelectUserGestureTracker = {
  mark: () => void;
  release: () => void;
  /** Mark then release — one-shot gestures such as a late contextmenu. */
  pulse: () => void;
  isActive: () => boolean;
  dispose: () => void;
};

export const createCopyOnSelectUserGestureTracker = ({
  releaseDelayMs = COPY_ON_SELECT_USER_GESTURE_RELEASE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}: {
  releaseDelayMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
} = {}): CopyOnSelectUserGestureTracker => {
  let active = false;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;

  const clearReleaseTimer = () => {
    if (releaseTimer === null) return;
    clearTimeoutFn(releaseTimer);
    releaseTimer = null;
  };

  const mark = () => {
    clearReleaseTimer();
    active = true;
  };

  const release = () => {
    clearReleaseTimer();
    releaseTimer = setTimeoutFn(() => {
      releaseTimer = null;
      active = false;
    }, releaseDelayMs);
  };

  const pulse = () => {
    mark();
    release();
  };

  const dispose = () => {
    clearReleaseTimer();
    active = false;
  };

  return {
    mark,
    release,
    pulse,
    isActive: () => active,
    dispose,
  };
};

const CAPTURE = { capture: true } as const;

const eventIsInsideTerminal = (
  event: Event,
  el: EventTarget,
): boolean => {
  const target = event.target;
  if (!target) return false;
  if (target === el) return true;
  const host = el as { contains?: (node: EventTarget) => boolean };
  return typeof host.contains === "function" && host.contains(target);
};

export const subscribeCopyOnSelectUserGesture = (
  term: { element?: EventTarget | null } | null | undefined,
  tracker: Pick<CopyOnSelectUserGestureTracker, "mark" | "release" | "pulse">,
  root: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null = (
    typeof document === "undefined" ? null : document
  ),
  view: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null = (
    typeof window === "undefined" ? null : window
  ),
): (() => void) => {
  const el = term?.element;
  if (!el || !root) return () => {};

  const onPointerDown = (event: Event) => {
    if (!eventIsInsideTerminal(event, el)) return;
    tracker.mark();
  };
  const onContextMenu = (event: Event) => {
    if (!eventIsInsideTerminal(event, el)) return;
    // Capture on the document so we still see right-clicks that
    // useTerminalEffects intercepts with stopImmediatePropagation
    // (tmux/vim mouse tracking + select-word). Pulse so a late
    // contextmenu after mouseup cannot leave the tracker armed.
    tracker.pulse();
  };
  const onPointerUp = () => tracker.release();

  root.addEventListener("mousedown", onPointerDown, CAPTURE);
  root.addEventListener("touchstart", onPointerDown, CAPTURE);
  root.addEventListener("contextmenu", onContextMenu, CAPTURE);
  root.addEventListener("mouseup", onPointerUp);
  root.addEventListener("touchend", onPointerUp);
  root.addEventListener("touchcancel", onPointerUp);
  // Alt-tab / window blur drops the matching mouseup in Electron.
  view?.addEventListener("blur", onPointerUp);

  return () => {
    root.removeEventListener("mousedown", onPointerDown, CAPTURE);
    root.removeEventListener("touchstart", onPointerDown, CAPTURE);
    root.removeEventListener("contextmenu", onContextMenu, CAPTURE);
    root.removeEventListener("mouseup", onPointerUp);
    root.removeEventListener("touchend", onPointerUp);
    root.removeEventListener("touchcancel", onPointerUp);
    view?.removeEventListener("blur", onPointerUp);
  };
};

const userCommandPulses = new Map<unknown, () => void>();

/** Select All / Select Word from a shortcut or menu — not SearchAddon. */
export const subscribeCopyOnSelectUserCommand = (
  key: unknown,
  pulse: () => void,
): (() => void) => {
  userCommandPulses.set(key, pulse);
  return () => {
    if (userCommandPulses.get(key) === pulse) {
      userCommandPulses.delete(key);
    }
  };
};

export const pulseCopyOnSelectUserCommand = (key: unknown): void => {
  userCommandPulses.get(key)?.();
};

export const shouldWriteCopyOnSelect = ({
  allowCopy = true,
  hasText,
  copyOnSelect,
  isRestoringSelection,
  isUserSelection,
}: {
  allowCopy?: boolean;
  hasText: boolean;
  copyOnSelect: boolean;
  isRestoringSelection: boolean;
  isUserSelection: boolean;
}): boolean => (
  allowCopy
  && hasText
  && copyOnSelect
  && !isRestoringSelection
  && isUserSelection
);
