export type TerminalSessionExitEvent = {
  exitCode?: number;
  signal?: number;
  error?: string;
  reason?: "exited" | "error" | "timeout" | "closed";
};

export type TerminalSessionExitIntent =
  | { kind: "closeSession" }
  | { kind: "markDisconnected" };

export function resolveTerminalSessionExitIntent(
  evt: TerminalSessionExitEvent,
): TerminalSessionExitIntent {
  if (evt.reason === "exited") {
    return { kind: "closeSession" };
  }

  // Timeouts, transport errors, and channel closes should keep the tab visible
  // so the user can inspect output and reconnect.
  return { kind: "markDisconnected" };
}

export function shouldCloseTerminalPopupOnExit(evt: TerminalSessionExitEvent): boolean {
  return evt.reason === "exited" && evt.exitCode === 0;
}
