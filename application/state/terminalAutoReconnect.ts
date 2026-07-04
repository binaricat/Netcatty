import type { TerminalSettings } from "../../domain/models";
import type { TerminalSessionExitEvent } from "./resolveTerminalSessionExitIntent";

export const TERMINAL_AUTO_RECONNECT_DELAY_MS = 5000;

type AutoReconnectHost = {
  protocol?: "ssh" | "telnet" | "local" | "serial" | "mosh" | "et";
  hostname?: string;
  moshEnabled?: boolean;
  etEnabled?: boolean;
};

type AutoReconnectSettings = Pick<TerminalSettings, "sshAutoReconnectEnabled"> | undefined | null;

export function isTerminalAutoReconnectEnabled(settings: AutoReconnectSettings): boolean {
  return settings?.sshAutoReconnectEnabled === true;
}

export function isAutoReconnectableSshHost(host: AutoReconnectHost): boolean {
  const protocol = host.protocol ?? "ssh";
  return (
    protocol === "ssh" &&
    host.hostname !== "localhost" &&
    host.moshEnabled !== true &&
    host.etEnabled !== true
  );
}

export function shouldAutoReconnectAfterExit({
  evt,
  host,
  terminalSettings,
  hasEverConnected,
}: {
  evt: TerminalSessionExitEvent;
  host: AutoReconnectHost;
  terminalSettings?: AutoReconnectSettings;
  hasEverConnected: boolean;
}): boolean {
  if (!hasEverConnected) return false;
  if (!isTerminalAutoReconnectEnabled(terminalSettings)) return false;
  if (!isAutoReconnectableSshHost(host)) return false;
  return evt.reason !== "exited";
}

export function shouldContinueAutoReconnectAfterFailure({
  host,
  terminalSettings,
  loopActive,
}: {
  host: AutoReconnectHost;
  terminalSettings?: AutoReconnectSettings;
  loopActive: boolean;
}): boolean {
  return loopActive && isTerminalAutoReconnectEnabled(terminalSettings) && isAutoReconnectableSshHost(host);
}

export function canAttemptTerminalAutoReconnect({
  hasTerminalRuntime,
  isHibernated,
}: {
  hasTerminalRuntime: boolean;
  isHibernated: boolean;
}): boolean {
  return hasTerminalRuntime || isHibernated;
}
