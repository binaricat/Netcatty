import type { TerminalSession } from "../../domain/models";

export const getInitialTerminalStatus = (): TerminalSession["status"] => (
  "connecting"
);

export const shouldStartTerminalBackend = (): boolean => true;
