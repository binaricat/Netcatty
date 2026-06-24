import type { TmuxManageAction } from '../../domain/systemManager/types';

type TmuxActionResult = {
  success: boolean;
  error?: string;
};

type TmuxActionPayload = { sessionId: string } & TmuxManageAction;

interface RunTmuxSessionActionOptions {
  sessionId: string;
  action: TmuxManageAction;
  tmuxAction: (payload: TmuxActionPayload) => Promise<TmuxActionResult>;
  onRefreshDetails?: () => Promise<void>;
  onSessionsChanged: () => Promise<void>;
  onRequestTerminalFocus?: () => void;
}

const shouldRequestTerminalFocusAfterAction = (action: TmuxManageAction): boolean =>
  action.action === 'detachSession';

const DEFERRED_TERMINAL_FOCUS_DELAYS_MS = [0, 50, 150] as const;

export function scheduleDeferredTerminalFocus(onRequestTerminalFocus?: () => void): void {
  if (!onRequestTerminalFocus) return;

  const run = () => onRequestTerminalFocus();
  const schedule = typeof globalThis.setTimeout === 'function'
    ? globalThis.setTimeout.bind(globalThis)
    : (callback: () => void) => {
      callback();
      return 0;
    };
  const raf = typeof globalThis.requestAnimationFrame === 'function'
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : (callback: () => void) => {
      callback();
      return 0;
    };

  raf(() => {
    for (const delayMs of DEFERRED_TERMINAL_FOCUS_DELAYS_MS) {
      schedule(run, delayMs);
    }
  });
}

export async function runTmuxSessionAction({
  sessionId,
  action,
  tmuxAction,
  onRefreshDetails,
  onSessionsChanged,
  onRequestTerminalFocus,
}: RunTmuxSessionActionOptions): Promise<TmuxActionResult> {
  const result = await tmuxAction({ sessionId, ...action });
  if (!result.success) return result;

  try {
    await onRefreshDetails?.();
    await onSessionsChanged();
  } finally {
    if (shouldRequestTerminalFocusAfterAction(action)) {
      scheduleDeferredTerminalFocus(onRequestTerminalFocus);
    }
  }

  return result;
}
