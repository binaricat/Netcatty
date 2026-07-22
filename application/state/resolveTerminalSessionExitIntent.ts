export type TerminalSessionExitEvent = {
  exitCode?: number;
  signal?: number;
  error?: string;
  reason?: "exited" | "error" | "timeout" | "closed";
};

export type TerminalSessionExitIntent =
  | { kind: "closeSession" }
  | { kind: "markDisconnected" };

type TerminalPopupExitOptions = {
  autoCloseOnExit?: boolean;
  isAttachMode?: boolean;
};

function isConfirmedCleanExit(evt: TerminalSessionExitEvent): boolean {
  return evt.reason === "exited" && evt.exitCode === 0;
}

export function resolveTerminalSessionExitIntent(
  evt: TerminalSessionExitEvent,
  autoCloseOnExit = true,
): TerminalSessionExitIntent {
  if (autoCloseOnExit && isConfirmedCleanExit(evt)) {
    return { kind: "closeSession" };
  }

  // Non-zero or unknown exits, timeouts, transport errors, and channel closes
  // should keep the tab visible so the user can inspect output and reconnect.
  return { kind: "markDisconnected" };
}

export function shouldCloseTerminalPopupOnExit(
  evt: TerminalSessionExitEvent,
  options: TerminalPopupExitOptions = {},
): boolean {
  if (options.autoCloseOnExit === false) return false;
  return options.isAttachMode === true || isConfirmedCleanExit(evt);
}

export function shouldRevealTerminalPopupOnExit(
  _evt: TerminalSessionExitEvent,
  options: TerminalPopupExitOptions = {},
): boolean {
  return options.autoCloseOnExit === false &&
    options.isAttachMode !== true;
}
