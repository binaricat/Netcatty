import type { TerminalSession } from "../../domain/models";

export type TerminalReconnectMode = "restored" | "manual" | "automatic";

export const getInitialTerminalStatus = (): TerminalSession["status"] => (
  "connecting"
);

export const shouldStartTerminalBackend = (): boolean => true;

export const shouldSuppressHostStartupCommandOnReconnect = (
  mode: TerminalReconnectMode,
): boolean => mode === "automatic";
